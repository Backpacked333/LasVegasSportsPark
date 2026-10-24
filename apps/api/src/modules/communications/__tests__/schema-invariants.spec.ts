import { newId } from '@sportspark/contracts';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  pgErrorCode,
  seedOrganization,
  type Db,
} from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { IdentityModule, createPersonFixture } from '../../identity';

/**
 * Integrity that matters is enforced by the database (CLAUDE.md, §4.7). Each test proves that
 * PostgreSQL rejects the violation regardless of what a service does.
 */
describe('communications schema invariants (migration 1000)', () => {
  let t: TestApp;
  let db: Db;
  let org: string;
  let person: string;
  const actor = json({ kind: 'system', actorLabel: 'test' });

  beforeAll(async () => {
    t = await createTestApp({ imports: [IdentityModule], clockStart: '2026-10-23T12:00:00Z' });
    db = t.db;
    org = t.organizationId;
    person = await createPersonFixture(t, { kind: 'adult' });
  });
  afterAll(async () => {
    await t.close();
  });

  const now = () => t.clock.now();

  async function insertNotification(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    await db
      .insertInto('notifications')
      .values({
        id,
        organization_id: org,
        facility_id: null,
        kind: 'staff_broadcast',
        category: 'operational',
        subject_type: null,
        subject_id: null,
        audience: json({ personIds: [person] }),
        title: 'Title',
        body: 'Body',
        created_by: actor,
        created_by_person_id: null,
        source_event_id: null,
        scheduled_for: null,
        supersedes_notification_id: null,
        superseded_by_notification_id: null,
        suppression_reason: null,
        queued_at: null,
        dispatched_at: null,
        suppressed_at: null,
        correlation_id: null,
        operation_id: null,
        ...overrides,
      } as never)
      .execute();
    return id;
  }

  async function insertRecipient(notificationId: string, personId = person): Promise<string> {
    const id = newId();
    await db
      .insertInto('notification_recipients')
      .values({
        id,
        organization_id: org,
        notification_id: notificationId,
        person_id: personId,
        resolved_basis: 'explicit',
        basis_detail: null,
        resolved_at: now(),
        authorized_at: null,
        revoked_at: null,
        revocation_reason: null,
      })
      .execute();
    return id;
  }

  async function insertAttempt(
    notificationId: string,
    recipientId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = newId();
    await db
      .insertInto('delivery_attempts')
      .values({
        id,
        organization_id: org,
        notification_id: notificationId,
        recipient_id: recipientId,
        channel: 'email',
        provider: 'fake-messaging',
        provider_message_id: null,
        status: 'queued',
        queued_at: now(),
        ready_at: now(),
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
        ...overrides,
      } as never)
      .execute();
    return id;
  }

  it('SPK-COMMS-007: the operational in-app preference cannot be stored as disabled', async () => {
    const insert = (channel: string, category: string, enabled: boolean) =>
      db
        .insertInto('communication_preferences')
        .values({
          id: newId(),
          organization_id: org,
          person_id: person,
          channel: channel as never,
          category: category as never,
          enabled,
          updated_by: actor,
        })
        .execute();
    await expect(insert('in_app', 'operational', false)).rejects.toSatisfy(isCheckViolation);
    await insert('in_app', 'promotional', false);
    await insert('sms', 'operational', false);
    // one row per (person, channel, category)
    await expect(insert('sms', 'operational', true)).rejects.toSatisfy(isUniqueViolation);
  });

  it('notification status values are exactly the state machine states and suppression needs a reason', async () => {
    await expect(insertNotification({ status: 'sent' })).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertNotification({ status: 'suppressed', suppressed_at: now() }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(insertNotification({ status: 'queued' })).rejects.toSatisfy(isCheckViolation); // no queued_at
    await expect(insertNotification({ subject_type: 'event', subject_id: null })).rejects.toSatisfy(
      isCheckViolation,
    );
    await expect(insertNotification({ kind: 'spam' })).rejects.toSatisfy(isCheckViolation);
    await expect(insertNotification({ category: 'other' })).rejects.toSatisfy(isCheckViolation);
  });

  it('a replayed source event cannot compose a second notice (unique per organization and source event)', async () => {
    const sourceEventId = newId();
    await insertNotification({ source_event_id: sourceEventId });
    await expect(insertNotification({ source_event_id: sourceEventId })).rejects.toSatisfy(
      isUniqueViolation,
    );
  });

  it('recipients are unique per notification and person, and can never point at another organization’s person', async () => {
    const notificationId = await insertNotification();
    await insertRecipient(notificationId);
    await expect(insertRecipient(notificationId)).rejects.toSatisfy(isUniqueViolation);
    const other = await seedOrganization(db, { slug: `other-${newId()}` });
    const stranger = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    await expect(insertRecipient(notificationId, stranger)).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    await expect(insertNotification({ facility_id: other.facilityId })).rejects.toSatisfy(
      isForeignKeyViolation,
    );
  });

  it('SPK-COMMS-004: at most one live attempt per recipient and channel; a retry after failure is a new row', async () => {
    const notificationId = await insertNotification();
    const recipientId = await insertRecipient(notificationId);
    const first = await insertAttempt(notificationId, recipientId);
    await expect(insertAttempt(notificationId, recipientId)).rejects.toSatisfy(isUniqueViolation);
    await db
      .updateTable('delivery_attempts')
      .set({ status: 'failed', failed_at: now(), failure_code: 'PROVIDER_REJECTED', error: 'x' })
      .where('id', '=', first)
      .execute();
    await insertAttempt(notificationId, recipientId); // allowed after failure
    await insertAttempt(notificationId, recipientId, { channel: 'push' }); // other channel
  });

  it('SPK-COMMS-004: delivery states are consistent with their timestamps and the in-app channel is platform-delivered', async () => {
    const notificationId = await insertNotification();
    const recipientId = await insertRecipient(notificationId);
    await expect(insertAttempt(notificationId, recipientId, { status: 'sent' })).rejects.toSatisfy(
      isCheckViolation,
    );
    await expect(
      insertAttempt(notificationId, recipientId, { status: 'failed', failed_at: now() }), // no failure_code
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertAttempt(notificationId, recipientId, { status: 'delivered' }), // no delivered_at
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertAttempt(notificationId, recipientId, { status: 'provider_accepted' }), // no accepted_at
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertAttempt(notificationId, recipientId, { status: 'read', delivered_at: now() }), // no read_at
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertAttempt(notificationId, recipientId, { channel: 'in_app', provider: 'fake-messaging' }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertAttempt(notificationId, recipientId, { channel: 'sms', provider: 'in_app' }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertAttempt(notificationId, recipientId, { failure_code: 'BOGUS' }),
    ).rejects.toSatisfy(isCheckViolation);
    // a provider receipt maps to exactly one attempt
    await insertAttempt(notificationId, recipientId, {
      channel: 'push',
      provider_message_id: 'msg-1',
    });
    const otherNotification = await insertNotification();
    const otherRecipient = await insertRecipient(otherNotification);
    await expect(
      insertAttempt(otherNotification, otherRecipient, {
        channel: 'push',
        provider_message_id: 'msg-1',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('acknowledgments are append-only and recorded at most once per recipient', async () => {
    const notificationId = await insertNotification();
    const recipientId = await insertRecipient(notificationId);
    const attemptId = await insertAttempt(notificationId, recipientId, {
      channel: 'in_app',
      provider: 'in_app',
      status: 'delivered',
      delivered_at: now(),
    });
    const insertAck = () =>
      db
        .insertInto('notification_acknowledgments')
        .values({
          id: newId(),
          organization_id: org,
          notification_id: notificationId,
          recipient_id: recipientId,
          delivery_attempt_id: attemptId,
          acknowledged_at: now(),
          via: 'in_app',
          acknowledged_by: actor,
          note: null,
        })
        .execute();
    await insertAck();
    await expect(insertAck()).rejects.toSatisfy(isUniqueViolation);
    const update = db
      .updateTable('notification_acknowledgments')
      .set({ note: 'edited' })
      .where('recipient_id', '=', recipientId)
      .execute();
    await expect(update).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23001');
    const remove = db
      .deleteFrom('notification_acknowledgments')
      .where('recipient_id', '=', recipientId)
      .execute();
    await expect(remove).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23001');
  });

  it('SPK-COMMS-008: token hashes are unique, revocation is attributed, and calendar entries have one row per event', async () => {
    const insertFeed = (overrides: Record<string, unknown> = {}) =>
      db
        .insertInto('calendar_feeds')
        .values({
          id: newId(),
          organization_id: org,
          person_id: person,
          label: null,
          token_hash: 'hash-1',
          scope: json({ subjectPersonIds: [] }),
          created_by: actor,
          last_accessed_at: null,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
          ...overrides,
        } as never)
        .execute();
    await insertFeed();
    await expect(insertFeed()).rejects.toSatisfy(isUniqueViolation);
    await expect(
      insertFeed({ token_hash: 'hash-2', revoked_at: now() }), // revoked_by missing
    ).rejects.toSatisfy(isCheckViolation);

    const eventId = newId();
    const insertEntry = (overrides: Record<string, unknown> = {}) =>
      db
        .insertInto('calendar_entries')
        .values({
          id: newId(),
          organization_id: org,
          event_id: eventId,
          facility_id: t.facilityId,
          title: 'Game',
          kind: 'game',
          scheduled_start: new Date('2026-11-07T18:00:00Z'),
          scheduled_end: new Date('2026-11-07T19:00:00Z'),
          timezone: 'America/Los_Angeles',
          status: 'published',
          last_change: 'created',
          last_source_event_id: newId(),
          ...overrides,
        } as never)
        .execute();
    await insertEntry();
    await expect(insertEntry()).rejects.toSatisfy(isUniqueViolation);
    await expect(
      insertEntry({ event_id: newId(), scheduled_end: new Date('2026-11-07T17:00:00Z') }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(insertEntry({ event_id: newId(), status: 'tentative' })).rejects.toSatisfy(
      isCheckViolation,
    );
  });
});
