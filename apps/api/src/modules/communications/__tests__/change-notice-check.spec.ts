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
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
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
 * `unsatisfied` when every external attempt of a recipient not told failed.
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
  const changeNotice = (eventId: string, audience: object) =>
    composeAndDispatch(t.app, system, {
      kind: 'schedule_changed',
      subject: { type: 'event', id: eventId },
      audience,
      title: 'Schedule changed: Lions vs Tigers',
      body: 'Now 14:00 to 15:00.',
      detailsAfter: { scheduledStart: START, scheduledEnd: END },
    });

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
});
