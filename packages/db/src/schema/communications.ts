import type { Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  JsonObject,
  NullableTimestamp,
  Timestamp,
} from './core';

/**
 * Communications module tables (migrations 1000-1008, specification §3.18 SPK-COMMS-001..008,
 * §4.4 Communications, §4.5 "Messages must represent actual delivery states", §4.7 invariant 10).
 */

export type NotificationKind =
  | 'registration_outcome'
  | 'team_invitation'
  | 'placement'
  | 'waitlist_offer'
  | 'schedule_published'
  | 'schedule_changed'
  | 'cancellation'
  | 'payment_attention'
  | 'assignment_offer'
  | 'result_published'
  | 'renewal_opportunity'
  | 'youth_feedback'
  | 'staff_broadcast'
  | 'availability_request'
  | 'activity_reminder';
export type NotificationCategory = 'operational' | 'promotional';
export type NotificationStatus = 'composed' | 'queued' | 'dispatched' | 'suppressed';
export type SuppressionReason = 'obsolete' | 'no_recipients' | 'authority_revoked';

export interface NotificationsTable {
  id: string;
  organization_id: string;
  facility_id: string | null;
  kind: NotificationKind;
  category: NotificationCategory;
  subject_type: string | null;
  subject_id: string | null;
  audience: Json<Record<string, unknown>>;
  title: string;
  body: string;
  details_before: Json<JsonObject> | null;
  details_after: Json<JsonObject> | null;
  protected: Generated<boolean>;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string | null;
  source_event_id: string | null;
  scheduled_for: NullableTimestamp;
  status: Generated<NotificationStatus>;
  supersedes_notification_id: string | null;
  superseded_by_notification_id: string | null;
  suppression_reason: SuppressionReason | null;
  queued_at: NullableTimestamp;
  dispatched_at: NullableTimestamp;
  suppressed_at: NullableTimestamp;
  correlation_id: string | null;
  operation_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type RecipientBasis =
  'self' | 'receive_messages' | 'staff_role' | 'team_member' | 'explicit';
export type RecipientStatus = 'pending' | 'authorized' | 'revoked';

export interface NotificationRecipientsTable {
  id: string;
  organization_id: string;
  notification_id: string;
  person_id: string;
  resolved_basis: RecipientBasis;
  basis_detail: string | null;
  subject_person_ids: Generated<string[]>;
  status: Generated<RecipientStatus>;
  resolved_at: Timestamp;
  authorized_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revocation_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type DeliveryChannel = 'in_app' | 'push' | 'email' | 'sms';
export type DeliveryStatus =
  'queued' | 'provider_accepted' | 'delivered' | 'failed' | 'unknown' | 'read' | 'acknowledged';
export type DeliveryFailureCode =
  'RECIPIENT_REVOKED' | 'NO_ADDRESS' | 'PROVIDER_REJECTED' | 'PROVIDER_ERROR' | 'SUPERSEDED';

export interface DeliveryAttemptsTable {
  id: string;
  organization_id: string;
  notification_id: string;
  recipient_id: string;
  channel: DeliveryChannel;
  provider: string;
  provider_message_id: string | null;
  status: Generated<DeliveryStatus>;
  queued_at: Timestamp;
  ready_at: NullableTimestamp;
  locked_until: NullableTimestamp;
  attempted_at: NullableTimestamp;
  accepted_at: NullableTimestamp;
  delivered_at: NullableTimestamp;
  failed_at: NullableTimestamp;
  read_at: NullableTimestamp;
  acknowledged_at: NullableTimestamp;
  provider_response: Json<JsonObject> | null;
  failure_code: DeliveryFailureCode | null;
  error: string | null;
  /** The failed attempt this one retries (migration 1005, SPK-COMMS-004). */
  retry_of_attempt_id: Generated<string | null>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Who last wrote a stored preference (migration 1006): the person, or a migration import. */
export type PreferenceSource = 'person' | 'import';

export interface CommunicationPreferencesTable {
  id: string;
  organization_id: string;
  person_id: string;
  channel: DeliveryChannel;
  category: NotificationCategory;
  enabled: boolean;
  updated_by: Json<Record<string, unknown>>;
  source: Generated<PreferenceSource>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** One imported preference record (migration 1006, §5.4 create-if-absent by record id). Append-only. */
export interface CommunicationPreferenceImportsTable {
  id: string;
  organization_id: string;
  person_id: string;
  batch_id: string;
  external_key: string;
  content: Json<Record<string, unknown>>;
  outcome: Json<Record<string, unknown>>;
  imported_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export type AcknowledgmentVia = DeliveryChannel;

export interface NotificationAcknowledgmentsTable {
  id: string;
  organization_id: string;
  notification_id: string;
  recipient_id: string;
  delivery_attempt_id: string | null;
  acknowledged_at: Timestamp;
  via: AcknowledgmentVia;
  acknowledged_by: Json<Record<string, unknown>>;
  note: string | null;
  created_at: GeneratedTimestamp;
}

export interface CalendarFeedsTable {
  id: string;
  organization_id: string;
  person_id: string;
  label: string | null;
  token_hash: string;
  scope: Json<Record<string, unknown>>;
  created_by: Json<Record<string, unknown>>;
  last_accessed_at: NullableTimestamp;
  access_count: Generated<number>;
  revoked_at: NullableTimestamp;
  revoked_by: Json<Record<string, unknown>> | null;
  revocation_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CalendarEntryStatus = 'draft' | 'published' | 'canceled';

export interface CalendarEntriesTable {
  id: string;
  organization_id: string;
  event_id: string;
  facility_id: string;
  title: string;
  kind: string;
  scheduled_start: Timestamp;
  scheduled_end: Timestamp;
  timezone: string;
  resources: GeneratedJson<Array<{ id: string; name: string }>>;
  status: CalendarEntryStatus;
  sequence: Generated<number>;
  last_change: string;
  last_source_event_id: string;
  /** Revision of the scheduling event the entry was built from (migration 1002). */
  source_revision: Generated<number | null>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CalendarEntryPartiesTable {
  organization_id: string;
  entry_id: string;
  party_type: 'team' | 'person';
  party_id: string;
  role: string;
}

export type PushPlatform = 'ios' | 'android' | 'web';
export type PushDeviceStatus = 'active' | 'revoked';

/** Push device registrations (migration 1004, SPK-UX-001). The token is kept only while active. */
export interface PushDevicesTable {
  id: string;
  organization_id: string;
  person_id: string;
  account_id: string;
  platform: PushPlatform;
  token: string | null;
  token_hash: string;
  token_hint: string;
  app_version: string | null;
  status: Generated<PushDeviceStatus>;
  registered_at: Timestamp;
  last_seen_at: Timestamp;
  revoked_at: NullableTimestamp;
  revoked_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** One activity reminder per scheduling event revision (migration 1007, SPK-CAP-001). Append-only. */
export interface ReminderMarksTable {
  organization_id: string;
  scheduling_event_id: string;
  event_revision: number;
  composed_at: Timestamp;
}

/**
 * Person merges this module followed (migration 1008, SPK-IAM-007): the survivor's stored
 * preferences at that moment, so a later choice of the survivor's own wins over the merged rows.
 * Append-only.
 */
export interface CommunicationMergeFollowUpsTable {
  organization_id: string;
  merge_id: string;
  survivor_person_id: string;
  merged_person_id: string;
  survivor_preferences: Json<Array<{ channel: string; category: string; revision: number }>>;
  conflicts: Json<Array<Record<string, unknown>>>;
  followed_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface CommunicationsTables {
  notifications: NotificationsTable;
  notification_recipients: NotificationRecipientsTable;
  delivery_attempts: DeliveryAttemptsTable;
  communication_preferences: CommunicationPreferencesTable;
  notification_acknowledgments: NotificationAcknowledgmentsTable;
  calendar_feeds: CalendarFeedsTable;
  calendar_entries: CalendarEntriesTable;
  calendar_entry_parties: CalendarEntryPartiesTable;
  push_devices: PushDevicesTable;
  reminder_marks: ReminderMarksTable;
  communication_preference_imports: CommunicationPreferenceImportsTable;
  communication_merge_follow_ups: CommunicationMergeFollowUpsTable;
}
