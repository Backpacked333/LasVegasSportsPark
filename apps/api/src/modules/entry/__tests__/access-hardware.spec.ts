import { newId, systemPrincipal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import {
  FAKE_ACCESS_CONTROL_SIGNATURE_HEADER,
  FakeAccessControlProvider,
} from '../providers/fake-access-control.provider';
import { DeviceCommandQueue } from '../services/device-command-queue';
import { createPassFixture } from '../testing/entry-fixtures';
import {
  drainInbox,
  drainOutbox,
  entryTestApp,
  exceptionsOf,
  expectPgError,
  family,
  post,
  staffMember,
  type Actor,
} from './support';

const UNIQUE = '23505';
const CHECK = '23514';
const ACTOR = { kind: 'system', actorLabel: 'hardware-test' };
const ALWAYS = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '24:00' },
];

/** The shared steps of the access hardware tests (ENT-05). */
function hardware(t: () => TestApp) {
  const app = () => t();
  return {
    fake: () => app().app.get(FakeAccessControlProvider),
    register: (actor: Actor, body: Record<string, unknown> = {}) =>
      post(app(), '/v1/access-devices', actor, {
        facilityId: app().facilityId,
        kind: 'turnstile',
        name: 'North turnstile',
        providerDeviceRef: `ref-${newId()}`,
        ...body,
      }),
    commands: async (deviceId: string) =>
      app()
        .db.selectFrom('device_commands')
        .selectAll()
        .where('device_id', '=', deviceId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    deliver: async () => {
      const [summary] = await app().runPeriodicJobs(['entry.deliver_device_commands']);
      expect(summary, JSON.stringify(summary)).toMatchObject({ ran: true, failed: false });
      return summary!;
    },
    detect: async () => {
      const [summary] = await app().runPeriodicJobs(['entry.detect_device_outages']);
      expect(summary, JSON.stringify(summary)).toMatchObject({ ran: true, failed: false });
      return summary!;
    },
    webhook: (event: { body: unknown; signature: string }) =>
      app()
        .http.post('/v1/webhooks/access-control/fake-access-control')
        .set(FAKE_ACCESS_CONTROL_SIGNATURE_HEADER, event.signature)
        .send(event.body as object),
  };
}

describe('access devices and policies (ENT-05, §3.16 Access hardware)', () => {
  let t: TestApp;
  let operator: Actor;
  let second: Actor;
  let desk: Actor;
  const h = hardware(() => t);

  beforeAll(async () => {
    t = await entryTestApp();
    await t.enableCapability('access_hardware');
    operator = await staffMember(t, ['facilities_operator']);
    second = await staffMember(t, ['general_manager']);
    desk = await staffMember(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('DEC-016: registering a device while access_hardware is disabled answers CAPABILITY_DISABLED; revocation commands for existing devices still go out', async () => {
    const registered = await h.register(operator, { providerDeviceRef: 'turnstile-east' });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    const deviceId = registered.body.id as string;
    await h.deliver();
    await t.disableCapability('access_hardware');
    try {
      const refused = await h.register(operator);
      expect(refused.status).toBe(403);
      expect(refused.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'access_hardware',
        applicabilityReferences: ['DEC-016', 'DEC-080'],
      });
      const rename = await t.http
        .patch(`/v1/access-devices/${deviceId}`)
        .set(operator.header)
        .set('Idempotency-Key', `k-${newId()}`)
        .send({ name: 'East gate', expectedRevision: 1 });
      expect(rename.body.details?.code).toBe('CAPABILITY_DISABLED');
      const draft = await post(t, `/v1/access-devices/${deviceId}/policies`, operator, {
        allowedHolderKinds: ['person'],
        schedule: ALWAYS,
      });
      expect(draft.body.details?.code).toBe('CAPABILITY_DISABLED');

      // A pass revoked while the capability is off is still removed from the existing device.
      const holder = await createPersonFixture(t, { kind: 'adult' });
      const pass = await post(t, '/v1/passes', desk, {
        holder: { kind: 'person', personId: holder },
      });
      const revoked = await post(t, `/v1/passes/${pass.body.pass.id}/revoke`, desk, {
        reason: 'Reported lost',
        expectedRevision: 1,
      });
      expect(revoked.status).toBe(200);
      await drainOutbox(t);
      const revocations = (await h.commands(deviceId)).filter(
        (c) => c.kind === 'revoke_credential',
      );
      expect(revocations).toEqual([
        expect.objectContaining({ pass_id: pass.body.pass.id, status: 'pending' }),
      ]);
      await h.deliver();
      expect(
        (await h.commands(deviceId)).find((c) => c.kind === 'revoke_credential'),
      ).toMatchObject({ status: 'delivered', attempts: 1, settled_by: 'adapter' });
      const sent = h.fake().commandCalls.filter((c) => c.commandId === revocations[0]!.id);
      expect(sent).toHaveLength(1);
      // Only the reference's hash travels to the device, never the reference.
      expect(sent[0]!.payload).toEqual({
        passReferenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(sent)).not.toContain(pass.body.reference);
      // Retiring is never gated either.
      const retired = await post(t, `/v1/access-devices/${deviceId}/retire`, operator, {
        reason: 'Replaced by a new gate',
        expectedRevision: 1,
      });
      expect(retired.status, JSON.stringify(retired.body)).toBe(200);
      expect(retired.body.status).toBe('retired');
    } finally {
      await t.enableCapability('access_hardware');
    }
  });

  it('§3.16: a new device is sent deny-all; an approved policy (four eyes) replaces it; retiring it without a replacement sends deny-all again', async () => {
    const registered = await h.register(operator);
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    expect(registered.body).toMatchObject({
      status: 'active',
      health: 'unknown',
      heartbeatTimeoutSeconds: null,
      activePolicyId: null,
    });
    const deviceId = registered.body.id as string;
    const initial = await h.commands(deviceId);
    expect(initial).toEqual([
      expect.objectContaining({ kind: 'sync_policy', policy_id: null, status: 'pending' }),
    ]);

    const draft = await post(t, `/v1/access-devices/${deviceId}/policies`, operator, {
      allowedHolderKinds: ['person', 'household'],
      schedule: [{ days: ['sat', 'sun'], from: '08:00', to: '18:00' }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({
      status: 'draft',
      allowedPassStatuses: ['active'],
      authoredByPersonId: operator.personId,
      approvedByPersonId: null,
    });
    // Four eyes: the author cannot approve their own policy.
    const own = await post(t, `/v1/access-policies/${draft.body.id}/approve`, operator, {
      expectedRevision: 1,
    });
    expect(own.status).toBe(403);
    expect(own.body.details).toMatchObject({ code: 'author_cannot_approve' });
    const approved = await post(t, `/v1/access-policies/${draft.body.id}/approve`, second, {
      expectedRevision: 1,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'active',
      approvedByPersonId: second.personId,
      revision: 2,
    });
    // The undelivered deny-all is superseded by the policy's synchronization.
    const afterApproval = await h.commands(deviceId);
    expect(afterApproval.map((c) => [c.policy_id, c.status])).toEqual([
      [null, 'superseded'],
      [draft.body.id, 'pending'],
    ]);
    await h.deliver();
    const sync = (await h.commands(deviceId))[1]!;
    expect(sync.status).toBe('delivered');
    const sent = h.fake().commandCalls.find((c) => c.commandId === sync.id);
    expect(sent).toMatchObject({
      kind: 'sync_policy',
      deviceRef: registered.body.providerDeviceRef,
      payload: {
        policy: {
          policyId: draft.body.id,
          allowedHolderKinds: ['person', 'household'],
          allowedPassStatuses: ['active'],
          schedule: [{ days: ['sat', 'sun'], from: '08:00', to: '18:00' }],
          timezone: 'America/Los_Angeles',
        },
      },
    });
    // The superseded deny-all was never sent.
    expect(h.fake().commandCalls.some((c) => c.commandId === initial[0]!.id)).toBe(false);

    // A second policy replaces the first, which retires.
    const next = await post(t, `/v1/access-devices/${deviceId}/policies`, second, {
      allowedHolderKinds: ['person'],
      schedule: ALWAYS,
    });
    const swapped = await post(t, `/v1/access-policies/${next.body.id}/approve`, operator, {
      expectedRevision: 1,
    });
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    const policies = await t.http.get(`/v1/access-devices/${deviceId}/policies`).set(desk.header);
    expect(policies.body.map((p: { status: string }) => p.status)).toEqual(['retired', 'active']);

    // Retiring the active policy without a replacement sends deny-all.
    const retired = await post(t, `/v1/access-policies/${next.body.id}/retire`, operator, {
      reason: 'Closed for the season',
      expectedRevision: 2,
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.status).toBe('retired');
    const last = (await h.commands(deviceId)).at(-1)!;
    expect(last).toMatchObject({ kind: 'sync_policy', policy_id: null, status: 'pending' });
    const devices = await t.http
      .get(`/v1/access-devices?facilityId=${t.facilityId}`)
      .set(desk.header);
    expect(devices.status).toBe(200);
    expect(devices.body.items.find((d: { id: string }) => d.id === deviceId)).toMatchObject({
      activePolicyId: null,
    });
    // A withdrawn draft never becomes active.
    const draft3 = await post(t, `/v1/access-devices/${deviceId}/policies`, operator, {
      allowedHolderKinds: ['person'],
      schedule: ALWAYS,
    });
    const withdrawn = await post(t, `/v1/access-policies/${draft3.body.id}/retire`, operator, {
      reason: 'Drafted by mistake',
      expectedRevision: 1,
    });
    expect(withdrawn.body.status).toBe('retired');
    const late = await post(t, `/v1/access-policies/${draft3.body.id}/approve`, second, {
      expectedRevision: 2,
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');
    // Every change is audited.
    const audited = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', 'in', [deviceId, draft.body.id, next.body.id, draft3.body.id])
      .execute();
    expect(audited.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'entry.register_access_device',
        'entry.draft_access_policy',
        'entry.approve_access_policy',
        'entry.retire_access_policy',
      ]),
    );
  });

  it('device commands: who may act, stale revisions, duplicate references and reads', async () => {
    const byDesk = await h.register(desk);
    expect(byDesk.status).toBe(403);
    const elsewhere = await staffMember(t, ['facilities_operator'], { facilityIds: [newId()] });
    expect((await h.register(elsewhere)).status).toBe(403);
    const device = await h.register(operator, { providerDeviceRef: 'gate-west' });
    const duplicate = await h.register(second, { providerDeviceRef: 'gate-west' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.details).toMatchObject({ code: 'device_ref_in_use' });
    const patch = (body: object) =>
      t.http
        .patch(`/v1/access-devices/${device.body.id}`)
        .set(operator.header)
        .set('Idempotency-Key', `k-${newId()}`)
        .send(body);
    const renamed = await patch({
      name: 'West gate',
      heartbeatTimeoutSeconds: 300,
      expectedRevision: 1,
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'West gate',
      heartbeatTimeoutSeconds: 300,
      revision: 2,
    });
    expect((await patch({ name: 'Again', expectedRevision: 1 })).body.code).toBe('STALE_REVISION');
    expect((await patch({ heartbeatTimeoutSeconds: 0, expectedRevision: 2 })).status).toBe(400);
    const cleared = await patch({ heartbeatTimeoutSeconds: null, expectedRevision: 2 });
    expect(cleared.body.heartbeatTimeoutSeconds).toBeNull();
    const commands = await t.http
      .get(`/v1/access-devices/${device.body.id}/commands`)
      .set(desk.header);
    expect(commands.status).toBe(200);
    expect(commands.body.items).toEqual([
      expect.objectContaining({ kind: 'sync_policy', policyId: null, status: 'pending' }),
    ]);
    expect(JSON.stringify(commands.body)).not.toMatch(/reference_hash|passReferenceHash/);
    const coach = await staffMember(t, ['coach']);
    expect(
      (await t.http.get(`/v1/access-devices?facilityId=${t.facilityId}`).set(coach.header)).status,
    ).toBe(403);
    expect(
      (await t.http.get(`/v1/access-devices/${newId()}/commands`).set(desk.header)).status,
    ).toBe(404);
  });
});

describe('device command delivery, receipts and outages (ENT-05)', () => {
  let t: TestApp;
  let operator: Actor;
  const h = hardware(() => t);

  beforeAll(async () => {
    t = await entryTestApp();
    await t.enableCapability('access_hardware');
    operator = await staffMember(t, ['facilities_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.11 / IF-38: a failed command retries; a lost answer stays unknown until the receipt settles it once; undelivered commands escalate once', async () => {
    const lost = await h.register(operator, { providerDeviceRef: 'door-1' });
    const [command] = await h.commands(lost.body.id);
    // Three attempts with no answer. The first retry goes out on the next run; the next one waits
    // for the backoff (ENTRY_DEVICE_COMMAND_RETRY_BASE_SECONDS, technical default 30, ASYNC-02).
    h.fake().scriptCommands('timeout', 'timeout', 'timeout');
    const attemptsOf = async () => (await h.commands(lost.body.id))[0];
    await h.deliver();
    expect(await attemptsOf()).toMatchObject({ status: 'unknown', attempts: 1, settled_by: null });
    await h.deliver();
    expect(await attemptsOf()).toMatchObject({ status: 'unknown', attempts: 2, settled_by: null });
    await h.deliver();
    expect(await attemptsOf()).toMatchObject({ attempts: 2 });
    t.clock.advance(29_000);
    await h.deliver();
    expect(await attemptsOf()).toMatchObject({ attempts: 2 });
    t.clock.advance(1_000);
    await h.deliver();
    expect(await attemptsOf()).toMatchObject({ status: 'unknown', attempts: 3, settled_by: null });
    const escalated = await exceptionsOf(t, 'entry.device_command_undelivered');
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({
      owner_queue: 'facilities_operator',
      affected_id: command!.id,
      status: 'open',
    });
    // The device's receipt settles it; the duplicate receipt changes nothing.
    const receipt = h.fake().commandReceipt({
      organizationId: t.organizationId,
      commandId: command!.id,
      outcome: 'delivered',
    });
    expect((await h.webhook(receipt)).status).toBe(202);
    const again = await h.webhook(receipt);
    expect(again.body.duplicate).toBe(true);
    await drainInbox(t);
    const [settled] = await h.commands(lost.body.id);
    expect(settled).toMatchObject({ status: 'delivered', settled_by: 'receipt', attempts: 3 });
    // A late receipt under another event id (a re-sent message) changes nothing either.
    await h.webhook(
      h.fake().commandReceipt({
        organizationId: t.organizationId,
        commandId: command!.id,
        outcome: 'failed',
      }),
    );
    await drainInbox(t);
    const [still] = await h.commands(lost.body.id);
    expect(still).toEqual(settled);
    expect((await exceptionsOf(t, 'entry.device_command_undelivered'))[0]!.status).toBe('resolved');
    // Delivered commands are not sent again.
    const calls = h.fake().commandCalls.filter((c) => c.commandId === command!.id).length;
    await h.deliver();
    expect(h.fake().commandCalls.filter((c) => c.commandId === command!.id)).toHaveLength(calls);

    // A refused command is recorded as failed and retried; the device refuses it again.
    const refusing = await h.register(operator, { providerDeviceRef: 'door-2' });
    h.fake().scriptCommands('fail');
    await h.deliver();
    const [failed] = await h.commands(refusing.body.id);
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 1,
      settled_by: 'adapter',
      last_error: expect.stringContaining('refused'),
    });
    await h.deliver();
    expect((await h.commands(refusing.body.id))[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
    });
    // A retired device is no longer sent anything, even once its retry is due.
    await post(t, `/v1/access-devices/${refusing.body.id}/retire`, operator, {
      reason: 'Removed from the wall',
      expectedRevision: 1,
    });
    t.clock.advance(10 * 60_000);
    await h.deliver();
    expect((await h.commands(refusing.body.id))[0]).toMatchObject({ attempts: 2 });
  });

  it('§3.16 outages: a heartbeat marks a device online; it goes offline only when its configured timeout passes', async () => {
    const timed = await h.register(operator, {
      providerDeviceRef: 'scanner-1',
      kind: 'scanner',
      heartbeatTimeoutSeconds: 120,
    });
    const untimed = await h.register(operator, { providerDeviceRef: 'scanner-2', kind: 'scanner' });
    const health = async (id: string) =>
      (
        await t.db
          .selectFrom('access_devices')
          .select(['health', 'last_heartbeat_at'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).health;
    const beat = async (deviceRef: string, at = t.clock.now().toISOString()) => {
      expect(
        (await h.webhook(h.fake().heartbeat({ organizationId: t.organizationId, deviceRef, at })))
          .status,
      ).toBe(202);
      await drainInbox(t);
    };
    await beat('scanner-1');
    await beat('scanner-2');
    expect(await health(timed.body.id)).toBe('online');
    expect(await health(untimed.body.id)).toBe('online');
    // Within the timeout nothing changes.
    t.clock.advance(60_000);
    expect((await h.detect()).processed).toBe(0);
    // Past it, the timed device goes offline once; the untimed one is never judged.
    t.clock.advance(5 * 60_000);
    expect((await h.detect()).processed).toBe(1);
    expect(await h.detect()).toMatchObject({ processed: 0 });
    expect(await health(timed.body.id)).toBe('offline');
    expect(await health(untimed.body.id)).toBe('online');
    const offline = await exceptionsOf(t, 'entry.device_offline');
    expect(offline).toEqual([
      expect.objectContaining({
        affected_id: timed.body.id,
        owner_queue: 'facilities_operator',
        status: 'open',
      }),
    ]);
    // An older heartbeat delivered late proves nothing.
    await beat('scanner-1', new Date(t.clock.now().getTime() - 10 * 60_000).toISOString());
    expect(await health(timed.body.id)).toBe('offline');
    // A fresh heartbeat brings it back and resolves the outage.
    await beat('scanner-1');
    expect(await health(timed.body.id)).toBe('online');
    expect((await exceptionsOf(t, 'entry.device_offline'))[0]!.status).toBe('resolved');
    const changes = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'entry.access_device_changed')
      .where('aggregate_id', '=', timed.body.id)
      .execute();
    expect(changes.map((c) => (c.payload as { change: string }).change)).toEqual([
      'registered',
      'online',
      'offline',
      'online',
    ]);
    // A device that never sent a heartbeat and has no timeout stays unknown.
    const silent = await h.register(operator, { providerDeviceRef: 'scanner-3', kind: 'scanner' });
    t.clock.advance(24 * 60 * 60_000);
    await h.detect();
    expect(await health(silent.body.id)).toBe('unknown');
  });
});

describe('ASYNC-02: device command delivery is fair across devices and backs off (§3.16 revocation, §4.12)', () => {
  let t: TestApp;
  let operator: Actor;
  const h = hardware(() => t);

  beforeAll(async () => {
    t = await entryTestApp();
    await t.enableCapability('access_hardware');
    operator = await staffMember(t, ['facilities_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  /** Revokes new passes the way `entry.queue_device_revocations` does (every active device). */
  const revokePasses = async (count: number) => {
    const holder = await createPersonFixture(t, { kind: 'adult' });
    const queue = t.app.get(DeviceCommandQueue);
    const system = systemPrincipal(t.organizationId, 'entry.queue_device_revocations');
    for (let i = 0; i < count; i += 1) {
      const { passId } = await createPassFixture(t, { personId: holder });
      await t.app
        .get(UnitOfWork)
        .run(({ trx }) => queue.revokeCredential(trx, system, t.organizationId, passId, null));
    }
  };
  const sentTo = (deviceRef: string) =>
    h.fake().commandCalls.filter((c) => c.deviceRef === deviceRef).length;

  it('§3.16: a revocation reaches a healthy device while an unreachable one has a backlog larger than a run; the backlog is retried with backoff, not every pass', async () => {
    const dead = await h.register(operator, { providerDeviceRef: 'dead-door', kind: 'door' });
    await h.deliver(); // its deny-all, while it still answers
    // The door goes down; 61 passes are revoked while it is the only device.
    h.fake().scriptDevice('dead-door', 'timeout');
    await revokePasses(61);
    t.clock.advance(1_000);
    // A healthy door is registered and one more pass is revoked: its two commands are the newest.
    const healthy = await h.register(operator, { providerDeviceRef: 'healthy-door', kind: 'door' });
    await revokePasses(1);
    const backlog = async () =>
      (await h.commands(dead.body.id)).filter((c) => c.kind === 'revoke_credential');
    expect(await backlog()).toHaveLength(62);

    const first = await h.deliver();
    // The healthy door's commands go out in the first pass, ahead of the unreachable door's backlog.
    const healthyCommands = await h.commands(healthy.body.id);
    expect(healthyCommands).toHaveLength(2);
    expect(healthyCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'sync_policy', status: 'delivered', attempts: 1 }),
        expect.objectContaining({ kind: 'revoke_credential', status: 'delivered', attempts: 1 }),
      ]),
    );
    // Every backlog command was tried, and retried once at most in the run: 124 sends, not 500.
    expect((await backlog()).map((c) => [c.status, c.attempts])).toEqual(
      Array.from({ length: 62 }, () => ['unknown', 2]),
    );
    expect(sentTo('dead-door')).toBe(1 + 62 * 2);
    expect(first).toMatchObject({ processed: 2 + 62 * 2, remaining: 0 });

    // Before the backoff has passed, nothing is sent again.
    expect(await h.deliver()).toMatchObject({ processed: 0 });
    expect(sentTo('dead-door')).toBe(1 + 62 * 2);

    // A new revocation while the whole backlog is due again still reaches the healthy door first.
    t.clock.advance(30_000);
    await revokePasses(1);
    const healthyBefore = sentTo('healthy-door');
    await h.deliver();
    expect(sentTo('healthy-door')).toBe(healthyBefore + 1);
    expect((await h.commands(healthy.body.id)).map((c) => c.status)).toEqual([
      'delivered',
      'delivered',
      'delivered',
    ]);
    const after = await backlog();
    expect(after.filter((c) => c.attempts === 3)).toHaveLength(62);
    expect(after.filter((c) => c.attempts === 2)).toHaveLength(1); // the newest: tried twice
    // Escalation names the unreachable door's commands, one exception each; none for the healthy one.
    const escalated = await exceptionsOf(t, 'entry.device_command_undelivered');
    expect(escalated).toHaveLength(62);
    expect(new Set(escalated.map((e) => e.affected_id))).toEqual(
      new Set(after.filter((c) => c.attempts === 3).map((c) => c.id)),
    );

    // The retry after a third attempt waits twice as long (60 s); the newest one is due after 30 s.
    const sent = sentTo('dead-door');
    t.clock.advance(30_000);
    await h.deliver();
    expect(sentTo('dead-door')).toBe(sent + 1);
    t.clock.advance(30_000);
    await h.deliver();
    expect(sentTo('dead-door')).toBe(sent + 1 + 62);

    // The door comes back: the backlog is delivered once its retries are due.
    h.fake().scriptDevice('dead-door', null);
    t.clock.advance(5 * 60_000);
    await h.deliver();
    expect((await backlog()).every((c) => c.status === 'delivered')).toBe(true);
  });

  it('the backoff is capped at ENTRY_DEVICE_COMMAND_RETRY_MAX_SECONDS (300 s) however many attempts were made', async () => {
    const flaky = await h.register(operator, { providerDeviceRef: 'flaky-door', kind: 'door' });
    h.fake().scriptDevice('flaky-door', 'timeout');
    await h.deliver();
    const [command] = await h.commands(flaky.body.id);
    expect(command).toMatchObject({ status: 'unknown', attempts: 1 });
    await t.db
      .updateTable('device_commands')
      .set({ attempts: 1_000, last_attempt_at: t.clock.now() })
      .where('id', '=', command!.id)
      .execute();
    t.clock.advance(299_000);
    await h.deliver();
    expect((await h.commands(flaky.body.id))[0]).toMatchObject({ attempts: 1_000 });
    t.clock.advance(1_000);
    await h.deliver();
    expect((await h.commands(flaky.body.id))[0]).toMatchObject({ attempts: 1_001 });
  });
});

describe('access events from devices (ENT-05, SPK-COND-004)', () => {
  let t: TestApp;
  let operator: Actor;
  const h = hardware(() => t);

  beforeAll(async () => {
    t = await entryTestApp();
    await t.enableCapability('access_hardware');
    operator = await staffMember(t, ['facilities_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  const granted = (deviceId: string, personId?: string) =>
    h.fake().granted({
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      deviceId,
      occurredAt: t.clock.now().toISOString(),
      ...(personId ? { personId } : {}),
      visitorCategory: 'guardian',
    });
  const visitsOf = (personId: string) =>
    t.db.selectFrom('visits').selectAll().where('person_id', '=', personId).execute();

  it('before any device is registered, events are recorded as before and no reference is reconciled', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    await h.webhook(granted('legacy-turnstile', person));
    await drainInbox(t);
    expect(await visitsOf(person)).toEqual([
      expect.objectContaining({ source: 'access_control', access_device_id: null }),
    ]);
    expect(await exceptionsOf(t, 'entry.unregistered_access_device')).toEqual([]);
  });

  it('SPK-COND-004: a device access event records an arrival and no attendance, check-in or release', async () => {
    const desk = await staffMember(t, ['front_desk']);
    const fam = await family(t, desk);
    const device = await h.register(operator, { providerDeviceRef: 'turnstile-main' });
    expect(device.status, JSON.stringify(device.body)).toBe(201);
    await h.webhook(granted('turnstile-main', fam.childA));
    await drainInbox(t);
    expect(await visitsOf(fam.childA)).toEqual([
      expect.objectContaining({
        source: 'access_control',
        access_device_id: device.body.id,
        visitor_category: 'guardian',
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
    const listed = await t.http
      .get(`/v1/visits?facilityId=${t.facilityId}&personId=${fam.childA}`)
      .set(desk.header);
    expect(listed.body.items[0]).toMatchObject({ accessDeviceId: device.body.id });
  });

  it('an unregistered or retired reference still yields an arrival and one exception per reference', async () => {
    const people = await Promise.all(
      [1, 2, 3].map(() => createPersonFixture(t, { kind: 'adult' })),
    );
    await h.webhook(granted('side-door', people[0]));
    await h.webhook(granted('side-door', people[1]));
    const retired = await h.register(operator, { providerDeviceRef: 'old-gate' });
    await post(t, `/v1/access-devices/${retired.body.id}/retire`, operator, {
      reason: 'Decommissioned',
      expectedRevision: 1,
    });
    await h.webhook(granted('old-gate', people[2]));
    await drainInbox(t);
    for (const person of people) {
      expect(await visitsOf(person)).toEqual([
        expect.objectContaining({ source: 'access_control', access_device_id: null }),
      ]);
    }
    const raised = await exceptionsOf(t, 'entry.unregistered_access_device');
    expect(raised.map((e) => e.affected_id).sort()).toEqual(['old-gate', 'side-door']);
    expect(raised.find((e) => e.affected_id === 'old-gate')!.details).toMatchObject({
      registeredDeviceId: retired.body.id,
      registeredStatus: 'retired',
    });
  });
});

describe('access hardware schema invariants (migration 0805)', () => {
  let t: TestApp;
  let author: string;
  let approver: string;
  let deviceId: string;
  let passId: string;

  beforeAll(async () => {
    t = await entryTestApp();
    author = await createPersonFixture(t, { kind: 'adult' });
    approver = await createPersonFixture(t, { kind: 'adult' });
    deviceId = newId();
    await t.db
      .insertInto('access_devices')
      .values(deviceRow({ id: deviceId, provider_device_ref: 'schema-device' }))
      .execute();
    passId = newId();
    await t.db
      .insertInto('passes')
      .values({
        id: passId,
        organization_id: t.organizationId,
        holder_kind: 'person',
        holder_person_id: author,
        holder_household_id: null,
        reference_hash: 'a'.repeat(64),
        issued_at: t.clock.now(),
        issued_by: json(ACTOR),
        issued_by_person_id: null,
        revoked_at: null,
        revoked_by: null,
        revoked_reason: null,
      })
      .execute();
  });
  afterAll(async () => {
    await t.close();
  });

  function deviceRow(overrides: Record<string, unknown> = {}) {
    return {
      id: newId(),
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      kind: 'door' as const,
      name: 'Door',
      provider_device_ref: `ref-${newId()}`,
      heartbeat_timeout_seconds: null,
      last_heartbeat_at: null,
      registered_at: t.clock.now(),
      registered_by: json(ACTOR),
      registered_by_person_id: null,
      retired_at: null,
      retired_reason: null,
      ...overrides,
    };
  }
  function policyRow(overrides: Record<string, unknown> = {}) {
    return {
      id: newId(),
      organization_id: t.organizationId,
      device_id: deviceId,
      facility_id: t.facilityId,
      allowed_holder_kinds: ['person'] as Array<'person' | 'household'>,
      allowed_pass_statuses: ['active'] as Array<'active'>,
      schedule: json(ALWAYS),
      authored_by: json(ACTOR),
      authored_by_person_id: author,
      approved_by: null,
      approved_by_person_id: null,
      approved_at: null,
      retired_at: null,
      retired_reason: null,
      ...overrides,
    };
  }
  function commandRow(overrides: Record<string, unknown> = {}) {
    return {
      id: newId(),
      organization_id: t.organizationId,
      device_id: deviceId,
      kind: 'sync_policy' as const,
      pass_id: null,
      policy_id: null,
      policy_snapshot: null,
      last_error: null,
      last_attempt_at: null,
      delivered_at: null,
      settled_by: null,
      escalation_exception_id: null,
      requested_by: json(ACTOR),
      created_at: t.clock.now(),
      ...overrides,
    };
  }
  const approval = (by: string) => ({
    status: 'active' as const,
    approved_by: json(ACTOR),
    approved_by_person_id: by,
    approved_at: t.clock.now(),
  });

  it('the author of a policy cannot approve it (database check)', async () => {
    const id = newId();
    await t.db.insertInto('access_policies').values(policyRow({ id })).execute();
    await expectPgError(
      t.db.updateTable('access_policies').set(approval(author)).where('id', '=', id).execute(),
      CHECK,
    );
    // An active policy always has an approver.
    await expectPgError(
      t.db
        .insertInto('access_policies')
        .values(policyRow({ status: 'active' }))
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('access_policies')
      .set(approval(approver))
      .where('id', '=', id)
      .execute();
    // One active policy per device.
    const second = newId();
    await t.db
      .insertInto('access_policies')
      .values(policyRow({ id: second }))
      .execute();
    await expectPgError(
      t.db
        .updateTable('access_policies')
        .set(approval(approver))
        .where('id', '=', second)
        .execute(),
      UNIQUE,
    );
    // A policy admits active passes only, and its content never changes.
    await expectPgError(
      t.db
        .insertInto('access_policies')
        .values(policyRow({ allowed_pass_statuses: ['active', 'revoked'] }))
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('access_policies')
        .set({ allowed_holder_kinds: ['household'] })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    // Retired is final.
    await t.db
      .updateTable('access_policies')
      .set({ status: 'retired', retired_at: t.clock.now(), retired_reason: 'done' })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db.updateTable('access_policies').set({ status: 'active' }).where('id', '=', id).execute(),
      CHECK,
    );
  });

  it('devices: a positive heartbeat timeout, one reference per organization, retirement is final', async () => {
    await expectPgError(
      t.db
        .insertInto('access_devices')
        .values(deviceRow({ heartbeat_timeout_seconds: 0 }))
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .insertInto('access_devices')
        .values(deviceRow({ provider_device_ref: 'schema-device' }))
        .execute(),
      UNIQUE,
    );
    const id = newId();
    await t.db.insertInto('access_devices').values(deviceRow({ id })).execute();
    await t.db
      .updateTable('access_devices')
      .set({ status: 'retired', retired_at: t.clock.now(), retired_reason: 'gone' })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db
        .updateTable('access_devices')
        .set({ status: 'active', retired_at: null, retired_reason: null })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('access_devices')
        .set({ provider_device_ref: 'moved' })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(t.db.deleteFrom('access_devices').where('id', '=', id).execute(), '23001');
  });

  it('commands: one revocation per device and pass, transitions follow DeviceCommandMachine', async () => {
    const revoke = { kind: 'revoke_credential' as const, pass_id: passId };
    await t.db.insertInto('device_commands').values(commandRow(revoke)).execute();
    await expectPgError(
      t.db.insertInto('device_commands').values(commandRow(revoke)).execute(),
      UNIQUE,
    );
    // A revocation names a pass; a sync never does.
    await expectPgError(
      t.db
        .insertInto('device_commands')
        .values(commandRow({ kind: 'revoke_credential' }))
        .execute(),
      CHECK,
    );
    const id = newId();
    await t.db.insertInto('device_commands').values(commandRow({ id })).execute();
    await t.db
      .updateTable('device_commands')
      .set({ status: 'delivered', delivered_at: t.clock.now(), settled_by: 'adapter' })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db
        .updateTable('device_commands')
        .set({ status: 'pending', delivered_at: null, settled_by: null })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    // Only a policy synchronization is ever superseded.
    const revokeId = (
      await t.db
        .selectFrom('device_commands')
        .select('id')
        .where('kind', '=', 'revoke_credential')
        .executeTakeFirstOrThrow()
    ).id;
    await expectPgError(
      t.db
        .updateTable('device_commands')
        .set({ status: 'superseded' })
        .where('id', '=', revokeId)
        .execute(),
      CHECK,
    );
  });

  it('SPK-COND-004 (0805): only an access-control arrival names a device, and the device never changes', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const base = {
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      person_id: person,
      visitor_description: null,
      party_size: 1,
      visitor_category: 'guardian' as const,
      arrived_at: t.clock.now(),
      pass_id: null,
      device_id: null,
      client_observation_id: null,
      sync_batch_id: null,
      departed_at: null,
      voided_at: null,
      void_reason: null,
      recorded_by: json(ACTOR),
      recorded_by_person_id: null,
      received_at: t.clock.now(),
    };
    await expectPgError(
      t.db
        .insertInto('visits')
        .values({
          ...base,
          id: newId(),
          source: 'desk',
          access_event_ref: null,
          access_device_id: deviceId,
        })
        .execute(),
      CHECK,
    );
    const id = newId();
    await t.db
      .insertInto('visits')
      .values({
        ...base,
        id,
        source: 'access_control',
        access_event_ref: `test:${newId()}`,
        access_device_id: deviceId,
      })
      .execute();
    await expectPgError(
      t.db.updateTable('visits').set({ access_device_id: null }).where('id', '=', id).execute(),
      CHECK,
    );
  });
});
