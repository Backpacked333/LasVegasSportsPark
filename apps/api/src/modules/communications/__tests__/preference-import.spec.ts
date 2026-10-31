import { importActorLabel, newId, systemPrincipal } from '@sportspark/contracts';
import { isCheckViolation, json, pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { CommunicationPreferencesService } from '../index';
import { attemptsOf, composeAndDispatch } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;

/**
 * COM-04: communication preference import (§5.3 "communication preferences", §5.4 import
 * provenance, SPK-AT-024, SPK-COMMS-007; IF-40). Only the batch's migration import principal
 * writes; create-if-absent by record id; a person's own choice always wins; the mandatory
 * operational in-app notice stays mandatory whatever is imported.
 */
describe('communication preference import (COM-04, IF-40)', () => {
  let t: TestApp;
  let org: string;
  let service: CommunicationPreferencesService;

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    service = t.app.get(CommunicationPreferencesService);
  });
  afterAll(async () => {
    await t.close();
  });

  const importer = (batchId: string) => systemPrincipal(org, importActorLabel(batchId));
  const provenance = (batchId: string, recordId = newId()) => ({
    batchId,
    externalKey: `legacy-prefs-${recordId}`,
    recordId,
  });
  const stored = (personId: string) =>
    t.db
      .selectFrom('communication_preferences')
      .select(['channel', 'category', 'enabled', 'source', 'revision'])
      .where('organization_id', '=', org)
      .where('person_id', '=', personId)
      .orderBy('category')
      .orderBy('channel')
      .execute();

  it('SPK-AT-024: importing preferences twice writes once', async () => {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    const batchId = newId();
    const record = provenance(batchId);
    const input = {
      importProvenance: record,
      personId,
      preferences: [
        { channel: 'email' as const, category: 'promotional' as const, enabled: false },
        { channel: 'sms' as const, category: 'operational' as const, enabled: true },
      ],
    };
    const first = await service.importPreferences(importer(batchId), input);
    expect(first).toMatchObject({ recordId: record.recordId, created: true });
    expect(first.applied).toHaveLength(2);
    const afterFirst = await stored(personId);
    expect(afterFirst).toEqual([
      { channel: 'sms', category: 'operational', enabled: true, source: 'import', revision: 1 },
      { channel: 'email', category: 'promotional', enabled: false, source: 'import', revision: 1 },
    ]);
    // the same record again (preferences in another order): the first outcome, nothing written
    const second = await service.importPreferences(importer(batchId), {
      ...input,
      preferences: [...input.preferences].reverse(),
    });
    expect(second).toMatchObject({ recordId: record.recordId, created: false });
    expect(second.applied).toEqual(first.applied);
    expect(await stored(personId)).toEqual(afterFirst);
    const records = await t.db
      .selectFrom('communication_preference_imports')
      .select('id')
      .where('id', '=', record.recordId)
      .execute();
    expect(records).toHaveLength(1);
    const audits = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'communications.import_preferences')
      .where('target_id', '=', personId)
      .execute();
    expect(audits).toHaveLength(1);

    // the same record id with different content is refused
    await expect(
      service.importPreferences(importer(batchId), {
        ...input,
        preferences: [{ channel: 'email', category: 'promotional', enabled: true }],
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'IMPORT_CONTENT_MISMATCH' },
    });
    // only the batch's own import principal may import
    await expect(
      service.importPreferences(importer(newId()), {
        ...input,
        importProvenance: provenance(batchId),
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const staff = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    await expect(
      service.importPreferences(
        { ...importer(batchId), kind: 'staff', personId: staff.personId } as never,
        { ...input, importProvenance: provenance(batchId) },
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('an imported opt-out never suppresses a mandatory notice; a person’s own later change wins', async () => {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId });
    const header = await authHeaderForPerson(t, personId);
    const batchId = newId();
    const result = await service.importPreferences(importer(batchId), {
      importProvenance: provenance(batchId),
      personId,
      preferences: [
        { channel: 'in_app', category: 'operational', enabled: false },
        { channel: 'email', category: 'operational', enabled: false },
        { channel: 'push', category: 'operational', enabled: false },
      ],
    });
    expect(result.mandatory).toEqual([
      { channel: 'in_app', category: 'operational', enabled: false },
    ]);
    expect(result.applied.map((p) => p.channel).sort()).toEqual(['email', 'push']);

    const mine = await t.http.get('/v1/me/communication-preferences').set(header);
    const pref = (channel: string, category = 'operational') =>
      mine.body.preferences.find(
        (p: { channel: string; category: string }) =>
          p.channel === channel && p.category === category,
      );
    expect(pref('in_app')).toMatchObject({ enabled: true, locked: true });
    expect(pref('email')).toMatchObject({ enabled: false, stored: true });

    // an essential notice still reaches the person in the app
    const n = await composeAndDispatch(t.app, systemPrincipal(org, 'test'), {
      kind: 'placement',
      audience: { subjectPersonIds: [personId] },
      title: 'Placement confirmed',
      body: 'You have been placed.',
    });
    expect((await attemptsOf(t.db, org, n.id)).map((a) => `${a.channel}:${a.status}`)).toEqual([
      'in_app:delivered',
    ]);

    // the person turns email back on themself; a later import does not override it
    const patched = await t.http
      .patch('/v1/me/communication-preferences')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ preferences: [{ channel: 'email', category: 'operational', enabled: true }] });
    expect(patched.status).toBe(200);
    const laterBatch = newId();
    const later = await service.importPreferences(importer(laterBatch), {
      importProvenance: provenance(laterBatch),
      personId,
      preferences: [
        { channel: 'email', category: 'operational', enabled: false },
        { channel: 'push', category: 'operational', enabled: true },
      ],
    });
    expect(later.keptPersonChoice).toEqual([
      { channel: 'email', category: 'operational', enabled: false },
    ]);
    expect(later.applied).toEqual([{ channel: 'push', category: 'operational', enabled: true }]);
    const rows = await stored(personId);
    expect(rows.find((r) => r.channel === 'email' && r.category === 'operational')).toMatchObject({
      enabled: true,
      source: 'person',
    });
    expect(rows.find((r) => r.channel === 'push' && r.category === 'operational')).toMatchObject({
      enabled: true,
      source: 'import',
    });
  });

  it('the database refuses an unknown preference source and any change to an import record', async () => {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    let error: unknown = null;
    try {
      await t.db
        .insertInto('communication_preferences')
        .values({
          id: newId(),
          organization_id: org,
          person_id: personId,
          channel: 'email',
          category: 'promotional',
          enabled: true,
          updated_by: json({ kind: 'system' }),
          source: 'guess' as never,
        })
        .execute();
    } catch (e) {
      error = e;
    }
    expect(isCheckViolation(error)).toBe(true);
    const batchId = newId();
    const record = provenance(batchId);
    await service.importPreferences(importer(batchId), {
      importProvenance: record,
      personId,
      preferences: [{ channel: 'email', category: 'promotional', enabled: true }],
    });
    let mutation: unknown = null;
    try {
      await t.db
        .updateTable('communication_preference_imports')
        .set({ external_key: 'rewritten' })
        .where('id', '=', record.recordId)
        .execute();
    } catch (e) {
      mutation = e;
    }
    expect(pgErrorCode(mutation)).not.toBeNull();
  });
});
