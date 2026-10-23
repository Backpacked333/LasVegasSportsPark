import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';

const key = () => `k-${newId()}`;

describe('programs and entitlement definitions (SPK-CAT-001, SPK-YOUTH-001, §4.4)', () => {
  let t: TestApp;
  let pm: { Authorization: string };
  let frontDesk: { Authorization: string };
  let customer: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    pm = await authHeaderForPerson(t, manager.personId);
    const desk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    frontDesk = await authHeaderForPerson(t, desk.personId);
    const people = await createOrganizationPeople(t);
    customer = await authHeaderForPerson(t, people.adult.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-CAT-001: a program manager creates, reads, lists and updates a reusable program with revisions', async () => {
    const created = await t.http
      .post('/v1/programs')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        name: 'U10 Academy',
        description: 'Weekly development sessions',
        activityType: 'soccer',
        format: '7v7',
        ageBand: { minAgeYears: 8, maxAgeYears: 10 },
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'U10 Academy',
      status: 'draft',
      ageBand: { minAgeYears: 8, maxAgeYears: 10 },
      revision: 1,
    });
    const id = created.body.id as string;

    const read = await t.http.get(`/v1/programs/${id}`).set(pm);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(id);

    const activated = await t.http
      .patch(`/v1/programs/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, status: 'active', description: 'Updated' });
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ status: 'active', description: 'Updated', revision: 2 });

    const stale = await t.http
      .patch(`/v1/programs/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, name: 'Stale edit' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');

    const backToDraft = await t.http
      .patch(`/v1/programs/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2, status: 'draft' });
    expect(backToDraft.status).toBe(409);
    expect(backToDraft.body.code).toBe('INVALID_TRANSITION');

    const listed = await t.http.get('/v1/programs?status=active&limit=1').set(pm);
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((p: { id: string }) => p.id === id)).toBe(true);

    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', id)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'catalog.program_created',
      'catalog.program_updated',
    ]);
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', id)
      .execute();
    expect(events.map((e) => e.event_type).sort()).toEqual([
      'catalog.program_created',
      'catalog.program_updated',
    ]);
  });

  it('§4.9: creating a program is idempotent; the same key replays without a second row', async () => {
    const k = key();
    const body = { name: `Replay ${newId().slice(-6)}`, activityType: 'futsal' };
    const first = await t.http.post('/v1/programs').set(pm).set('Idempotency-Key', k).send(body);
    expect(first.status).toBe(201);
    const replay = await t.http.post('/v1/programs').set(pm).set('Idempotency-Key', k).send(body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const rows = await t.db
      .selectFrom('programs')
      .select('id')
      .where('name', '=', body.name)
      .execute();
    expect(rows).toHaveLength(1);
    const conflict = await t.http
      .post('/v1/programs')
      .set(pm)
      .set('Idempotency-Key', k)
      .send({ ...body, activityType: 'soccer' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('SPK-CAT-001: program names are unique per organization (reported as validation)', async () => {
    const name = `Unique ${newId().slice(-6)}`;
    await t.http
      .post('/v1/programs')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ name, activityType: 'soccer' });
    const dup = await t.http
      .post('/v1/programs')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ name, activityType: 'soccer' });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('VALIDATION_FAILED');
  });

  it('§4.14 staff role matrix: front desk reads but cannot manage; customers see nothing', async () => {
    const created = await t.http
      .post('/v1/programs')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ name: `Matrix ${newId().slice(-6)}`, activityType: 'soccer' });
    const id = created.body.id as string;
    expect((await t.http.get(`/v1/programs/${id}`).set(frontDesk)).status).toBe(200);
    const denied = await t.http
      .post('/v1/programs')
      .set(frontDesk)
      .set('Idempotency-Key', key())
      .send({ name: 'Nope', activityType: 'soccer' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ACCESS_DENIED');
    expect((await t.http.get(`/v1/programs/${id}`).set(customer)).status).toBe(403);
    expect((await t.http.get('/v1/programs').set(customer)).status).toBe(403);
    expect((await t.http.get(`/v1/programs/${id}`)).status).toBe(401);
  });

  it('§4.3: programs of another organization are not found', async () => {
    const { seedOrganization } = await import('@sportspark/db');
    const other = await seedOrganization(t.db);
    const foreignStaff = await createStaffMemberFixture(t, {
      roles: ['program_manager'],
      organizationId: other.organizationId,
    });
    const created = await t.http
      .post('/v1/programs')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ name: `Mine ${newId().slice(-6)}`, activityType: 'soccer' });
    const foreign = await authHeaderForPerson(t, foreignStaff.personId);
    expect((await t.http.get(`/v1/programs/${created.body.id}`).set(foreign)).status).toBe(404);
    const patch = await t.http
      .patch(`/v1/programs/${created.body.id}`)
      .set(foreign)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, name: 'Hijacked' });
    expect(patch.status).toBe(404);
  });

  it('§4.4 EntitlementDefinition: managers define what a purchase grants and its equivalence scope', async () => {
    const created = await t.http
      .post('/v1/entitlement-definitions')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        name: `Term seat ${newId().slice(-6)}`,
        kind: 'seat',
        scope: { sessionsIncluded: 'all' },
        equivalenceScope: 'program_period',
        equivalenceRule: { period: 'offering_dates' },
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'seat',
      equivalenceScope: 'program_period',
      status: 'active',
      revision: 1,
    });
    const id = created.body.id as string;
    const listed = await t.http.get('/v1/entitlement-definitions').set(frontDesk);
    expect(listed.status).toBe(200);
    expect(listed.body.some((d: { id: string }) => d.id === id)).toBe(true);
    const archived = await t.http
      .patch(`/v1/entitlement-definitions/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, status: 'archived' });
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    const edit = await t.http
      .patch(`/v1/entitlement-definitions/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2, name: 'Renamed while archived' });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('INVALID_TRANSITION');
    const denied = await t.http
      .post('/v1/entitlement-definitions')
      .set(frontDesk)
      .set('Idempotency-Key', key())
      .send({ name: 'X', kind: 'seat', equivalenceScope: 'offering' });
    expect(denied.status).toBe(403);
  });
});
