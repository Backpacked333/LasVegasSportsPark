import { newId, systemPrincipal, type DomainEvent, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
  IdentityEvents,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import {
  MERGED_PREFERENCE_CONFLICT,
  PersonMergeFollowUp,
} from '../services/person-merge-follow-up';
import { attemptsOf, composeAndDispatch, dispatchOutbox } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;

/**
 * COM-05: person merge follow-up (SPK-IAM-007, SPK-COMMS-003, SPK-COMMS-007, §4.2). Communications
 * rewrites no person id: the survivor reads the merged person's inbox and preferences; explicit
 * preferences that disagree resolve to the most protective choice and raise one support exception;
 * the mandatory in-app notice still goes out. The merge itself runs through identity's API.
 */
describe('person merge follow-up (COM-05, SPK-IAM-007)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let admin: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    const staff = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    admin = await authHeaderForPerson(t, staff.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  async function adult(givenName: string) {
    const personId = await createPersonFixture(t, {
      kind: 'adult',
      givenName,
      familyName: 'Merge',
    });
    await createAccountFixture(t, { personId });
    return { personId, header: await authHeaderForPerson(t, personId) };
  }

  /** Identity's merge (flag, then merge into the survivor); returns the merge id. */
  async function merge(survivorPersonId: string, mergedPersonId: string): Promise<string> {
    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(admin)
      .set('Idempotency-Key', key())
      .send({ personAId: survivorPersonId, personBId: mergedPersonId, reasons: ['same person'] });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
    const merged = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(admin)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId, reason: 'same person, verified at the desk' });
    expect(merged.status, JSON.stringify(merged.body)).toBe(201);
    const summary = await dispatchOutbox(t.app);
    expect(summary.dead).toBe(0);
    return merged.body.id as string;
  }

  const setPreferences = (
    header: { Authorization: string },
    preferences: Array<{ channel: string; category: string; enabled: boolean }>,
  ) =>
    t.http
      .patch('/v1/me/communication-preferences')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ preferences });

  const conflictExceptions = (survivorPersonId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', org)
      .where('category', '=', MERGED_PREFERENCE_CONFLICT)
      .where('affected_id', '=', survivorPersonId)
      .execute();

  it('SPK-IAM-007: the survivor’s inbox lists the merged person’s messages', async () => {
    const survivor = await adult('Robin');
    const duplicate = await adult('robin');
    const before = await composeAndDispatch(t.app, system, {
      kind: 'placement',
      audience: { subjectPersonIds: [duplicate.personId] },
      title: 'Placement for the duplicate record',
      body: 'You were placed on the Lions.',
    });
    const privateNotice = await composeAndDispatch(t.app, system, {
      kind: 'youth_feedback',
      audience: { subjectPersonIds: [duplicate.personId] },
      title: 'Private feedback for the duplicate record',
      body: 'Feedback.',
      protected: true,
    });
    await merge(survivor.personId, duplicate.personId);

    const inbox = await t.http.get('/v1/me/inbox?limit=50').set(survivor.header);
    expect(inbox.status).toBe(200);
    const ids = inbox.body.items.map((i: { notificationId: string }) => i.notificationId);
    expect(ids).toContain(before.id);
    // a protected notice addressed to the merged person is re-checked for the survivor
    expect(ids).toContain(privateNotice.id);
    const item = inbox.body.items.find(
      (i: { notificationId: string }) => i.notificationId === before.id,
    );
    // the survivor reads and acknowledges it as their own; the row itself was not rewritten
    const read = await t.http
      .post(`/v1/me/inbox/${item.attemptId}/read`)
      .set(survivor.header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: item.revision });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.status).toBe('read');
    const recipient = await t.db
      .selectFrom('notification_recipients')
      .select('person_id')
      .where('notification_id', '=', before.id)
      .executeTakeFirstOrThrow();
    expect(recipient.person_id).toBe(duplicate.personId);
    // an unrelated person still sees none of it
    const other = await adult('Other');
    const theirs = await t.http.get('/v1/me/inbox?limit=50').set(other.header);
    expect(
      theirs.body.items.map((i: { notificationId: string }) => i.notificationId),
    ).not.toContain(before.id);
    const stranger = await t.http
      .post(`/v1/me/inbox/${item.attemptId}/acknowledge`)
      .set(other.header)
      .set('Idempotency-Key', key())
      .send({});
    expect(stranger.status).toBe(404);
  });

  it('conflicting preferences resolve to opted out for optional notices and raise one exception; a mandatory notice still goes out', async () => {
    const survivor = await adult('Sam');
    const duplicate = await adult('sam');
    expect(
      (
        await setPreferences(survivor.header, [
          { channel: 'email', category: 'promotional', enabled: true },
          { channel: 'email', category: 'operational', enabled: true },
          { channel: 'sms', category: 'operational', enabled: true },
        ])
      ).status,
    ).toBe(200);
    expect(
      (
        await setPreferences(duplicate.header, [
          { channel: 'email', category: 'promotional', enabled: false },
          { channel: 'email', category: 'operational', enabled: false },
          { channel: 'sms', category: 'operational', enabled: true },
        ])
      ).status,
    ).toBe(200);
    const mergeId = await merge(survivor.personId, duplicate.personId);

    const exceptions = await conflictExceptions(survivor.personId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ owner_queue: 'support_operator', status: 'open' });
    expect(exceptions[0]?.details).toMatchObject({
      mergeId,
      mergedPersonId: duplicate.personId,
      conflicts: [
        { channel: 'email', category: 'operational' },
        { channel: 'email', category: 'promotional' },
      ],
    });
    const prefs = await t.http.get('/v1/me/communication-preferences').set(survivor.header);
    const pref = (channel: string, category: string) =>
      prefs.body.preferences.find(
        (p: { channel: string; category: string }) =>
          p.channel === channel && p.category === category,
      );
    expect(pref('email', 'promotional').enabled).toBe(false);
    expect(pref('email', 'operational').enabled).toBe(false);
    expect(pref('sms', 'operational').enabled).toBe(true); // they agree
    expect(pref('in_app', 'operational')).toMatchObject({ enabled: true, locked: true });

    // an essential notice still reaches the survivor in the app; the conflicting channel is off
    const essential = await composeAndDispatch(t.app, system, {
      kind: 'placement',
      audience: { subjectPersonIds: [survivor.personId] },
      title: 'Placement confirmed',
      body: 'You were placed.',
    });
    const channels = (await attemptsOf(t.db, org, essential.id)).map((a) => a.channel).sort();
    expect(channels).toEqual(['in_app', 'push', 'sms']);

    // the survivor chooses again after the merge: their own choice wins
    expect(
      (
        await setPreferences(survivor.header, [
          { channel: 'email', category: 'operational', enabled: true },
        ])
      ).status,
    ).toBe(200);
    const again = await t.http.get('/v1/me/communication-preferences').set(survivor.header);
    expect(
      again.body.preferences.find(
        (p: { channel: string; category: string }) =>
          p.channel === 'email' && p.category === 'operational',
      ).enabled,
    ).toBe(true);
  });

  it('a replayed merge event raises nothing new', async () => {
    const survivor = await adult('Alex');
    const duplicate = await adult('alex');
    await setPreferences(survivor.header, [
      { channel: 'push', category: 'promotional', enabled: true },
    ]);
    await setPreferences(duplicate.header, [
      { channel: 'push', category: 'promotional', enabled: false },
    ]);
    const mergeId = await merge(survivor.personId, duplicate.personId);
    expect(await conflictExceptions(survivor.personId)).toHaveLength(1);

    // the dispatcher redelivers the event
    const outbox = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', IdentityEvents.personsMerged.type)
      .where('aggregate_id', '=', survivor.personId)
      .executeTakeFirstOrThrow();
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null })
      .where('id', '=', outbox.id)
      .execute();
    await dispatchOutbox(t.app);
    // and the handler itself sees the same event again
    const event = {
      id: outbox.id,
      type: IdentityEvents.personsMerged.type,
      organizationId: org,
      aggregateType: 'person',
      aggregateId: survivor.personId,
      payload: outbox.payload,
      correlationId: null,
      operationId: null,
      occurredAt: t.clock.now().toISOString(),
    } as unknown as DomainEvent<never>;
    const replay = await t.app
      .get(UnitOfWork)
      .run(({ trx }) => t.app.get(PersonMergeFollowUp).onPersonsMerged(trx, event));
    expect(replay).toEqual({ followed: false, conflicts: 0 });
    expect(await conflictExceptions(survivor.personId)).toHaveLength(1);
    const followUps = await t.db
      .selectFrom('communication_merge_follow_ups')
      .select('merge_id')
      .where('merge_id', '=', mergeId)
      .execute();
    expect(followUps).toHaveLength(1);
  });

  it('the database refuses a change to a followed merge', async () => {
    const survivor = await adult('Jo');
    const duplicate = await adult('jo');
    const mergeId = await merge(survivor.personId, duplicate.personId);
    await expect(
      t.db
        .updateTable('communication_merge_follow_ups')
        .set({ conflicts: JSON.stringify([]) })
        .where('merge_id', '=', mergeId)
        .execute(),
    ).rejects.toThrow();
    await expect(
      t.db.deleteFrom('communication_merge_follow_ups').where('merge_id', '=', mergeId).execute(),
    ).rejects.toThrow();
  });
});
