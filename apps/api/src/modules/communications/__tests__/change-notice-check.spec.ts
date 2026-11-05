import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { ChangeNoticeCheck } from '../services/change-notice-check';
import { NotificationsService } from '../services/notifications.service';
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
  dispatchOutbox,
  fakeProviders,
  recipientsOf,
  type FakeProviders,
} from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;

/**
 * R4-COMMS-AUTOMATION-06 (SPK-READY-001 "material change notifications", SPK-READY-002, §4.5
 * "messages must represent actual delivery states"): the fixture-readiness check counts a person
 * as told by an accepted push/email/SMS or by their reading the in-app notice, never by the in-app
 * copy dispatch delivers to every inbox; it reports `unknown` while outcomes are pending and
 * `unsatisfied` when every external attempt of a recipient not told failed. Only the notices since
 * the last one that went out describing another time count, a notice of the current time not yet
 * sent keeps it unknown, and an attempt that never was a way to reach the person is not a failure.
 */
describe('change-notice readiness evidence (SPK-READY-001)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let fakes: FakeProviders;
  let check: ChangeNoticeCheck;
  let people: OrganizationPeople;
  let player: string;

  const START = '2026-11-07T22:00:00.000Z';
  const END = '2026-11-07T23:00:00.000Z';

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
    check = t.app.get(ChangeNoticeCheck);
    people = await createOrganizationPeople(t);
    player = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: player });
    for (const [personId, value] of [
      [people.adult.personId, 'guardian@example.test'],
      [player, 'player@example.test'],
    ] as const) {
      await createContactPointFixture(t, { personId, kind: 'email', value, verified: true });
    }
  });
  beforeEach(() => {
    fakes.email.reset();
    fakes.push.reset();
  });
  afterAll(async () => {
    await t.close();
  });

  const findings = (eventId: string) =>
    check.changeNotices(org, {
      fixtureId: newId(),
      seasonId: newId(),
      teamEntryIds: [],
      personIds: [],
      at: t.clock.now(),
      changedAt: t.clock.now(),
      schedulingEventId: eventId,
      scheduledStart: START,
      scheduledEnd: END,
    });
  const changeNotice = (
    eventId: string,
    audience: object,
    detailsAfter: Record<string, string> = { scheduledStart: START, scheduledEnd: END },
  ) =>
    composeAndDispatch(t.app, system, {
      kind: 'schedule_changed',
      subject: { type: 'event', id: eventId },
      audience,
      title: 'Schedule changed: Lions vs Tigers',
      body: 'Now 14:00 to 15:00.',
      detailsAfter,
    });
  const preferences = async (personId: string, enabled: Record<'email' | 'push', boolean>) => {
    const res = await t.http
      .patch('/v1/me/communication-preferences')
      .set(await authHeaderForPerson(t, personId))
      .set('Idempotency-Key', key())
      .send({
        preferences: (['email', 'push'] as const).map((channel) => ({
          channel,
          category: 'operational',
          enabled: enabled[channel],
        })),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  it('SPK-READY-001: a dispatched change notice is unknown until a provider accepts it, unsatisfied when every external attempt failed, and satisfied once the person reads it', async () => {
    const eventId = newId();
    const notice = await changeNotice(eventId, {
      subjectPersonIds: [people.child.personId, player],
    });
    expect(notice.status).toBe('dispatched');
    // Dispatched: every in-app copy is delivered, every push and email still queued.
    expect(await findings(eventId)).toMatchObject([
      { status: 'unknown', code: 'change_notification_unconfirmed' },
    ]);

    // The player's email is accepted; the guardian's is rejected and nobody registered a device.
    const guardianRecipient = (await recipientsOf(t.db, org, notice.id)).find(
      (r) => r.person_id === people.adult.personId,
    );
    fakes.email.scriptAddress('guardian@example.test', 'failed');
    await deliverQueued(t.app);
    const guardianAttempts = (await attemptsOf(t.db, org, notice.id)).filter(
      (a) => a.recipient_id === guardianRecipient?.id,
    );
    expect(guardianAttempts.map((a) => [a.channel, a.status])).toEqual([
      ['email', 'failed'],
      ['in_app', 'delivered'],
      ['push', 'failed'],
    ]);
    const failed = await findings(eventId);
    expect(failed).toMatchObject([{ status: 'unsatisfied', code: 'change_notification_failed' }]);
    expect(failed[0]?.message).toContain('1 of 2');
    // SPK-READY-003: the required action names what clears the issue.
    expect(failed[0]?.requiredAction).toMatch(/Retry the failed deliveries/);

    // A resend to the player alone describes the same time but does not stand in for the guardian.
    await changeNotice(eventId, { subjectPersonIds: [player] });
    await deliverQueued(t.app);
    expect(await findings(eventId)).toMatchObject([
      { status: 'unsatisfied', code: 'change_notification_failed' },
    ]);

    // The guardian opens the in-app notice: now told.
    const inApp = guardianAttempts.find((a) => a.channel === 'in_app');
    const read = await t.http
      .post(`/v1/me/inbox/${inApp?.id}/read`)
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send({});
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(await findings(eventId)).toEqual([]);
  });

  it('SPK-READY-002: an outcome left unknown by the provider, or an unread in-app notice alone, stays unknown', async () => {
    const eventId = newId();
    // The player switches every external channel off: only the in-app copy goes out.
    const header = await authHeaderForPerson(t, player);
    const off = await t.http
      .patch('/v1/me/communication-preferences')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        preferences: [
          { channel: 'email', category: 'operational', enabled: false },
          { channel: 'push', category: 'operational', enabled: false },
        ],
      });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    fakes.email.scriptAddress('guardian@example.test', 'unknown');
    await changeNotice(eventId, { subjectPersonIds: [people.child.personId, player] });
    await deliverQueued(t.app);
    expect(await findings(eventId)).toMatchObject([
      { status: 'unknown', code: 'change_notification_unconfirmed' },
    ]);
    const on = await t.http
      .patch('/v1/me/communication-preferences')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        preferences: [
          { channel: 'email', category: 'operational', enabled: true },
          { channel: 'push', category: 'operational', enabled: true },
        ],
      });
    expect(on.status).toBe(200);
  });

  it('SPK-READY-001: a fixture moved and moved back is evidenced only by the notice of the move back, not by the first notice of that time', async () => {
    const eventId = newId();
    const audience = { subjectPersonIds: [people.child.personId, player] };
    const elsewhere = {
      scheduledStart: '2026-11-08T00:00:00.000Z',
      scheduledEnd: '2026-11-08T01:00:00.000Z',
    };
    // 14:00 is accepted by every email, then 16:00 is, then the fixture moves back to 14:00.
    await changeNotice(eventId, audience);
    await deliverQueued(t.app);
    await changeNotice(eventId, audience, elsewhere);
    await deliverQueued(t.app);
    const back = await changeNotice(eventId, audience);
    expect(await findings(eventId)).toMatchObject([
      {
        status: 'unknown',
        code: 'change_notification_unconfirmed',
        source: { type: 'notification', id: back.id },
      },
    ]);
    expect((await findings(eventId))[0]?.message).toContain('0 of 2');
    await deliverQueued(t.app);
    // The guardian has no device: push NO_ADDRESS is no channel, their accepted email tells them.
    expect(await findings(eventId)).toEqual([]);
  });

  it('SPK-READY-001: a newer notice of the current time still queued keeps the check unknown, whatever an older narrower notice reached', async () => {
    const eventId = newId();
    await changeNotice(eventId, { subjectPersonIds: [player] });
    await deliverQueued(t.app);
    expect(await findings(eventId)).toEqual([]);
    // The wide notice, for both families, waits for its scheduled time.
    const wide = await t.app.get(NotificationsService).composeAndQueue(system, {
      kind: 'schedule_changed',
      subject: { type: 'event', id: eventId },
      audience: { subjectPersonIds: [people.child.personId, player] },
      title: 'Schedule changed: Lions vs Tigers',
      body: 'Now 14:00 to 15:00.',
      detailsAfter: { scheduledStart: START, scheduledEnd: END },
      scheduledFor: '2026-10-24T08:00:00.000Z',
    });
    await dispatchOutbox(t.app);
    expect(wide.status).toBe('queued');
    expect(await findings(eventId)).toMatchObject([
      {
        status: 'unknown',
        code: 'change_notification_pending',
        source: { type: 'notification', id: wide.id },
      },
    ]);
  });

  it('SPK-READY-002: a channel switched off after dispatch, or a push without a device, is no channel, not a failed delivery', async () => {
    const eventId = newId();
    await changeNotice(eventId, { subjectPersonIds: [people.child.personId, player] });
    // After dispatch the player switches email and push off: their attempts fail CHANNEL_DISABLED.
    await preferences(player, { email: false, push: false });
    await deliverQueued(t.app);
    const own = await findings(eventId);
    expect(own).toMatchObject([{ status: 'unknown', code: 'change_notification_unconfirmed' }]);
    expect(own[0]?.message).toContain('1 of 2');
    await preferences(player, { email: true, push: true });

    // The player keeps push on but email off before the notice: push alone, and no device.
    const second = newId();
    await preferences(player, { email: false, push: true });
    const notice = await changeNotice(second, { subjectPersonIds: [player] });
    await deliverQueued(t.app);
    const playerRecipient = (await recipientsOf(t.db, org, notice.id))[0];
    expect(
      (await attemptsOf(t.db, org, notice.id))
        .filter((a) => a.recipient_id === playerRecipient?.id)
        .map((a) => [a.channel, a.status, a.failure_code]),
    ).toEqual([
      ['in_app', 'delivered', null],
      ['push', 'failed', 'NO_ADDRESS'],
    ]);
    expect(await findings(second)).toMatchObject([
      { status: 'unknown', code: 'change_notification_unconfirmed' },
    ]);
    await preferences(player, { email: true, push: true });
  });
});
