import {
  AudienceSchema,
  errors,
  type Audience,
  type CalendarFeed,
  type DeliveryAttempt,
  type InboxItem,
  type Notification,
  type NotificationRecipient,
  type Principal,
} from '@sportspark/contracts';
import type {
  CalendarFeedsTable,
  DeliveryAttemptsTable,
  NotificationRecipientsTable,
  NotificationsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';

export type NotificationRow = Selectable<NotificationsTable>;
export type RecipientRow = Selectable<NotificationRecipientsTable>;
export type AttemptRow = Selectable<DeliveryAttemptsTable>;
export type CalendarFeedRow = Selectable<CalendarFeedsTable>;

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

/** Customer-facing `/me` commands act on the principal's own person. */
export function personOf(principal: Principal): string {
  if (!principal.personId) {
    throw errors.authenticationRequired('The account is not attached to a person.');
  }
  return principal.personId;
}

export const iso = (value: Date | string): string => new Date(value).toISOString();
export const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

export function audienceOf(row: NotificationRow): Audience {
  return AudienceSchema.parse(row.audience);
}

export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind,
    category: row.category,
    status: row.status,
    suppressionReason: row.suppression_reason,
    facilityId: row.facility_id,
    subject:
      row.subject_type !== null && row.subject_id !== null
        ? { type: row.subject_type, id: row.subject_id }
        : null,
    audience: audienceOf(row),
    title: row.title,
    body: row.body,
    detailsBefore: (row.details_before as Record<string, unknown> | null) ?? null,
    detailsAfter: (row.details_after as Record<string, unknown> | null) ?? null,
    protected: row.protected,
    scheduledFor: isoOrNull(row.scheduled_for),
    supersedesNotificationId: row.supersedes_notification_id,
    supersededByNotificationId: row.superseded_by_notification_id,
    createdByPersonId: row.created_by_person_id,
    sourceEventId: row.source_event_id,
    operationId: row.operation_id,
    queuedAt: isoOrNull(row.queued_at),
    dispatchedAt: isoOrNull(row.dispatched_at),
    suppressedAt: isoOrNull(row.suppressed_at),
    correlationId: row.correlation_id,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toRecipient(row: RecipientRow): NotificationRecipient {
  return {
    id: row.id,
    notificationId: row.notification_id,
    personId: row.person_id,
    basis: row.resolved_basis,
    basisDetail: row.basis_detail,
    subjectPersonIds: [...row.subject_person_ids],
    status: row.status,
    resolvedAt: iso(row.resolved_at),
    authorizedAt: isoOrNull(row.authorized_at),
    revokedAt: isoOrNull(row.revoked_at),
    revocationReason: row.revocation_reason,
    revision: row.revision,
  };
}

export function toAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    id: row.id,
    notificationId: row.notification_id,
    recipientId: row.recipient_id,
    channel: row.channel,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    status: row.status,
    queuedAt: iso(row.queued_at),
    attemptedAt: isoOrNull(row.attempted_at),
    acceptedAt: isoOrNull(row.accepted_at),
    deliveredAt: isoOrNull(row.delivered_at),
    failedAt: isoOrNull(row.failed_at),
    readAt: isoOrNull(row.read_at),
    acknowledgedAt: isoOrNull(row.acknowledged_at),
    failureCode: row.failure_code,
    error: row.error,
    revision: row.revision,
  };
}

/** Inbox row: an in-app delivery attempt joined to its notification. */
export interface InboxRow {
  attempt_id: string;
  attempt_status: AttemptRow['status'];
  attempt_created_at: Date | string;
  delivered_at: Date | string | null;
  read_at: Date | string | null;
  acknowledged_at: Date | string | null;
  notification_id: string;
  kind: NotificationRow['kind'];
  category: NotificationRow['category'];
  title: string;
  body: string;
  facility_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  details_before: unknown;
  details_after: unknown;
  superseded_by_notification_id: string | null;
}

export function toInboxItem(row: InboxRow): InboxItem {
  return {
    attemptId: row.attempt_id,
    notificationId: row.notification_id,
    kind: row.kind,
    category: row.category,
    title: row.title,
    body: row.body,
    facilityId: row.facility_id,
    subject:
      row.subject_type !== null && row.subject_id !== null
        ? { type: row.subject_type, id: row.subject_id }
        : null,
    detailsBefore: (row.details_before as Record<string, unknown> | null) ?? null,
    detailsAfter: (row.details_after as Record<string, unknown> | null) ?? null,
    status: row.attempt_status,
    deliveredAt: isoOrNull(row.delivered_at),
    readAt: isoOrNull(row.read_at),
    acknowledgedAt: isoOrNull(row.acknowledged_at),
    supersededByNotificationId: row.superseded_by_notification_id,
    createdAt: iso(row.attempt_created_at),
  };
}

export function toCalendarFeed(row: CalendarFeedRow): CalendarFeed {
  const scope = row.scope as { subjectPersonIds?: unknown };
  return {
    id: row.id,
    personId: row.person_id,
    label: row.label,
    scope: {
      subjectPersonIds: Array.isArray(scope.subjectPersonIds)
        ? scope.subjectPersonIds.filter((v): v is string => typeof v === 'string')
        : [],
    },
    lastAccessedAt: isoOrNull(row.last_accessed_at),
    accessCount: row.access_count,
    revokedAt: isoOrNull(row.revoked_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export const uniqueStrings = (values: Iterable<string>): string[] => [...new Set(values)];
