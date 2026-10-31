import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_REGISTRY, type IntegrationRegistryPort } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createAcknowledgmentFixture } from '../../catalog';
import { createPersonFixture } from '../../identity';
import { at } from '../../scheduling';
import { createAssignmentFixture } from '../../workforce';
import {
  adultCustomer,
  enroll,
  entryTestApp,
  family,
  post,
  program,
  sessionRef,
  staffMember,
  TODAY,
  type Actor,
  type Family,
  type Program,
} from './support';

/**
 * ENT-01 (SPK-ENTRY-002, SPK-ENTRY-004, SPK-UX-002, SPK-UX-007, §4.14, §4.15): the holder's own
 * passes, the scan's check-in revision, participant names on attendance, the stored offline batch
 * and the hardware adapter registration.
 */
describe('holder and staff reads (ENT-01)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let fam: Family;
  let p: Program;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
    p = await program(t, manager);
    await enroll(t, p, fam.childA, fam.guardian.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const myPasses = (actor: Actor) => t.http.get('/v1/me/passes').set(actor.header);

  it('SPK-ENTRY-002 / SCR-C-05: the holder lists their passes and sees a staff revocation', async () => {
    const holder = await adultCustomer(t);
    expect((await myPasses(holder)).body).toEqual([]);
    const issued = await post(t, '/v1/passes', holder, {
      holder: { kind: 'person', personId: holder.personId },
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const listed = await myPasses(holder);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toEqual([
      {
        id: issued.body.pass.id,
        holderKind: 'person',
        holderPersonId: holder.personId,
        status: 'active',
        issuedAt: t.clock.now().toISOString(),
        revokedAt: null,
        revokedReason: null,
        referenceAvailable: false,
        revision: 1,
      },
    ]);

    // Staff revoke it (a card reported found in the car park): the holder can now tell.
    t.clock.advance(60_000);
    const revoked = await post(t, `/v1/passes/${issued.body.pass.id}/revoke`, desk, {
      reason: 'Card handed in at the desk by another family',
      expectedRevision: 1,
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const after = await myPasses(holder);
    expect(after.body).toEqual([
      expect.objectContaining({
        id: issued.body.pass.id,
        status: 'revoked',
        revokedAt: t.clock.now().toISOString(),
        // The staff reason is not shown to the customer (§4.14).
        revokedReason: null,
        revision: 2,
      }),
    ]);

    // The holder issues a replacement; the newest comes first, and only their own are listed.
    t.clock.advance(60_000);
    const replacement = await post(t, '/v1/passes', holder, {
      holder: { kind: 'person', personId: holder.personId },
    });
    expect(replacement.status).toBe(201);
    expect((await myPasses(holder)).body.map((x: { id: string }) => x.id)).toEqual([
      replacement.body.pass.id,
      issued.body.pass.id,
    ]);
    const stranger = await adultCustomer(t);
    expect((await myPasses(stranger)).body).toEqual([]);
    // A household pass is staff-managed: its members do not list it.
    await post(t, '/v1/passes', desk, {
      holder: { kind: 'household', householdId: fam.householdId },
    });
    expect((await myPasses(fam.guardian)).body).toEqual([]);
    // A desk member reading their own passes sees nothing of anyone else's.
    expect((await myPasses(desk)).body).toEqual([]);
  });

  it('§4.14: the pass reference is never returned after issue', async () => {
    const holder = await adultCustomer(t);
    const issued = await post(t, '/v1/passes', holder, {
      holder: { kind: 'person', personId: holder.personId },
    });
    const reference = issued.body.reference as string;
    expect(reference).toMatch(/^spp_/);
    const reads = [
      await myPasses(holder),
      await post(t, `/v1/passes/${issued.body.pass.id}/revoke`, holder, {
        reason: 'Lost my phone',
        expectedRevision: 1,
      }),
      await myPasses(holder),
    ];
    for (const read of reads) {
      expect(read.status, JSON.stringify(read.body)).toBeLessThan(300);
      expect(JSON.stringify(read.body)).not.toContain(reference);
    }
    // Only the hash is stored; neither audit nor events carry the reference.
    const stored = await t.db
      .selectFrom('passes')
      .selectAll()
      .where('id', '=', issued.body.pass.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored)).not.toContain(reference);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', issued.body.pass.id)
      .execute();
    expect(JSON.stringify(audit)).not.toContain(reference);
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', issued.body.pass.id)
      .execute();
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(reference);
  });

  it('SPK-ENTRY-004 / ENT-01: a scan carries a held check-in’s revision, so it is re-checked without another read', async () => {
    const child = await createPersonFixture(t, { kind: 'child', givenName: 'Cleo' });
    await enroll(t, p, child, fam.guardian.personId, { acknowledge: false });
    const held = await post(t, '/v1/session-checkins', desk, {
      personId: child,
      activity: sessionRef(p),
    });
    expect(held.body.status).toBe('held');
    const pass = await post(t, '/v1/passes', desk, {
      holder: { kind: 'person', personId: child },
    });
    const scan = await t.http
      .post('/v1/passes/scan')
      .set(desk.header)
      .send({ reference: pass.body.reference, facilityId: t.facilityId });
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    const activity = scan.body.people[0].activities[0];
    expect(activity.checkin).toEqual({ id: held.body.id, status: 'held', revision: 1 });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: child,
      policyVersionId: p.offering.formPolicyVersionId,
      signedByPersonId: fam.guardian.personId,
    });
    const recheck = await post(t, `/v1/session-checkins/${activity.checkin.id}/recheck`, desk, {
      expectedRevision: activity.checkin.revision,
    });
    expect(recheck.status, JSON.stringify(recheck.body)).toBe(200);
    expect(recheck.body).toMatchObject({ status: 'admitted', revision: 2 });
  });

  it('SPK-UX-007 / SPK-UX-002: attendance names each participant, only after the read is authorized', async () => {
    const observed = await post(t, '/v1/attendance-observations', desk, {
      personId: fam.childA,
      activity: sessionRef(p),
      observedState: 'present',
    });
    expect(observed.status, JSON.stringify(observed.body)).toBe(201);
    const query = `/v1/attendance?activityType=session&activityId=${p.sessionId}&offeringId=${p.offering.offeringId}`;
    // The assigned coach sees names, never a bare id (SPK-UX-007).
    const coach = await staffMember(t, ['coach']);
    expect((await t.http.get(query).set(coach.header)).status).toBe(404);
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: p.sessionId,
      offeringId: p.offering.offeringId,
      personId: coach.personId,
      kind: 'coach',
      status: 'accepted',
      scheduledStart: p.start,
      scheduledEnd: p.end,
    });
    const asCoach = await t.http.get(query).set(coach.header);
    expect(asCoach.status, JSON.stringify(asCoach.body)).toBe(200);
    const ava = (asCoach.body.people as Array<Record<string, unknown>>).find(
      (x) => x.personId === fam.childA,
    );
    expect(ava).toMatchObject({ givenName: 'Ava', displayName: expect.stringContaining('Ava') });
    // A guardian reads their own child's row, named; a stranger learns nothing.
    const mine = await t.http.get(`${query}&personId=${fam.childA}`).set(fam.guardian.header);
    expect(mine.status).toBe(200);
    expect(mine.body.people).toEqual([
      expect.objectContaining({ personId: fam.childA, givenName: 'Ava' }),
    ]);
    const stranger = await adultCustomer(t);
    const probe = await t.http.get(`${query}&personId=${fam.childA}`).set(stranger.header);
    expect(probe.status).toBe(404);
    expect(JSON.stringify(probe.body)).not.toContain('Ava');
  });

  it('§4.15 / SPK-UX-008: a stored offline batch is read by its submitter and desk readers; anyone else reads NOT_FOUND', async () => {
    // The coach's own session (one accepted coach per session slot).
    const q = await program(t, manager, { from: '10:00', to: '11:15' });
    await enroll(t, q, fam.childA, fam.guardian.personId);
    t.clock.set(at(TODAY, '11:30'));
    const coach = await staffMember(t, ['coach']);
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: q.sessionId,
      offeringId: q.offering.offeringId,
      personId: coach.personId,
      kind: 'coach',
      status: 'accepted',
      scheduledStart: q.start,
      scheduledEnd: q.end,
    });
    const body = {
      deviceId: 'coach-phone',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: { reference: 'roster-0900', takenAt: at(TODAY, '09:00') },
      items: [
        {
          kind: 'attendance',
          clientObservationId: newId(),
          observedAt: at(TODAY, '10:05'),
          personId: fam.childA,
          activity: sessionRef(q),
          observedState: 'present',
        },
        // A field device may not record arrivals: rejected, and the read says so.
        {
          kind: 'arrival',
          clientObservationId: newId(),
          observedAt: at(TODAY, '09:55'),
          personId: fam.childA,
          visitorCategory: 'participant',
        },
      ],
    };
    const uploaded = await post(t, '/v1/offline-sync', coach, body);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const read = (actor: Actor, id = uploaded.body.id as string) =>
      t.http.get(`/v1/offline-sync/${id}`).set(actor.header);

    const bySubmitter = await read(coach);
    expect(bySubmitter.status, JSON.stringify(bySubmitter.body)).toBe(200);
    expect(bySubmitter.body).toEqual({ ...uploaded.body, replayed: false });
    expect(bySubmitter.body.items.map((i: { outcome: string }) => i.outcome)).toEqual([
      'accepted',
      'rejected',
    ]);
    expect((await read(desk)).body.counts).toMatchObject({ accepted: 1, rejected: 1 });
    const support = await staffMember(t, ['support_operator']);
    expect((await read(support)).status).toBe(200);
    // Another coach, a customer, a desk member of another facility and an unknown id: not found.
    const otherCoach = await staffMember(t, ['coach']);
    expect((await read(otherCoach)).status).toBe(404);
    expect((await read(fam.guardian)).status).toBe(404);
    const elsewhere = await staffMember(t, ['front_desk'], { facilityIds: [newId()] });
    expect((await read(elsewhere)).status).toBe(404);
    expect((await read(desk, newId())).status).toBe(404);
  });

  it('§5.2 / DEC-023: the fake access-control adapter is registered at the hardware gate and never allowed in production', async () => {
    const registered = t.app
      .get<IntegrationRegistryPort>(INTEGRATION_REGISTRY)
      .list()
      .filter((r) => r.gate === 'hardware');
    expect(registered).toEqual([
      {
        id: 'entry.access_device',
        gate: 'hardware',
        port: 'ACCESS_DEVICE_PORT',
        adapter: { name: 'fake-access-control', kind: 'fake' },
        productionAllowed: false,
        scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
        reconciliationOwner: 'facilities_operator',
      },
    ]);
    const admin = await staffMember(t, ['system_administrator']);
    const described = await t.http.get('/v1/admin/integrations').set(admin.header);
    expect(described.status, JSON.stringify(described.body)).toBe(200);
    const gate = described.body.gates.find((g: { gate: string }) => g.gate === 'hardware');
    expect(gate).toMatchObject({ decisionRef: 'DEC-023', status: 'pending_decision' });
    expect(gate.adapters.map((a: { id: string }) => a.id)).toEqual(['entry.access_device']);
  });
});
