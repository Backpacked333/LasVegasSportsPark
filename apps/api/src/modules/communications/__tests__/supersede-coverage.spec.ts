import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { isCheckViolation } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
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
 * were told, and nothing stale reaches the people it does reach: a queued older notice is not
 * dispatched to them, a dispatched one is not retried or handed over to them, and the database
 * refuses any new attempt for them (migration 1011).
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

  it('SPK-COMMS-005: a queued notice covered in part by narrower notices is suppressed once they cover all its recipients; a full cover suppresses it at once', async () => {
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
    const narrow = await staffSends(changed(eventId, { subjectPersonIds: [player] }));
    expect(await row(reminder.id)).toMatchObject({
      status: 'queued',
      suppression_reason: null,
      superseded_by_notification_id: null,
    });
    // The guardian's notice by itself: with the player already replaced, it covers every
    // recipient the reminder is still to tell.
    const guardianOnly = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [people.child.personId] }, { body: 'Now 15:00.' }),
    );
    expect(await row(reminder.id)).toMatchObject({
      status: 'suppressed',
      suppression_reason: 'obsolete',
      superseded_by_notification_id: guardianOnly.id,
    });
    void narrow;

    const second = await notifications.composeAndQueue(
      system,
      changed(
        eventId,
        { subjectPersonIds: [people.child.personId, player] },
        { kind: 'schedule_published', scheduledFor: '2026-10-30T17:00:00.000Z' },
      ),
    );
    const cancellation = await composeAndDispatch(
      t.app,
      system,
      changed(
        eventId,
        { subjectPersonIds: [player, people.child.personId] },
        { kind: 'cancellation', title: 'Canceled: Lions vs Tigers', body: 'Canceled.' },
      ),
    );
    expect(await row(second.id)).toMatchObject({
      status: 'suppressed',
      suppression_reason: 'obsolete',
      superseded_by_notification_id: cancellation.id,
    });
  });

  it('SPK-COMMS-005: after a narrower notice, the covered recipient’s already-failed attempt on the older notice is not retried; another recipient’s is', async () => {
    const manager = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    const gm = await authHeaderForPerson(t, manager.personId);
    const retry = (attemptId: string) =>
      t.http
        .post(`/v1/delivery-attempts/${attemptId}/retry`)
        .set(gm)
        .set('Idempotency-Key', key())
        .send({ reason: 'resend after a provider rejection' });
    const eventId = newId();
    fakes.email.scriptAddress('player@example.test', 'failed');
    fakes.email.scriptAddress('guardian@example.test', 'failed');
    const wide = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [people.child.personId, player] }),
    );
    await deliverQueued(t.app);
    fakes.email.reset();
    const failedEmailOf = async (personId: string) =>
      (await externalOf(wide.id, personId)).find((a) => a.channel === 'email');
    const playerEmail = await failedEmailOf(player);
    const guardianEmail = await failedEmailOf(people.adult.personId);
    expect([playerEmail?.failure_code, guardianEmail?.failure_code]).toEqual([
      'PROVIDER_REJECTED',
      'PROVIDER_REJECTED',
    ]);

    // A newer notice to the player only ("now 16:00") goes out and is accepted.
    const narrow = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [player] }, { body: 'Now 16:00.' }),
    );
    await deliverQueued(t.app);
    const recipients = await recipientsOf(t.db, org, wide.id);
    expect(
      recipients.map((r) => [r.person_id === player, r.superseded_by_notification_id]),
    ).toEqual(
      expect.arrayContaining([
        [true, narrow.id],
        [false, null],
      ]),
    );

    // The player's stale "10:00 → 14:00" is never resent after "16:00".
    const refused = await retry(playerEmail!.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details).toMatchObject({
      code: 'NOTICE_SUPERSEDED',
      supersededByNotificationId: narrow.id,
    });
    // The guardian was told nothing newer: their failed email may be retried.
    const allowed = await retry(guardianEmail!.id);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    fakes.email.reset();
    await deliverQueued(t.app);
    expect(fakes.email.sent.map((r) => [r.address, r.notificationId])).toEqual([
      ['guardian@example.test', wide.id],
    ]);

    // The player's inbox shows what replaced it; the staff delivery view names the recipient.
    const inbox = await t.http
      .get('/v1/me/inbox?limit=20')
      .set(await authHeaderForPerson(t, player));
    expect(
      inbox.body.items.find((i: { notificationId: string }) => i.notificationId === wide.id),
    ).toMatchObject({ supersededByNotificationId: narrow.id });
    const deliveries = await t.http.get(`/v1/notifications/${wide.id}/deliveries`).set(gm);
    expect(deliveries.status).toBe(200);
    expect(
      deliveries.body.recipients.find((r: { personId: string }) => r.personId === player),
    ).toMatchObject({ supersededByNotificationId: narrow.id, status: 'authorized' });
    expect(deliveries.body.notification).toMatchObject({ supersededByNotificationId: null });
  });

  it('SPK-COMMS-005: the hand-off refuses an attempt of a recipient the older notice was replaced for, even when the attempt was left queued', async () => {
    const eventId = newId();
    const wide = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [people.child.personId, player] }),
    );
    // A supersede that recorded the player's replacement but did not reach their queued attempts
    // (the hand-off is the last line): the pointer alone must stop the send.
    const newer = await notifications.compose(
      system,
      changed(eventId, { subjectPersonIds: [player] }, { body: 'Now 16:00.' }),
      null,
    );
    const playerRecipient = (await recipientsOf(t.db, org, wide.id)).find(
      (r) => r.person_id === player,
    );
    await t.db
      .updateTable('notification_recipients')
      .set({ superseded_by_notification_id: newer.id, superseded_at: t.clock.now() })
      .where('id', '=', playerRecipient!.id)
      .execute();
    fakes.email.reset();
    await deliverQueued(t.app);
    expect(fakes.email.sent.map((r) => r.address)).toEqual(['guardian@example.test']);
    expect((await externalOf(wide.id, player)).map((a) => [a.status, a.failure_code])).toEqual([
      ['failed', 'SUPERSEDED'],
      ['failed', 'SUPERSEDED'],
    ]);
  });

  it('SPK-COMMS-005: the database refuses any attempt for a recipient a newer notice replaced the notice for, and never rewrites that fact', async () => {
    const eventId = newId();
    const wide = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [people.child.personId, player] }),
    );
    const narrow = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [player] }, { body: 'Now 16:00.' }),
    );
    const recipients = await recipientsOf(t.db, org, wide.id);
    const covered = recipients.find((r) => r.person_id === player)!;
    const other = recipients.find((r) => r.person_id !== player)!;
    expect(covered.superseded_by_notification_id).toBe(narrow.id);
    const insertAttempt = (recipientId: string, channel: 'sms' = 'sms') =>
      t.db
        .insertInto('delivery_attempts')
        .values({
          id: newId(),
          organization_id: org,
          notification_id: wide.id,
          recipient_id: recipientId,
          channel,
          provider: 'fake-messaging',
          provider_message_id: null,
          status: 'queued',
          queued_at: t.clock.now(),
          ready_at: t.clock.now(),
          locked_until: null,
          attempted_at: null,
          accepted_at: null,
          delivered_at: null,
          failed_at: null,
          read_at: null,
          acknowledged_at: null,
          provider_response: null,
          failure_code: null,
          error: null,
        })
        .execute();
    await expect(insertAttempt(covered.id)).rejects.toSatisfy(isCheckViolation);
    // The other recipient is not covered: the same insert is accepted (then withdrawn).
    await insertAttempt(other.id);
    await t.db
      .deleteFrom('delivery_attempts')
      .where('recipient_id', '=', other.id)
      .where('channel', '=', 'sms')
      .execute();
    // The pointer is set once: neither cleared nor moved to another notice, and never without
    // its instant.
    const draft = await notifications.compose(
      system,
      changed(eventId, { subjectPersonIds: [player] }, { body: 'Draft.' }),
      null,
    );
    const repoint = (recipientId: string, value: string | null, at: Date | null) =>
      t.db
        .updateTable('notification_recipients')
        .set({ superseded_by_notification_id: value, superseded_at: at })
        .where('id', '=', recipientId)
        .execute();
    await expect(repoint(covered.id, null, null)).rejects.toSatisfy(isCheckViolation);
    await expect(repoint(covered.id, draft.id, t.clock.now())).rejects.toSatisfy(isCheckViolation);
    await expect(repoint(other.id, draft.id, null)).rejects.toSatisfy(isCheckViolation);
    await expect(repoint(other.id, wide.id, t.clock.now())).rejects.toSatisfy(isCheckViolation);

    // A notice replaced as a whole takes no new attempt either.
    const all = await composeAndDispatch(
      t.app,
      system,
      changed(eventId, { subjectPersonIds: [people.child.personId, player] }, { body: 'Off.' }),
    );
    expect(await row(wide.id)).toMatchObject({ superseded_by_notification_id: all.id });
    await expect(insertAttempt(other.id)).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-COMMS-005: a queued reminder covered in part is dispatched to the others only: the covered person gets no in-app, push or email copy', async () => {
    const eventId = newId();
    const reminder = await notifications.composeAndQueue(
      system,
      changed(
        eventId,
        { subjectPersonIds: [people.child.personId, player] },
        {
          kind: 'schedule_published',
          scheduledFor: '2026-10-30T17:00:00.000Z',
          body: 'Lions vs Tigers at 10:00',
        },
      ),
    );
    await dispatchOutbox(t.app); // not due yet: it stays queued
    const narrow = await staffSends(
      changed(eventId, { subjectPersonIds: [player] }, { body: 'Now 14:00.' }),
    );
    await deliverQueued(t.app);
    expect(await row(reminder.id)).toMatchObject({
      status: 'queued',
      superseded_by_notification_id: null,
    });
    const before = await recipientsOf(t.db, org, reminder.id);
    const covered = before.find((r) => r.person_id === player)!;
    expect(covered).toMatchObject({ status: 'pending', superseded_by_notification_id: narrow });
    expect(
      before.find((r) => r.person_id === people.adult.personId)?.superseded_by_notification_id,
    ).toBeNull();
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('organization_id', '=', org)
      .where('target_id', '=', reminder.id)
      .where('action', '=', 'communications.notification_superseded_for_recipients')
      .execute();
    expect(audit.map((a) => a.details)).toMatchObject([
      { supersededBy: narrow, notificationStatus: 'queued', recipientIds: [covered.id] },
    ]);

    // The reminder falls due after the correction.
    const start = t.clock.now();
    t.clock.set(new Date('2026-10-30T17:01:00.000Z'));
    try {
      await dispatchOutbox(t.app);
      fakes.email.reset();
      await deliverQueued(t.app);
      expect(await row(reminder.id)).toMatchObject({ status: 'dispatched' });
      const attempts = await attemptsOf(t.db, org, reminder.id);
      expect(attempts.filter((a) => a.recipient_id === covered.id)).toEqual([]);
      const guardian = before.find((r) => r.person_id === people.adult.personId)!;
      expect(
        attempts
          .filter((a) => a.recipient_id === guardian.id)
          .map((a) => a.channel)
          .sort(),
      ).toEqual(['email', 'in_app', 'push']);
      expect(fakes.email.sent.map((r) => [r.address, r.body])).toEqual([
        ['guardian@example.test', 'Lions vs Tigers at 10:00'],
      ]);
      const playerInbox = await t.http
        .get('/v1/me/inbox?limit=20')
        .set(await authHeaderForPerson(t, player));
      expect(
        playerInbox.body.items.map((i: { notificationId: string }) => i.notificationId),
      ).not.toContain(reminder.id);
      const dispatchAudit = await t.db
        .selectFrom('audit_records')
        .select('details')
        .where('organization_id', '=', org)
        .where('target_id', '=', reminder.id)
        .where('action', '=', 'communications.dispatch')
        .executeTakeFirstOrThrow();
      expect(dispatchAudit.details).toMatchObject({ authorized: 1, superseded: 1 });
    } finally {
      t.clock.set(start);
    }
  });
});
