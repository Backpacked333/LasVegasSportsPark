import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * R4-COMMS-AUTOMATION-03 (SPK-COMMS-005, SPK-COMMS-003, SPK-COMMS-004): a newer schedule notice
 * makes an older one obsolete only for the people it reaches. A narrower notice about the same
 * subject never suppresses, marks replaced or withdraws the external copies of what other people
 * were told.
 */
describe('superseding follows the newer notice audience (SPK-COMMS-005)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let notifications: NotificationsService;
  let fakes: FakeProviders;
  let people: OrganizationPeople;
  let player: string;
  let staff: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    notifications = t.app.get(NotificationsService);
    fakes = fakeProviders(t.app);
    people = await createOrganizationPeople(t, { staffRoles: ['league_manager'] });
    player = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: player });
    staff = await authHeaderForPerson(t, people.staff.personId);
    for (const [personId, value] of [
      [people.adult.personId, 'guardian@example.test'],
      [player, 'player@example.test'],
    ] as const) {
      await createContactPointFixture(t, { personId, kind: 'email', value, verified: true });
    }
  });
  afterAll(async () => {
    await t.close();
  });

  const changed = (eventId: string, audience: object, overrides: object = {}) => ({
    kind: 'schedule_changed' as const,
    subject: { type: 'event', id: eventId },
    audience,
    title: 'Schedule changed: Lions vs Tigers',
    body: 'Was 10:00, now 14:00.',
    ...overrides,
  });
  const row = (id: string) =>
    t.db
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', org)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  /** The push/email/SMS attempts of one person on one notice. */
  const externalOf = async (notificationId: string, personId: string) => {
    const recipient = (await recipientsOf(t.db, org, notificationId)).find(
      (r) => r.person_id === personId,
    );
    return (await attemptsOf(t.db, org, notificationId)).filter(
      (a) => a.recipient_id === recipient?.id && a.channel !== 'in_app',
    );
  };
  /** Staff composes and confirms a notice (SPK-COMMS-006), then dispatch runs. */
  const staffSends = async (body: object): Promise<string> => {
    const composed = await t.http
      .post('/v1/notifications')
      .set(staff)
      .set('Idempotency-Key', key())
      .send(body);
    expect(composed.status, JSON.stringify(composed.body)).toBe(201);
    const sent = await t.http
      .post(`/v1/notifications/${composed.body.id}/send`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await dispatchOutbox(t.app);
    return composed.body.id as string;
  };

  it('SPK-COMMS-005: a narrower schedule_changed about the same event leaves the other recipients’ notice, pointer and queued attempts untouched', async () => {
    const eventId = newId();
    // N1 to both families: the guardian (for the child) and the adult player; nothing handed over.
    const wide = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [people.child.personId, player] }),
    );
    expect(wide.status).toBe('dispatched');
    expect((await externalOf(wide.id, people.adult.personId)).map((a) => a.status)).toEqual([
      'queued',
      'queued',
    ]);

    // N2, composed by staff for the player only.
    const narrow = await staffSends(
      changed(eventId, { subjectPersonIds: [player] }, { body: 'Now 14:00 (player copy).' }),
    );
    expect(await row(narrow)).toMatchObject({
      status: 'dispatched',
      supersedes_notification_id: null,
    });

    // The guardian's notice stands: no pointer, and their email and push are still to be sent.
    expect(await row(wide.id)).toMatchObject({
      status: 'dispatched',
      superseded_by_notification_id: null,
    });
    const guardian = await externalOf(wide.id, people.adult.personId);
    expect(guardian.map((a) => [a.status, a.failure_code])).toEqual([
      ['queued', null],
      ['queued', null],
    ]);
    // The player gets the newer notice instead, so their stale external copies never go out.
    const covered = await externalOf(wide.id, player);
    expect(covered.map((a) => [a.status, a.failure_code])).toEqual([
      ['failed', 'SUPERSEDED'],
      ['failed', 'SUPERSEDED'],
    ]);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('organization_id', '=', org)
      .where('target_id', '=', wide.id)
      .where('action', 'like', 'communications.notification_superseded%')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'communications.notification_superseded_for_recipients',
    ]);

    // The guardian's email is delivered; the guardian's inbox shows no "replaced" pointer.
    fakes.email.reset();
    await deliverQueued(t.app);
    const emailed = fakes.email.sent.map((r) => r.attemptId);
    expect(emailed).toContain(guardian.find((a) => a.channel === 'email')?.id);
    expect(emailed).not.toContain(covered.find((a) => a.channel === 'email')?.id);
    const inbox = await t.http
      .get('/v1/me/inbox?limit=20')
      .set(await authHeaderForPerson(t, people.adult.personId));
    expect(
      inbox.body.items.find((i: { notificationId: string }) => i.notificationId === wide.id),
    ).toMatchObject({ supersededByNotificationId: null });
  });

  it('SPK-COMMS-005: a notice that reaches every recipient of the older one supersedes it, whatever its audience names', async () => {
    const eventId = newId();
    const older = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [people.child.personId] }),
    );
    // The guardian named directly: the same people, another audience shape.
    const newer = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { personIds: [people.adult.personId] }, { body: 'Now 15:00.' }),
    );
    expect(await row(older.id)).toMatchObject({ superseded_by_notification_id: newer.id });
    expect((await externalOf(older.id, people.adult.personId)).map((a) => a.failure_code)).toEqual([
      'SUPERSEDED',
      'SUPERSEDED',
    ]);
  });

  it('SPK-COMMS-005: an unsent notice covered only in part still goes out; one the newer notice covers is suppressed', async () => {
    const eventId = newId();
    const reminder = await notifications.composeAndQueue(
      system,
      changed(
        eventId,
        { subjectPersonIds: [people.child.personId, player] },
        { kind: 'schedule_published', scheduledFor: '2026-10-30T17:00:00.000Z' },
      ),
    );
    await dispatchOutbox(t.app); // not due yet: it stays queued
    await staffSends(changed(eventId, { subjectPersonIds: [player] }));
    expect(await row(reminder.id)).toMatchObject({
      status: 'queued',
      suppression_reason: null,
      superseded_by_notification_id: null,
    });

    const cancellation = await composeAndDispatch(
      t.app,
      system,
      changed(
        eventId,
        { subjectPersonIds: [player, people.child.personId] },
        { kind: 'cancellation', title: 'Canceled: Lions vs Tigers', body: 'Canceled.' },
      ),
    );
    expect(await row(reminder.id)).toMatchObject({
      status: 'suppressed',
      suppression_reason: 'obsolete',
      superseded_by_notification_id: cancellation.id,
    });
  });
});
