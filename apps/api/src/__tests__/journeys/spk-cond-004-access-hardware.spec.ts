import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
} from '../../modules/catalog';
import { createEnrollmentFixture } from '../../modules/enrollment';
import { createRelationshipFixture } from '../../modules/identity';
import {
  FAKE_ACCESS_CONTROL_SIGNATURE_HEADER,
  FakeAccessControlProvider,
} from '../../modules/entry/providers/fake-access-control.provider';
import { at } from '../../modules/scheduling';
import { createAssignmentFixture } from '../../modules/workforce';
import {
  adult,
  child,
  enableCapability,
  get,
  journeyApp,
  ok,
  patch,
  post,
  processInbox,
  staff,
  type Actor,
} from './support';

/**
 * SPK-COND-004 (§3.16 Access hardware, DEC-080, DEC-016) across entry, identity, catalog,
 * enrollment, workforce and the kernel inbox, outbox and periodic jobs, on the assembled
 * application. The fake access-control provider stands in for the unselected vendor (DEC-023): it
 * signs the webhooks a controller would post and answers device commands as scripted.
 */

/** Saturday 2027-01-16, 09:00 in Los Angeles (the test facility's zone). */
const CLOCK_START = '2027-01-16T17:00:00Z';
const TODAY = '2027-01-16';

interface Device {
  id: string;
  providerDeviceRef: string;
}

interface Command {
  id: string;
  kind: 'revoke_credential' | 'sync_policy';
  passId: string | null;
  policyId: string | null;
  status: string;
  attempts: number;
}

interface Exception {
  id: string;
  category: string;
  status: string;
  affected: { type: string; id: string } | null;
}

function hardware(t: TestApp) {
  const fake = () => t.app.get(FakeAccessControlProvider);
  return {
    fake,
    register: (operator: Actor, providerDeviceRef: string, extra: object = {}) =>
      post(t, '/v1/access-devices', operator.header, {
        facilityId: t.facilityId,
        kind: 'turnstile',
        name: `Gate ${providerDeviceRef}`,
        providerDeviceRef,
        ...extra,
      }),
    /** The device's commands, oldest first (the read lists the newest first). */
    commands: async (reader: Actor, deviceId: string) =>
      (
        await ok<{ items: Command[] }>(
          get(t, `/v1/access-devices/${deviceId}/commands`, reader.header),
        )
      ).items.reverse(),
    deliver: async () => {
      const [summary] = await t.runPeriodicJobs(['entry.deliver_device_commands']);
      expect(summary, JSON.stringify(summary)).toMatchObject({ ran: true, failed: false });
    },
    detect: async () => {
      const [summary] = await t.runPeriodicJobs(['entry.detect_device_outages']);
      expect(summary, JSON.stringify(summary)).toMatchObject({ ran: true, failed: false });
      return summary!;
    },
    /** Posts a signed provider webhook (no session, no idempotency key: the inbox dedupes it). */
    webhook: (event: { body: unknown; signature: string }) =>
      t.http
        .post('/v1/webhooks/access-control/fake-access-control')
        .set(FAKE_ACCESS_CONTROL_SIGNATURE_HEADER, event.signature)
        .send(event.body as object),
    exceptions: async (reader: Actor, category: string, status = 'open') =>
      (
        await ok<{ items: Exception[] }>(
          get(
            t,
            `/v1/exceptions?queue=facilities_operator&status=${status}&limit=100`,
            reader.header,
          ),
        )
      ).items.filter((e) => e.category === category),
  };
}

describe('SPK-COND-004: access hardware (assembled application)', () => {
  it('a device is synced deny-all, then a policy a second person approved; an access event records an arrival only; a revoked pass reaches every device once', async () => {
    const t = await journeyApp({ clockStart: CLOCK_START });
    try {
      const h = hardware(t);
      const admin = await staff(t, ['system_administrator']);
      const operator = await staff(t, ['facilities_operator']);
      const manager = await staff(t, ['general_manager']);
      const desk = await staff(t, ['front_desk']);

      // DEC-016: switched off, nothing can be registered; the administrator enables it (DEC-080).
      const refused = await h.register(operator, 'turnstile-main');
      expect(refused.status).toBe(403);
      expect(refused.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'access_hardware',
      });
      await enableCapability(t, admin, 'access_hardware', 'DEC-080');

      // A new device is sent deny-all until a policy is approved.
      const main = await ok<Device>(h.register(operator, 'turnstile-main'), 201);
      expect(await h.commands(desk, main.id)).toEqual([
        expect.objectContaining({ kind: 'sync_policy', policyId: null, status: 'pending' }),
      ]);
      const draft = await ok<{ id: string }>(
        post(t, `/v1/access-devices/${main.id}/policies`, operator.header, {
          allowedHolderKinds: ['person'],
          schedule: [
            {
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
              from: '07:00',
              to: '22:00',
            },
          ],
        }),
        201,
      );
      // Four eyes: its author cannot approve it; a second person does.
      const own = await post(t, `/v1/access-policies/${draft.id}/approve`, operator.header, {
        expectedRevision: 1,
      });
      expect(own.status).toBe(403);
      expect(own.body.details).toMatchObject({ code: 'author_cannot_approve' });
      await ok(
        post(t, `/v1/access-policies/${draft.id}/approve`, manager.header, { expectedRevision: 1 }),
      );
      expect((await h.commands(desk, main.id)).map((c) => [c.kind, c.policyId, c.status])).toEqual([
        ['sync_policy', null, 'superseded'],
        ['sync_policy', draft.id, 'pending'],
      ]);
      await h.deliver();
      expect((await h.commands(desk, main.id))[1]).toMatchObject({
        policyId: draft.id,
        status: 'delivered',
        attempts: 1,
      });
      // The superseded deny-all was never sent.
      const sentIds = h.fake().commandCalls.map((c) => c.commandId);
      expect(sentIds).not.toContain((await h.commands(desk, main.id))[0]!.id);

      // An access event from the registered device records an arrival only: no attendance, no
      // session check-in, no release.
      const guardian = await adult(t);
      const kid = await child(t, [guardian]);
      const granted = h.fake().granted({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        deviceId: 'turnstile-main',
        occurredAt: t.clock.now().toISOString(),
        personId: kid,
      });
      expect((await h.webhook(granted)).status).toBe(202);
      expect((await h.webhook(granted)).body).toMatchObject({ duplicate: true });
      await processInbox(t);
      const visits = await ok<{ items: Array<Record<string, unknown>> }>(
        get(t, `/v1/visits?facilityId=${t.facilityId}&personId=${kid}`, desk.header),
      );
      expect(visits.items).toEqual([
        expect.objectContaining({
          source: 'access_control',
          accessDeviceId: main.id,
          status: 'on_site',
        }),
      ]);
      for (const table of [
        'attendance_observations',
        'session_checkins',
        'release_records',
        'departures',
      ] as const) {
        const rows = await t.db.selectFrom(table).select('id').execute();
        expect(rows, table).toHaveLength(0);
      }

      // A pass revocation queues one command per active device. The first answer from one device
      // is lost (unknown) and is retried; the other device's lost answer is settled by its own
      // receipt, and the duplicate receipt changes nothing.
      const side = await ok<Device>(h.register(operator, 'door-side', { kind: 'door' }), 201);
      await h.deliver(); // the side door's deny-all
      const pass = await ok<{ pass: { id: string }; reference: string }>(
        post(t, '/v1/passes', guardian.header, {
          holder: { kind: 'person', personId: guardian.personId },
        }),
        201,
      );
      await ok(
        post(t, `/v1/passes/${pass.pass.id}/revoke`, guardian.header, {
          reason: 'Lost my card',
          expectedRevision: 1,
        }),
      );
      await processInbox(t);
      const revocations = async () =>
        Object.fromEntries(
          await Promise.all(
            [main, side].map(async (d) => [
              d.providerDeviceRef,
              (await h.commands(desk, d.id)).filter((c) => c.kind === 'revoke_credential'),
            ]),
          ),
        ) as Record<string, Command[]>;
      const queued = await revocations();
      expect(queued['turnstile-main']).toEqual([
        expect.objectContaining({ passId: pass.pass.id, status: 'pending' }),
      ]);
      expect(queued['door-side']).toEqual([
        expect.objectContaining({ passId: pass.pass.id, status: 'pending' }),
      ]);
      h.fake().scriptCommands('timeout', 'timeout');
      await h.deliver();
      const unknown = await revocations();
      expect(unknown['turnstile-main']![0]).toMatchObject({ status: 'unknown', attempts: 1 });
      expect(unknown['door-side']![0]).toMatchObject({ status: 'unknown', attempts: 1 });
      // Only the hash of the reference travels to a device, never the reference.
      expect(JSON.stringify(h.fake().commandCalls)).not.toContain(pass.reference);

      const receipt = h.fake().commandReceipt({
        organizationId: t.organizationId,
        commandId: unknown['door-side']![0]!.id,
        outcome: 'delivered',
      });
      expect((await h.webhook(receipt)).status).toBe(202);
      expect((await h.webhook(receipt)).body).toMatchObject({ duplicate: true });
      await processInbox(t);
      // The next run retries the unknown turnstile command; the settled door command is not sent.
      const doorCalls = h
        .fake()
        .commandCalls.filter((c) => c.commandId === unknown['door-side']![0]!.id).length;
      await h.deliver();
      const settled = await revocations();
      expect(settled['turnstile-main']).toEqual([
        expect.objectContaining({ status: 'delivered', attempts: 2 }),
      ]);
      expect(settled['door-side']).toEqual([
        expect.objectContaining({ status: 'delivered', attempts: 1 }),
      ]);
      expect(
        h.fake().commandCalls.filter((c) => c.commandId === unknown['door-side']![0]!.id),
      ).toHaveLength(doorCalls);
      // A late receipt saying otherwise changes nothing either.
      await h.webhook(
        h.fake().commandReceipt({
          organizationId: t.organizationId,
          commandId: unknown['door-side']![0]!.id,
          outcome: 'failed',
        }),
      );
      await processInbox(t);
      expect((await revocations())['door-side']).toEqual(settled['door-side']);
      // One revocation per device and pass: revoking again is refused, nothing new is queued.
      const again = await post(t, `/v1/passes/${pass.pass.id}/revoke`, guardian.header, {
        reason: 'Lost my card',
        expectedRevision: 2,
      });
      expect(again.status).toBe(409);
      await processInbox(t);
      expect((await revocations())['turnstile-main']).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('a silent device with a configured timeout goes offline with an exception; a supervised release still needs the online collect check', async () => {
    const t = await journeyApp({ clockStart: CLOCK_START });
    try {
      const h = hardware(t);
      const admin = await staff(t, ['system_administrator']);
      const operator = await staff(t, ['facilities_operator']);
      const desk = await staff(t, ['front_desk']);
      const manager = await staff(t, ['program_manager']);
      const coach = await staff(t, ['coach']);
      await enableCapability(t, admin, 'access_hardware', 'DEC-080');

      // Outage: only a device with a configured heartbeat timeout is judged.
      const gate = await ok<Device & { revision: number }>(h.register(operator, 'gate-north'), 201);
      const untimed = await ok<Device>(h.register(operator, 'gate-south'), 201);
      await ok(
        patch(t, `/v1/access-devices/${gate.id}`, operator.header, {
          heartbeatTimeoutSeconds: 120,
          expectedRevision: gate.revision,
        }),
      );
      const beat = async (deviceRef: string, atInstant = t.clock.now().toISOString()) => {
        const event = h
          .fake()
          .heartbeat({ organizationId: t.organizationId, deviceRef, at: atInstant });
        expect((await h.webhook(event)).status).toBe(202);
        await processInbox(t);
      };
      const health = async (deviceId: string) =>
        (
          await ok<{ items: Array<{ id: string; health: string }> }>(
            get(t, `/v1/access-devices?facilityId=${t.facilityId}`, desk.header),
          )
        ).items.find((d) => d.id === deviceId)?.health;
      await beat('gate-north');
      await beat('gate-south');
      expect(await health(gate.id)).toBe('online');
      t.clock.advance(60_000);
      expect((await h.detect()).processed).toBe(0);
      t.clock.advance(5 * 60_000);
      expect((await h.detect()).processed).toBe(1);
      expect((await h.detect()).processed).toBe(0);
      expect(await health(gate.id)).toBe('offline');
      expect(await health(untimed.id)).toBe('online');
      const offline = await h.exceptions(operator, 'entry.device_offline');
      expect(offline).toEqual([
        expect.objectContaining({
          status: 'open',
          affected: expect.objectContaining({ id: gate.id }),
        }),
      ]);
      // A fresh heartbeat brings it back and resolves the outage.
      await beat('gate-north');
      expect(await health(gate.id)).toBe('online');
      expect(await h.exceptions(operator, 'entry.device_offline')).toEqual([]);
      expect(await h.exceptions(operator, 'entry.device_offline', 'resolved')).toEqual([
        expect.objectContaining({ id: offline[0]!.id }),
      ]);

      // Supervised release: a child who came through the turnstile and was admitted to a
      // supervised session leaves only through a release, decided by the online collect check.
      const offering = await createOfferingFixture(t, {
        responsibleManagerPersonId: manager.personId,
      });
      const start = at(TODAY, '10:00');
      const end = at(TODAY, '11:00');
      const sessionId = await createOfferingSessionFixture(t, {
        offeringId: offering.offeringId,
        scheduledStart: new Date(start),
        scheduledEnd: new Date(end),
      });
      const activity = { type: 'session', offeringId: offering.offeringId, sessionId };
      const guardian = await adult(t);
      const payer = await adult(t);
      const kid = await child(t, [guardian]);
      await createEnrollmentFixture(t, {
        offeringId: offering.offeringId,
        participantPersonId: kid,
        status: 'confirmed',
      });
      await createAcknowledgmentFixture(t, {
        subjectPersonId: kid,
        policyVersionId: offering.formPolicyVersionId,
        signedByPersonId: guardian.personId,
      });
      await createAssignmentFixture(t, {
        targetType: 'session',
        targetId: sessionId,
        offeringId: offering.offeringId,
        personId: coach.personId,
        kind: 'coach',
        status: 'accepted',
        scheduledStart: start,
        scheduledEnd: end,
      });
      // A caregiver who may pay and view but not collect.
      await createRelationshipFixture(t, {
        actorPersonId: payer.personId,
        subjectPersonId: kid,
        kind: 'caregiver',
        permissions: ['view', 'pay'],
      });

      await h.webhook(
        h.fake().granted({
          organizationId: t.organizationId,
          facilityId: t.facilityId,
          deviceId: 'gate-north',
          occurredAt: t.clock.now().toISOString(),
          personId: kid,
        }),
      );
      await processInbox(t);
      const visit = (
        await ok<{ items: Array<{ id: string; status: string }> }>(
          get(t, `/v1/visits?facilityId=${t.facilityId}&personId=${kid}`, desk.header),
        )
      ).items[0]!;
      const checkin = await ok<{ status: string }>(
        post(t, '/v1/session-checkins', desk.header, { personId: kid, activity }),
        201,
      );
      expect(checkin.status).toBe('admitted');
      const plain = await post(t, '/v1/departures', desk.header, { visitId: visit.id });
      expect(plain.status).toBe(409);
      expect(plain.body.details).toMatchObject({ code: 'release_required' });

      const passOf = async (holder: Actor) =>
        (
          await ok<{ reference: string }>(
            post(t, '/v1/passes', holder.header, {
              holder: { kind: 'person', personId: holder.personId },
            }),
            201,
          )
        ).reference;
      const check = (passReference: string) =>
        ok<{ mayCollect: boolean; collector: { personId: string } | null }>(
          t.http
            .post('/v1/releases/collector-checks')
            .set(coach.header)
            .send({ activity, participantPersonId: kid, passReference }),
        );
      // The pay-only caregiver's pass names nobody; the guardian's does.
      expect(await check(await passOf(payer))).toMatchObject({
        mayCollect: false,
        collector: null,
      });
      const named = await check(await passOf(guardian));
      expect(named).toMatchObject({
        mayCollect: true,
        collector: { personId: guardian.personId },
      });
      const denied = await ok<{ release: Record<string, unknown> }>(
        post(t, '/v1/releases', coach.header, {
          facilityId: t.facilityId,
          childPersonId: kid,
          collector: { personId: payer.personId },
          activity,
        }),
        201,
      );
      expect(denied.release).toMatchObject({
        verificationOutcome: 'denied',
        outcome: 'not_released',
      });
      const released = await ok<{ release: Record<string, unknown>; departure: unknown }>(
        post(t, '/v1/releases', coach.header, {
          facilityId: t.facilityId,
          childPersonId: kid,
          collector: { personId: named.collector!.personId },
          activity,
        }),
        201,
      );
      expect(released.release).toMatchObject({
        verificationMethod: 'online_relationship_check',
        verificationOutcome: 'verified',
        outcome: 'released',
        authorityBasis: 'relationship_permission:collect',
      });
      expect(released.departure).toMatchObject({ visitId: visit.id, source: 'release' });
    } finally {
      await t.close();
    }
  });
});
