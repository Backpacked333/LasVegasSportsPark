import { importActorLabel, newId, systemPrincipal } from '@sportspark/contracts';
import { isCheckViolation, json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import { ProgramsService } from '../services/programs.service';

const key = () => `k-${newId()}`;

/**
 * CAT-03, IF-40 (§5.3, §5.4, SPK-AT-024): the program import command. Only the migration import
 * principal of the batch writes `source: 'import'`, with the id the migration module reserved,
 * once; staff over HTTP never can.
 */
describe('program import provenance (CAT-03)', () => {
  let t: TestApp;
  let programs: ProgramsService;
  let uow: UnitOfWork;
  let pm: { Authorization: string };
  let customer: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    programs = t.app.get(ProgramsService);
    uow = t.app.get(UnitOfWork);
    pm = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId,
    );
    customer = await authHeaderForPerson(t, (await createOrganizationPeople(t)).adult.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const effects = async (programId: string) => ({
    audit: await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_id', '=', programId)
      .execute(),
    events: await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', programId)
      .execute(),
  });

  it('an import principal creates a program once with the supplied id and source import', async () => {
    const batchId = newId();
    const recordId = newId();
    const importer = systemPrincipal(t.organizationId, importActorLabel(batchId));
    const provenance = { batchId, externalKey: 'legacy-program-17', recordId };
    const content = {
      name: `Imported league ${recordId.slice(-6)}`,
      activityType: 'soccer',
      format: '7v7',
      status: 'active' as const,
    };
    const created = await uow.run(() =>
      programs.create(importer, content, null, { importProvenance: provenance }),
    );
    expect(created).toMatchObject({ id: recordId, source: 'import', status: 'active' });
    const row = await t.db
      .selectFrom('programs')
      .select(['id', 'source', 'created_by'])
      .where('id', '=', recordId)
      .executeTakeFirstOrThrow();
    expect(row.source).toBe('import');
    expect(row.created_by).toMatchObject({ actorLabel: importActorLabel(batchId) });
    const first = await effects(recordId);
    expect(first.audit).toEqual([
      {
        action: 'catalog.program_created',
        details: { source: 'import', batchId, externalKey: 'legacy-program-17' },
      },
    ]);
    expect(first.events.map((e) => e.event_type)).toEqual(['catalog.program_created']);

    // the same record with equal content: the existing program, with no new effect
    const again = await programs.create(importer, content, null, { importProvenance: provenance });
    expect(again).toEqual(created);
    expect(await effects(recordId)).toEqual(first);
    // different content for the same record is a conflict, never an overwrite
    await expect(
      programs.create(importer, { ...content, format: '9v9' }, null, {
        importProvenance: provenance,
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'IMPORT_CONTENT_MISMATCH', programId: recordId },
    });
    // invalid import content is a validation failure, not a partial program
    await expect(
      programs.create(importer, { name: '', activityType: 'soccer' }, null, {
        importProvenance: { batchId, externalKey: 'legacy-program-18', recordId: newId() },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // staff read the provenance; customers cannot read programs at all
    const read = await t.http.get(`/v1/programs/${recordId}`).set(pm);
    expect(read.status).toBe(200);
    expect(read.body.source).toBe('import');
    expect((await t.http.get(`/v1/programs/${recordId}`).set(customer)).status).toBe(403);

    // the command joins the caller's unit of work: the import rolls back with it
    const rolledBack = newId();
    await expect(
      uow.run(async () => {
        await programs.create(importer, { ...content, name: `Rolled back ${rolledBack}` }, null, {
          importProvenance: { batchId, externalKey: 'legacy-program-19', recordId: rolledBack },
        });
        throw new Error('the batch step failed');
      }),
    ).rejects.toThrow('the batch step failed');
    expect(
      await t.db.selectFrom('programs').select('id').where('id', '=', rolledBack).execute(),
    ).toEqual([]);
  });

  it('a staff principal cannot create an imported program', async () => {
    const batchId = newId();
    const provenance = { batchId, externalKey: 'legacy-program-20', recordId: newId() };
    const content = { name: `Not imported ${newId().slice(-6)}`, activityType: 'soccer' };
    await expect(
      programs.create(
        staffPrincipal(t.organizationId, ['program_manager', 'system_administrator']),
        content,
        null,
        { importProvenance: provenance },
      ),
    ).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      details: { code: 'IMPORT_PRINCIPAL_REQUIRED', batchId },
    });
    // another batch's import principal is refused too
    await expect(
      programs.create(systemPrincipal(t.organizationId, importActorLabel(newId())), content, null, {
        importProvenance: provenance,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(
      await t.db
        .selectFrom('programs')
        .select('id')
        .where('id', '=', provenance.recordId)
        .execute(),
    ).toEqual([]);

    // over HTTP, neither the source nor the id can be chosen
    const res = await t.http
      .post('/v1/programs')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ ...content, source: 'import', id: provenance.recordId });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('staff');
    expect(res.body.id).not.toBe(provenance.recordId);
  });

  it('an in-process staff create without the defaulted fields gets the schema defaults', async () => {
    const created = await programs.create(
      staffPrincipal(t.organizationId, ['program_manager']),
      { name: `In process ${newId().slice(-6)}`, activityType: 'soccer' },
      null,
    );
    expect(created).toMatchObject({ status: 'draft', source: 'staff', ageBand: {} });
    await expect(
      programs.create(
        staffPrincipal(t.organizationId, ['program_manager']),
        { name: '' } as never,
        null,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('CAT-03: the database accepts only staff or import as a program source', async () => {
    const error = await t.db
      .insertInto('programs')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        name: `Legacy ${newId()}`,
        description: null,
        activity_type: 'soccer',
        format: null,
        age_band: json({}),
        source: 'legacy' as 'import',
        created_by: json({ kind: 'system', actorLabel: 'schema-test' }),
      })
      .execute()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isCheckViolation(error)).toBe(true);
  });
});
