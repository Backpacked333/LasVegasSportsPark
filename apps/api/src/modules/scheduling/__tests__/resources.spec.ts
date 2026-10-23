import { newId, type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { SchedulingModule } from '../scheduling.module';

describe('physical inventory: resources, configurations, conflict units, operating hours (SPK-SCHED-001/002)', () => {
  let t: TestApp;
  let org: string;
  let facility: string;
  let scheduler: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule] });
    org = t.organizationId;
    facility = t.facilityId;
    scheduler = staffPrincipal(org, ['scheduler']);
    auth = await t.authHeader(scheduler);
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object, headers = auth, k = key()) =>
    t.http.post(path).set(headers).set('Idempotency-Key', k).send(body);

  it('SPK-SCHED-001/002: creates a pitch, its subdivisions and the unit mapping that makes the whole conflict with every half', async () => {
    const pitch = await post('/v1/resources', {
      facilityId: facility,
      kind: 'pitch',
      name: 'Pitch 3',
      dimensions: { lengthM: 100, widthM: 64 },
      compatibleFormats: ['11v11'],
      defaultCleanupMinutes: 10,
      requiredEquipment: [{ kind: 'goals', size: 'full' }],
      staffingConstraints: { minimumStaff: 1 },
    });
    expect(pitch.status, JSON.stringify(pitch.body)).toBe(201);
    expect(pitch.body).toMatchObject({
      kind: 'pitch',
      status: 'active',
      revision: 1,
      defaultCleanupMinutes: 10,
      parentResourceId: null,
    });
    expect(pitch.body.conflictUnitIds).toHaveLength(1); // a dedicated unit was created
    const north = await post('/v1/resources', {
      facilityId: facility,
      kind: 'subdivision',
      name: 'Pitch 3 north',
      parentResourceId: pitch.body.id,
      compatibleFormats: ['7v7'],
    });
    const south = await post('/v1/resources', {
      facilityId: facility,
      kind: 'subdivision',
      name: 'Pitch 3 south',
      parentResourceId: pitch.body.id,
      compatibleFormats: ['7v7'],
    });
    expect(north.status).toBe(201);
    expect(south.status).toBe(201);
    const whole = await t.http.get(`/v1/resources/${pitch.body.id}`).set(auth);
    expect(whole.body.conflictUnitIds.sort()).toEqual(
      [
        ...pitch.body.conflictUnitIds,
        ...north.body.conflictUnitIds,
        ...south.body.conflictUnitIds,
      ].sort(),
    );
    expect(north.body.conflictUnitIds).toHaveLength(1);
    expect(north.body.conflictUnitIds).not.toEqual(south.body.conflictUnitIds);
    const list = await t.http
      .get('/v1/resources')
      .query({ facilityId: facility })
      .set(await t.authHeader(staffPrincipal(org, ['front_desk'])));
    expect(list.status).toBe(200);
    expect(list.body.map((r: { name: string }) => r.name)).toEqual([
      'Pitch 3',
      'Pitch 3 north',
      'Pitch 3 south',
    ]);
    const units = await t.http.get('/v1/conflict-units').query({ facilityId: facility }).set(auth);
    expect(units.body).toHaveLength(3);
    expect(
      units.body
        .find((u: { id: string }) => u.id === north.body.conflictUnitIds[0])
        .resourceIds.sort(),
    ).toEqual([pitch.body.id, north.body.id].sort());

    const orphan = await post('/v1/resources', {
      facilityId: facility,
      kind: 'subdivision',
      name: 'Orphan',
    });
    expect(orphan.status).toBe(400);
    expect(orphan.body.code).toBe('VALIDATION_FAILED');
    const duplicate = await post('/v1/resources', {
      facilityId: facility,
      kind: 'pitch',
      name: 'Pitch 3',
    });
    expect(duplicate.status).toBe(400); // unique (organization, facility, name) is a database guarantee
    expect(duplicate.body.code).toBe('VALIDATION_FAILED');
  });

  it('updates with optimistic concurrency and audits status changes', async () => {
    const created = await post('/v1/resources', {
      facilityId: facility,
      kind: 'room',
      name: 'Party room',
    });
    const stale = await t.http
      .patch(`/v1/resources/${created.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 7, name: 'x' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const updated = await t.http
      .patch(`/v1/resources/${created.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: 1,
        status: 'restricted',
        defaultSetupMinutes: 5,
        reason: 'carpet replacement',
      });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      revision: 2,
      status: 'restricted',
      defaultSetupMinutes: 5,
      name: 'Party room',
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason', 'details'])
      .where('target_id', '=', created.body.id)
      .orderBy('occurred_at')
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({ action: 'scheduling.resource_created' }),
      expect.objectContaining({
        action: 'scheduling.resource_updated',
        reason: 'carpet replacement',
        details: { status: 'restricted' },
      }),
    ]);
    const unknownUnit = await t.http
      .patch(`/v1/resources/${created.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2, conflictUnitIds: [newId()] });
    expect(unknownUnit.status).toBe(400);
  });

  it('idempotent replay creates one resource and returns the stored response', async () => {
    const k = key();
    const body = { facilityId: facility, kind: 'other', name: 'Parking overflow' };
    const first = await post('/v1/resources', body, auth, k);
    const replay = await post('/v1/resources', body, auth, k);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const rows = await t.db
      .selectFrom('resources')
      .select('id')
      .where('name', '=', 'Parking overflow')
      .execute();
    expect(rows).toHaveLength(1);
    const conflict = await post('/v1/resources', { ...body, name: 'Different' }, auth, k);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('staff role matrix: scheduler, general manager and system administrator manage inventory; others only read; cross-organization is not found', async () => {
    const body = (name: string) => ({ facilityId: facility, kind: 'room', name });
    for (const role of ['scheduler', 'general_manager', 'system_administrator'] as const) {
      const res = await post(
        '/v1/resources',
        body(`Room ${role}`),
        await t.authHeader(staffPrincipal(org, [role])),
      );
      expect(res.status, role).toBe(201);
    }
    for (const role of [
      'front_desk',
      'facilities_operator',
      'league_manager',
      'program_manager',
      'coach',
      'official',
      'finance_operator',
      'support_operator',
    ] as const) {
      const res = await post(
        '/v1/resources',
        body(`Room ${role}`),
        await t.authHeader(staffPrincipal(org, [role])),
      );
      expect(res.status, role).toBe(403);
      expect(res.body.code).toBe('ACCESS_DENIED');
      const read = await t.http
        .get('/v1/resources')
        .query({ facilityId: facility })
        .set(await t.authHeader(staffPrincipal(org, [role])));
      expect(read.status, role).toBe(200);
    }
    const scoped = await t.authHeader(
      staffPrincipal(org, ['scheduler'], { facilityIds: [newId()] }),
    );
    const outOfScope = await post('/v1/resources', body('Elsewhere'), scoped);
    expect(outOfScope.status).toBe(403);
    const other = await seedOrganization(t.db);
    const otherOrg = await t.authHeader(
      staffPrincipal(other.organizationId, ['system_administrator']),
    );
    const foreign = await post('/v1/resources', body('Foreign'), otherOrg);
    expect(foreign.status).toBe(404); // the facility does not exist in their organization
    const existing = await t.db
      .selectFrom('resources')
      .select('id')
      .where('organization_id', '=', org)
      .executeTakeFirstOrThrow();
    expect((await t.http.get(`/v1/resources/${existing.id}`).set(otherOrg)).status).toBe(404);
    const anonymous = await t.http.get('/v1/resources').query({ facilityId: facility });
    expect(anonymous.status).toBe(401);
  });

  it('configurations name which resources may operate simultaneously (SPK-SCHED-002)', async () => {
    const a = await post('/v1/resources', { facilityId: facility, kind: 'pitch', name: 'Pitch 4' });
    const n = await post('/v1/resources', {
      facilityId: facility,
      kind: 'subdivision',
      name: 'Pitch 4 north',
      parentResourceId: a.body.id,
    });
    const s = await post('/v1/resources', {
      facilityId: facility,
      kind: 'subdivision',
      name: 'Pitch 4 south',
      parentResourceId: a.body.id,
    });
    const halves = await post('/v1/resource-configurations', {
      facilityId: facility,
      name: 'Pitch 4: two halves',
      memberResourceIds: [n.body.id, s.body.id],
    });
    expect(halves.status, JSON.stringify(halves.body)).toBe(201);
    expect(halves.body).toMatchObject({
      active: true,
      memberResourceIds: [n.body.id, s.body.id].sort(),
      revision: 1,
    });
    const unknown = await post('/v1/resource-configurations', {
      facilityId: facility,
      name: 'bad',
      memberResourceIds: [newId()],
    });
    expect(unknown.status).toBe(400);
    const updated = await t.http
      .patch(`/v1/resource-configurations/${halves.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: 1,
        active: false,
        description: 'retired until the divider is fixed',
      });
    expect(updated.body).toMatchObject({
      active: false,
      revision: 2,
      description: 'retired until the divider is fixed',
    });
    const list = await t.http
      .get('/v1/resource-configurations')
      .query({ facilityId: facility })
      .set(auth);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(halves.body.id);
  });

  it('conflict units can be shared explicitly and operating hours are windows per weekday', async () => {
    const unit = await post('/v1/conflict-units', { facilityId: facility, name: 'Shared corner' });
    expect(unit.status).toBe(201);
    const court = await post('/v1/resources', {
      facilityId: facility,
      kind: 'other',
      name: 'Corner court',
      conflictUnitIds: [unit.body.id],
    });
    expect(court.body.conflictUnitIds).toEqual([unit.body.id]);
    const hours = await post('/v1/operating-hours', {
      facilityId: facility,
      weekday: 6,
      opensAt: '08:00',
      closesAt: '22:00',
    });
    expect(hours.status, JSON.stringify(hours.body)).toBe(201);
    expect(hours.body).toMatchObject({
      resourceId: null,
      weekday: 6,
      opensAt: '08:00',
      closesAt: '22:00',
    });
    const resourceHours = await post('/v1/operating-hours', {
      facilityId: facility,
      resourceId: court.body.id,
      weekday: 6,
      opensAt: '10:00',
      closesAt: '24:00',
    });
    expect(resourceHours.status).toBe(201);
    expect(resourceHours.body.closesAt).toBe('24:00');
    const inverted = await post('/v1/operating-hours', {
      facilityId: facility,
      weekday: 1,
      opensAt: '12:00',
      closesAt: '09:00',
    });
    expect(inverted.status).toBe(400);
    const list = await t.http
      .get('/v1/operating-hours')
      .query({ facilityId: facility, resourceId: court.body.id })
      .set(auth);
    expect(list.body).toEqual([expect.objectContaining({ id: resourceHours.body.id })]);
    const deleted = await t.http
      .delete(`/v1/operating-hours/${hours.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key());
    expect(deleted.status).toBe(200);
    const after = await t.http.get('/v1/operating-hours').query({ facilityId: facility }).set(auth);
    expect(after.body.map((h: { id: string }) => h.id)).toEqual([resourceHours.body.id]);
  });
});
