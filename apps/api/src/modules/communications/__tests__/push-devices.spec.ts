import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { isCheckViolation, isUniqueViolation } from '@sportspark/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { hashToken } from '../services/calendar-feeds.service';
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
  dispatchOutbox,
  fakeProviders,
  type FakeProviders,
} from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;

/**
 * COM-01: push device registration (SPK-UX-001), device addressing for the push channel
 * (SPK-COMMS-003/004) and revocation on account recovery (SPK-IAM-006, SPK-AT-025). The push
 * provider is the deterministic fake (§5.2, DEC-020), fanning out per registered device.
 */
describe('push devices (COM-01: SPK-UX-001, SPK-COMMS-003/004, SPK-AT-025)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let fakes: FakeProviders;

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    fakes = fakeProviders(t.app);
  });
  beforeEach(() => {
    fakes.push.reset();
    fakes.email.reset();
  });
  afterAll(async () => {
    await t.close();
  });

  async function customer() {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    const account = await createAccountFixture(t, { personId });
    return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
  }

  const register = (header: { Authorization: string }, body: object) =>
    t.http.post('/v1/me/push-devices').set(header).set('Idempotency-Key', key()).send(body);

  const pushNotice = (personId: string, title = 'Practice moved') =>
    composeAndDispatch(t.app, system, {
      kind: 'placement',
      audience: { subjectPersonIds: [personId] },
      title,
      body: 'See the app for details.',
    });

  it('SPK-UX-001: a device registers, re-registration is idempotent, a revoked device receives nothing', async () => {
    const me = await customer();
    const token = `ios-token-${newId()}-a1b2`;
    const first = await register(me.header, { platform: 'ios', token, appVersion: '1.0.0' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      personId: me.personId,
      accountId: me.accountId,
      platform: 'ios',
      tokenHint: 'a1b2',
      appVersion: '1.0.0',
      status: 'active',
      revokedAt: null,
      revision: 1,
    });
    // §4.14: the token is never returned
    expect(JSON.stringify(first.body)).not.toContain(token);

    // the app registers again on its next launch: the same row, refreshed
    t.clock.advance(60_000);
    const again = await register(me.header, { platform: 'ios', token, appVersion: '1.1.0' });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: first.body.id, appVersion: '1.1.0', revision: 2 });
    expect(new Date(again.body.lastSeenAt).getTime()).toBeGreaterThan(
      new Date(first.body.lastSeenAt).getTime(),
    );
    const rows = await t.db
      .selectFrom('push_devices')
      .selectAll()
      .where('token_hash', '=', hashToken(token))
      .execute();
    expect(rows).toHaveLength(1);

    const second = await register(me.header, { platform: 'android', token: `android-${newId()}` });
    const listed = await t.http.get('/v1/me/push-devices').set(me.header);
    expect(listed.status).toBe(200);
    expect(listed.body.devices.map((d: { id: string }) => d.id).sort()).toEqual(
      [first.body.id, second.body.id].sort(),
    );
    expect(JSON.stringify(listed.body)).not.toContain(token);

    // a push notice fans out to every active device of the person
    const fanOut = await pushNotice(me.personId);
    await deliverQueued(t.app);
    expect(fakes.push.deviceSends.map((d) => d.address)).toEqual(expect.arrayContaining([token]));
    expect(fakes.push.deviceSends).toHaveLength(2);
    const pushAttempt = (await attemptsOf(t.db, org, fanOut.id)).find((a) => a.channel === 'push');
    expect(pushAttempt).toMatchObject({ status: 'provider_accepted' });

    // revoking erases the token; the revoked device receives nothing more
    const revoked = await t.http
      .post(`/v1/me/push-devices/${first.body.id}/revoke`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({ reason: 'lost this phone', expectedRevision: 2 });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body).toMatchObject({
      status: 'revoked',
      revokedReason: 'lost this phone',
      tokenHint: 'a1b2',
      revision: 3,
    });
    const stored = await t.db
      .selectFrom('push_devices')
      .select(['token', 'status'])
      .where('id', '=', first.body.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ token: null, status: 'revoked' });
    const twice = await t.http
      .post(`/v1/me/push-devices/${first.body.id}/revoke`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({ reason: 'again' });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_TRANSITION');

    fakes.push.reset();
    await pushNotice(me.personId, 'After revocation');
    await deliverQueued(t.app);
    expect(fakes.push.deviceSends.map((d) => d.address)).not.toContain(token);
    expect(fakes.push.deviceSends).toHaveLength(1);

    // the token never reaches an audit record
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['details', 'reason'])
      .where('target_type', '=', 'push_device')
      .execute();
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it('a person with no active device gets a failed push (NO_ADDRESS) and no front-desk exception; the in-app notice is delivered', async () => {
    const me = await customer();
    const n = await pushNotice(me.personId, 'No device yet');
    await deliverQueued(t.app);
    const attempts = await attemptsOf(t.db, org, n.id);
    expect(attempts.find((a) => a.channel === 'push')).toMatchObject({
      status: 'failed',
      failure_code: 'NO_ADDRESS',
    });
    expect(attempts.find((a) => a.channel === 'in_app')?.status).toBe('delivered');
    const pushAttempt = attempts.find((a) => a.channel === 'push');
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('affected_id', '=', pushAttempt?.id as string)
      .execute();
    expect(exceptions).toHaveLength(0);
  });

  it('a token active for another account moves to the new account: the older registration is revoked (reregistered) in the same command', async () => {
    const first = await customer();
    const second = await customer();
    const token = `shared-${newId()}`;
    const a = await register(first.header, { platform: 'android', token });
    const b = await register(second.header, { platform: 'android', token });
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
    const rows = await t.db
      .selectFrom('push_devices')
      .select(['id', 'account_id', 'status', 'revoked_reason', 'token'])
      .where('token_hash', '=', hashToken(token))
      .orderBy('registered_at')
      .orderBy('id')
      .execute();
    expect(rows.find((r) => r.id === a.body.id)).toMatchObject({
      status: 'revoked',
      revoked_reason: 'reregistered',
      token: null,
    });
    expect(rows.find((r) => r.id === b.body.id)).toMatchObject({
      status: 'active',
      account_id: second.accountId,
    });
    // the first account's device is not revealed to the second, nor revocable by it
    const foreign = await t.http
      .post(`/v1/me/push-devices/${a.body.id}/revoke`)
      .set(second.header)
      .set('Idempotency-Key', key())
      .send({ reason: 'not mine' });
    expect(foreign.status).toBe(404);
    // only the new holder is pushed to
    await pushNotice(first.personId, 'To the first account');
    await deliverQueued(t.app);
    expect(fakes.push.deviceSends.map((d) => d.address)).not.toContain(token);
  });

  it('concurrent registrations of one token by two accounts leave exactly one active registration (PGlite and PostgreSQL)', async () => {
    const first = await customer();
    const second = await customer();
    const token = `race-${newId()}`;
    const results = await Promise.all([
      register(first.header, { platform: 'ios', token }),
      register(second.header, { platform: 'ios', token }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const active = await t.db
      .selectFrom('push_devices')
      .select(['account_id'])
      .where('token_hash', '=', hashToken(token))
      .where('status', '=', 'active')
      .execute();
    expect(active).toHaveLength(1);
  });

  it('the database rejects two active registrations of one device token', async () => {
    const me = await customer();
    const token = `dup-${newId()}`;
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: newId(),
      organization_id: org,
      person_id: me.personId,
      account_id: me.accountId,
      platform: 'ios' as const,
      token,
      token_hash: hashToken(token),
      token_hint: token.slice(-4),
      app_version: null,
      registered_at: t.clock.now(),
      last_seen_at: t.clock.now(),
      revoked_at: null,
      revoked_reason: null,
      ...overrides,
    });
    await t.db.insertInto('push_devices').values(row()).execute();
    let error: unknown = null;
    try {
      await t.db.insertInto('push_devices').values(row()).execute();
    } catch (e) {
      error = e;
    }
    expect(isUniqueViolation(error)).toBe(true);
    // a revoked registration of the same token is history and may coexist
    await t.db
      .insertInto('push_devices')
      .values(
        row({
          status: 'revoked',
          token: null,
          revoked_at: t.clock.now(),
          revoked_reason: 'reregistered',
        }),
      )
      .execute();
    // the token is kept exactly while active, a revoked row says when and why
    for (const bad of [
      row({ token: null, token_hash: hashToken(`x-${newId()}`) }),
      row({ status: 'revoked', revoked_at: t.clock.now(), revoked_reason: 'lost' }),
      row({ token_hash: 'not-a-hash' }),
      row({
        token: null,
        status: 'revoked',
        revoked_at: null,
        revoked_reason: 'lost',
        token_hash: hashToken(`y-${newId()}`),
      }),
    ]) {
      let violation: unknown = null;
      try {
        await t.db.insertInto('push_devices').values(bad).execute();
      } catch (e) {
        violation = e;
      }
      expect(isCheckViolation(violation), JSON.stringify(bad)).toBe(true);
    }
  });

  it('SPK-AT-025: account recovery revokes the old account’s push devices', async () => {
    const me = await customer();
    const token = `recovered-${newId()}`;
    const device = await register(me.header, { platform: 'ios', token });
    expect(device.status).toBe(201);
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const relinked = await t.http
      .post(`/v1/accounts/${me.accountId}/relink`)
      .set(await authHeaderForPerson(t, support.personId))
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: `recovered-${newId()}`,
        reason: 'lost phone',
        expectedRevision: 1,
      });
    expect(relinked.status, JSON.stringify(relinked.body)).toBe(200);
    await dispatchOutbox(t.app);
    const stored = await t.db
      .selectFrom('push_devices')
      .select(['status', 'revoked_reason', 'token'])
      .where('id', '=', device.body.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ status: 'revoked', revoked_reason: 'account_relinked', token: null });
    // nothing reaches the old phone; the recovered sign-in registers its own device afresh
    await pushNotice(me.personId, 'After recovery');
    await deliverQueued(t.app);
    expect(fakes.push.deviceSends.map((d) => d.address)).not.toContain(token);
    const recovered = await authHeaderForAccount(t, me.accountId);
    const fresh = await register(recovered, { platform: 'ios', token });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(device.body.id);
    // replaying the relink event changes nothing more
    const before = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'communications.revoke_push_device')
      .execute();
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null })
      .where('event_type', '=', 'identity.account_relinked')
      .where('aggregate_id', '=', me.accountId)
      .execute();
    await dispatchOutbox(t.app);
    const after = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'communications.revoke_push_device')
      .execute();
    expect(after).toHaveLength(before.length);
    expect(
      (
        await t.db
          .selectFrom('push_devices')
          .select('status')
          .where('id', '=', fresh.body.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active');
  });

  it('§5.1, §5.2 (DEC-020): the push, email and SMS fakes are in the integration register under the messaging gate', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const res = await t.http
      .get('/v1/admin/integrations')
      .set(await authHeaderForPerson(t, admin.personId));
    expect(res.status).toBe(200);
    const messaging = res.body.gates.find((g: { gate: string }) => g.gate === 'messaging');
    expect(messaging).toMatchObject({ decisionRef: 'DEC-020', status: 'pending_decision' });
    expect(messaging.adapters.map((a: { id: string }) => a.id).sort()).toEqual([
      'communications.email_provider',
      'communications.push_provider',
      'communications.sms_provider',
    ]);
    for (const adapter of messaging.adapters) {
      expect(adapter).toMatchObject({
        adapter: { name: 'fake-messaging', kind: 'fake' },
        productionAllowed: false,
        scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
      });
    }
  });

  it('registration needs a signed-in account (self only)', async () => {
    const res = await t.http
      .post('/v1/me/push-devices')
      .set('Idempotency-Key', key())
      .send({ platform: 'ios', token: 'anonymous' });
    expect(res.status).toBe(401);
  });
});
