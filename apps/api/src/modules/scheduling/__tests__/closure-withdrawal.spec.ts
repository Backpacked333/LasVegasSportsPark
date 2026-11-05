import { errors, newId, type Principal } from '@sportspark/contracts';
import { isCheckViolation, json, pgErrorCode, tstzrange } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { CLOSURE_PORT, type ClosurePort } from '../ports';
import { SchedulingModule } from '../scheduling.module';
import { ClosureLiftGuards } from '../services/closure-lift-guards';
import { ClosuresService } from '../services/closures.service';
import { EventsService } from '../services/events.service';
import {
  at,
  createScheduledEvent,
  personCommitment,
  seedPitchWithHalves,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

/**
 * SCH-01: withdrawing a pending closure (SPK-FAC-003, §4.6 ClosureMachine `withdraw`) and the
 * preview-only closure impact (SPK-SCHED-009) — `POST /v1/closures/{id}/withdraw`,
 * `ClosurePort.withdrawClosure` (IF-11), `scheduling.closure_withdrawn` (IF-12) and
 * `GET /v1/closure-impact`, with the database guarantees of migration 0302.
 */
describe('closure withdrawal and impact preview (SCH-01: SPK-FAC-003, SPK-SCHED-009)', () => {
  let t: TestApp;
  let events: EventsService;
  let closures: ClosuresService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let scheduler: Principal;
  let auth: { Authorization: string };
  const owned = new Set<string>();

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    events = t.app.get(EventsService);
    closures = t.app.get(ClosuresService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
    scheduler = staffPrincipal(org, ['scheduler']);
    auth = await t.authHeader(scheduler);
    t.app
      .get(ClosureLiftGuards)
      .register('test.restriction_owner', async (_trx, _org, closureId, operation) => {
        if (operation === 'withdraw' && owned.has(closureId)) {
          throw errors.resourceConflict('owned by a restriction', {
            code: 'OWNED_BY_RESTRICTION',
            closureId,
          });
        }
      });
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;

  const createPending = async (
    body: Partial<{ resourceId: string; source: string; reason: string }> & {
      start: string;
      end: string;
    },
  ) => {
    const res = await t.http
      .post('/v1/closures')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        facilityId: facility,
        resourceId: body.resourceId ?? pitch.northHalfId,
        interval: { start: body.start, end: body.end },
        reason: body.reason ?? 'Line marking',
        source: body.source ?? 'manual',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; revision: number; status: string };
  };

  it('SPK-FAC-003: a pending closure is withdrawn and can never be applied', async () => {
    const closure = await createPending({
      start: at('2026-11-02', '08:00'),
      end: at('2026-11-02', '12:00'),
    });
    expect(closure.status).toBe('pending');

    // the reason is required
    const noReason = await t.http
      .post(`/v1/closures/${closure.id}/withdraw`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({});
    expect(noReason.status).toBe(400);
    // a stale revision is refused (§4.9)
    const stale = await t.http
      .post(`/v1/closures/${closure.id}/withdraw`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ reason: 'Not needed', expectedRevision: closure.revision + 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');

    const idempotencyKey = key();
    const withdrawn = await t.http
      .post(`/v1/closures/${closure.id}/withdraw`)
      .set(auth)
      .set('Idempotency-Key', idempotencyKey)
      .send({ reason: 'Marking moved to next week', expectedRevision: closure.revision });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body).toMatchObject({
      id: closure.id,
      status: 'withdrawn',
      withdrawnAt: t.clock.now().toISOString(),
      withdrawalReason: 'Marking moved to next week',
      appliedAt: null,
      revision: closure.revision + 1,
    });
    // a replay returns the same outcome without a second withdrawal
    const replay = await t.http
      .post(`/v1/closures/${closure.id}/withdraw`)
      .set(auth)
      .set('Idempotency-Key', idempotencyKey)
      .send({ reason: 'Marking moved to next week', expectedRevision: closure.revision });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(withdrawn.body);

    // it can never be applied, lifted or withdrawn again (ClosureMachine terminal state)
    for (const [path, body] of [
      ['apply', { mode: 'cancel_affected' }],
      ['lift', {}],
      ['withdraw', { reason: 'again' }],
    ] as const) {
      const res = await t.http
        .post(`/v1/closures/${closure.id}/${path}`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send(body);
      expect(res.status, path).toBe(409);
      expect(res.body.code, path).toBe('INVALID_TRANSITION');
    }
    // it never affected availability: the space books normally
    const booked = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-02', '09:00'),
      end: at('2026-11-02', '10:00'),
    });
    expect(booked.status).toBe('published');

    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason', 'before_revision', 'after_revision'])
      .where('target_id', '=', closure.id)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'scheduling.closure_created',
      'scheduling.closure_withdrawn',
    ]);
    expect(audit[1]).toMatchObject({
      reason: 'Marking moved to next week',
      before_revision: 1,
      after_revision: 2,
    });
    const outbox = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', closure.id)
      .execute();
    expect(outbox).toEqual([
      {
        event_type: 'scheduling.closure_withdrawn',
        payload: {
          closureId: closure.id,
          facilityId: facility,
          resourceId: pitch.northHalfId,
          interval: { start: at('2026-11-02', '08:00'), end: at('2026-11-02', '12:00') },
          source: 'manual',
          reason: 'Marking moved to next week',
        },
      },
    ]);
  });

  it('§4.6: an active closure is lifted, not withdrawn (INVALID_TRANSITION)', async () => {
    const closure = await createPending({
      start: at('2026-11-03', '08:00'),
      end: at('2026-11-03', '12:00'),
    });
    const applied = await t.http
      .post(`/v1/closures/${closure.id}/apply`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ mode: 'leave_for_resolution' });
    expect(applied.status).toBe(200);
    const res = await t.http
      .post(`/v1/closures/${closure.id}/withdraw`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ reason: 'Too late' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { machine: 'Closure', from: 'active', event: 'withdraw' },
    });
    expect((await closures.getClosure(scheduler, closure.id)).status).toBe('active');
  });

  it('§4.2: a closure a restriction owns is withdrawn through its restriction: OWNED_BY_RESTRICTION over HTTP, allowed through CLOSURE_PORT inside the caller’s unit of work', async () => {
    const closure = await createPending({
      start: at('2026-11-04', '08:00'),
      end: at('2026-11-04', '12:00'),
      source: 'maintenance',
      reason: 'Goal repair',
    });
    // The owning module's guard decides ownership, as for a lift (facilities registers one for
    // the closures its restrictions hold; this scheduling-only app registers a stand-in).
    owned.add(closure.id);
    const http = await t.http
      .post(`/v1/closures/${closure.id}/withdraw`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ reason: 'Not needed' });
    expect(http.status).toBe(409);
    expect(http.body).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'OWNED_BY_RESTRICTION', closureId: closure.id },
    });

    const port = t.app.get<ClosurePort>(CLOSURE_PORT);
    const facilitiesOperator = staffPrincipal(org, ['facilities_operator']);
    const uow = t.app.get(UnitOfWork);
    // joined: when the caller's unit fails afterwards, the withdrawal rolls back with it
    await expect(
      uow.run(async () => {
        await port.withdrawClosure(facilitiesOperator, closure.id, {
          reason: 'Restriction withdrawn',
        });
        throw new Error('caller failed after the withdrawal');
      }),
    ).rejects.toThrow('caller failed after the withdrawal');
    expect((await closures.getClosure(scheduler, closure.id)).status).toBe('pending');

    const withdrawn = await uow.run(() =>
      port.withdrawClosure(facilitiesOperator, closure.id, {
        reason: 'Restriction withdrawn',
        expectedRevision: closure.revision,
      }),
    );
    expect(withdrawn).toMatchObject({
      status: 'withdrawn',
      source: 'maintenance',
      withdrawalReason: 'Restriction withdrawn',
    });
  });

  it('§4.2: a staff-created maintenance closure that no restriction holds is withdrawn over HTTP', async () => {
    const closure = await createPending({
      start: at('2026-11-04', '13:00'),
      end: at('2026-11-04', '15:00'),
      source: 'maintenance',
      reason: 'Line painting',
    });
    const http = await t.http
      .post(`/v1/closures/${closure.id}/withdraw`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ reason: 'Painting moved to next week' });
    expect(http.status, JSON.stringify(http.body)).toBe(200);
    expect(http.body).toMatchObject({ status: 'withdrawn', source: 'maintenance' });
  });

  it('CLOSURE_PORT.withdrawClosure refuses an empty or oversized reason as VALIDATION_FAILED', async () => {
    const closure = await createPending({
      start: at('2026-11-04', '16:00'),
      end: at('2026-11-04', '17:00'),
    });
    const port = t.app.get<ClosurePort>(CLOSURE_PORT);
    const operator = staffPrincipal(org, ['facilities_operator']);
    const uow = t.app.get(UnitOfWork);
    for (const reason of ['', 'x'.repeat(2001)]) {
      await expect(
        uow.run(() => port.withdrawClosure(operator, closure.id, { reason })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect((await closures.getClosure(scheduler, closure.id)).status).toBe('pending');
  });

  it('authorization: front desk cannot withdraw a closure or preview an impact', async () => {
    const closure = await createPending({
      start: at('2026-11-05', '08:00'),
      end: at('2026-11-05', '12:00'),
    });
    const frontDesk = await t.authHeader(staffPrincipal(org, ['front_desk']));
    const withdraw = await t.http
      .post(`/v1/closures/${closure.id}/withdraw`)
      .set(frontDesk)
      .set('Idempotency-Key', key())
      .send({ reason: 'Not mine' });
    expect(withdraw.status).toBe(403);
    const preview = await t.http
      .get('/v1/closure-impact')
      .set(frontDesk)
      .query({
        facilityId: facility,
        start: at('2026-11-05', '08:00'),
        end: at('2026-11-05', '12:00'),
      });
    expect(preview.status).toBe(403);
    expect((await closures.getClosure(scheduler, closure.id)).status).toBe('pending');
  });

  it('SPK-SCHED-009: GET /v1/closure-impact returns the closure impact (events, customers, obligations, messages) and creates nothing', async () => {
    const coach = newId();
    const game = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-06', '10:00'),
      end: at('2026-11-06', '11:00'),
      title: 'Morning game',
      commitments: [personCommitment(coach, 'coach')],
    });
    const southOnly = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-06', '10:00'),
      end: at('2026-11-06', '11:00'),
      kind: 'rental',
      title: 'South rental',
      sourceType: 'rental',
    });
    const countRows = async () => ({
      closures: (await t.db.selectFrom('closures').select('id').execute()).length,
      audit: (await t.db.selectFrom('audit_records').select('id').execute()).length,
      outbox: (await t.db.selectFrom('outbox_events').select('id').execute()).length,
    });
    const before = await countRows();
    const res = await t.http
      .get('/v1/closure-impact')
      .set(auth)
      .query({
        facilityId: facility,
        resourceId: pitch.northHalfId,
        start: at('2026-11-06', '09:00'),
        end: at('2026-11-06', '12:00'),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.affectedEvents.map((e: { eventId: string }) => e.eventId)).toEqual([game.id]);
    expect(res.body.affectedEvents.map((e: { eventId: string }) => e.eventId)).not.toContain(
      southOnly.id,
    );
    expect(res.body.customers).toEqual([
      { personId: coach, eventIds: [game.id], via: ['commitment'] },
    ]);
    expect(res.body.obligations).toEqual([]);
    expect(res.body.messages).toEqual([]);
    expect(res.body.summary).toMatchObject({ games: 1, people: 1, customers: 1 });
    expect(res.body.interval).toEqual({
      start: at('2026-11-06', '09:00'),
      end: at('2026-11-06', '12:00'),
    });
    expect(await countRows()).toEqual(before);

    // the same impact POST /closures records when the closure is created
    const created = await createPending({
      start: at('2026-11-06', '09:00'),
      end: at('2026-11-06', '12:00'),
    });
    const stored = await closures.getClosure(scheduler, created.id);
    expect(stored.impact).toEqual(res.body);

    // the whole facility, and an empty interval refused
    const whole = await t.http
      .get('/v1/closure-impact')
      .set(auth)
      .query({
        facilityId: facility,
        start: at('2026-11-06', '09:00'),
        end: at('2026-11-06', '12:00'),
      });
    expect(whole.status).toBe(200);
    expect(whole.body.affectedEvents.map((e: { eventId: string }) => e.eventId).sort()).toEqual(
      [game.id, southOnly.id].sort(),
    );
    const backwards = await t.http
      .get('/v1/closure-impact')
      .set(auth)
      .query({
        facilityId: facility,
        start: at('2026-11-06', '12:00'),
        end: at('2026-11-06', '09:00'),
      });
    expect(backwards.status).toBe(400);
    const unknownFacility = await t.http
      .get('/v1/closure-impact')
      .set(auth)
      .query({
        facilityId: newId(),
        start: at('2026-11-06', '09:00'),
        end: at('2026-11-06', '12:00'),
      });
    expect([403, 404]).toContain(unknownFacility.status);
  });

  it('the database rejects a withdrawn closure without withdrawal facts, a status change out of withdrawn and any transition ClosureMachine forbids (migrations 0302, 0303)', async () => {
    const base = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: org,
      facility_id: facility,
      resource_id: null,
      during: tstzrange(at('2026-11-20', '08:00'), at('2026-11-20', '12:00')),
      reason: 'direct',
      source: 'manual' as const,
      created_by: json({}),
      impact: null,
      resolution: null,
      applied_at: null,
      lifted_at: null,
      ...overrides,
    });
    const insert = (overrides: Record<string, unknown>) =>
      t.db
        .insertInto('closures')
        .values(base(overrides) as never)
        .execute();
    const now = t.clock.now();
    const facts = {
      withdrawn_at: now,
      withdrawn_by: json({ kind: 'staff' }),
      withdrawal_reason: 'not needed',
    };
    // withdrawn without its instant, actor or reason
    await expect(insert({ status: 'withdrawn' })).rejects.toSatisfy(isCheckViolation);
    await expect(insert({ status: 'withdrawn', ...facts, withdrawn_by: null })).rejects.toSatisfy(
      isCheckViolation,
    );
    await expect(
      insert({ status: 'withdrawn', ...facts, withdrawal_reason: null }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insert({ status: 'withdrawn', ...facts, withdrawal_reason: '' }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insert({ status: 'withdrawn', ...facts, withdrawal_reason: 'x'.repeat(2001) }),
    ).rejects.toSatisfy(isCheckViolation);
    // withdrawal facts on a closure that is not withdrawn
    await expect(insert({ status: 'pending', ...facts })).rejects.toSatisfy(isCheckViolation);
    // a withdrawn closure was never applied
    await expect(insert({ status: 'withdrawn', ...facts, applied_at: now })).rejects.toSatisfy(
      isCheckViolation,
    );

    // a withdrawn closure is final: no status change out of it, no rewrite of its facts
    const withdrawnId = newId();
    await insert({ id: withdrawnId, status: 'withdrawn', ...facts });
    const isRestrict = (error: unknown) => pgErrorCode(error) === '23001';
    await expect(
      t.db
        .updateTable('closures')
        .set({ status: 'pending', withdrawn_at: null, withdrawn_by: null, withdrawal_reason: null })
        .where('id', '=', withdrawnId)
        .execute(),
    ).rejects.toSatisfy(isRestrict);
    await expect(
      t.db
        .updateTable('closures')
        .set({ status: 'active', withdrawn_at: null, applied_at: now })
        .where('id', '=', withdrawnId)
        .execute(),
    ).rejects.toSatisfy(isRestrict);
    await expect(
      t.db
        .updateTable('closures')
        .set({ withdrawal_reason: 'rewritten' })
        .where('id', '=', withdrawnId)
        .execute(),
    ).rejects.toSatisfy(isRestrict);
    // a lifted closure is final as well
    const liftedId = newId();
    await insert({ id: liftedId, status: 'lifted', applied_at: now, lifted_at: now });
    await expect(
      t.db
        .updateTable('closures')
        .set({ status: 'active', lifted_at: null })
        .where('id', '=', liftedId)
        .execute(),
    ).rejects.toSatisfy(isRestrict);
    await expect(
      t.db
        .updateTable('closures')
        .set({ during: tstzrange(at('2026-11-21', '08:00'), at('2026-11-21', '12:00')) })
        .where('id', '=', liftedId)
        .execute(),
    ).rejects.toSatisfy(isRestrict);
    await expect(
      t.db
        .updateTable('closures')
        .set({ created_by: json({ kind: 'staff', rewritten: true }) })
        .where('id', '=', liftedId)
        .execute(),
    ).rejects.toSatisfy(isRestrict);
    // a pending closure still moves through its lifecycle
    const pendingId = newId();
    await insert({ id: pendingId, status: 'pending' });
    await t.db
      .updateTable('closures')
      .set({ status: 'withdrawn', ...facts })
      .where('id', '=', pendingId)
      .execute();

    // migration 0303: only the transitions ClosureMachine allows
    const pendingToLift = newId();
    await insert({ id: pendingToLift, status: 'pending' });
    await expect(
      t.db
        .updateTable('closures')
        .set({ status: 'lifted', applied_at: now, lifted_at: now })
        .where('id', '=', pendingToLift)
        .execute(),
    ).rejects.toSatisfy(isRestrict);
    const activeId = newId();
    await insert({ id: activeId, status: 'active', applied_at: now });
    await expect(
      t.db.updateTable('closures').set({ status: 'pending' }).where('id', '=', activeId).execute(),
    ).rejects.toSatisfy(isRestrict);
    await expect(
      t.db
        .updateTable('closures')
        .set({ status: 'withdrawn', applied_at: null, ...facts })
        .where('id', '=', activeId)
        .execute(),
    ).rejects.toSatisfy(isRestrict);
    // a lifted closure records its application and its lift
    await expect(insert({ status: 'lifted', lifted_at: now })).rejects.toSatisfy(isCheckViolation);
    // the allowed moves still pass
    await t.db
      .updateTable('closures')
      .set({ status: 'active', applied_at: now })
      .where('id', '=', pendingToLift)
      .execute();
    await t.db
      .updateTable('closures')
      .set({ status: 'lifted', lifted_at: now })
      .where('id', '=', activeId)
      .execute();
  });
});
