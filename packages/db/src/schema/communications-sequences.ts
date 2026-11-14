import type { Generated } from 'kysely';
import type { GeneratedTimestamp, Json, NullableTimestamp } from './core';

/**
 * Communications message templates and sequences (migration 1013; SPK-COMMS-009, proposed
 * amendment PA-05, DEC-099; capability `message_sequences`). The scheduled message lifecycle is
 * `ScheduledMessageMachine` (packages/contracts/src/state-machines.ts).
 */
export type MessageTemplateCategory = 'operational' | 'promotional';
export type MessageTemplateStatusValue = 'active' | 'archived';
export interface MessageTemplatesTable {
  id: string;
  organization_id: string;
  name: string;
  category: MessageTemplateCategory;
  title: string;
  body: string;
  status: Generated<MessageTemplateStatusValue>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type MessageSubjectTypeValue = 'season' | 'offering';
export interface MessageSequencesTable {
  id: string;
  organization_id: string;
  facility_id: string;
  name: string;
  subject_type: MessageSubjectTypeValue;
  /** A competition (seasons) or a program (offerings); null: every one. No cross-module key. */
  scope_id: string | null;
  active: Generated<boolean>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type MessageAnchorValue =
  'registration_opens' | 'registration_closes' | 'starts' | 'ends' | 'first_game';
export interface MessageSequenceStepsTable {
  id: string;
  organization_id: string;
  sequence_id: string;
  template_id: string;
  position: number;
  anchor: MessageAnchorValue;
  offset_days: number;
  /** Facility-local `HH:MM`; null: the time of the message sequence policy. */
  send_time_local: string | null;
  retired_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ScheduledMessageStatusValue =
  'needs_confirmation' | 'confirmed' | 'skipped' | 'sent' | 'canceled';
export type ScheduledMessageAttentionValue =
  'anchor_moved' | 'text_changed' | 'no_audience' | 'audience_too_large';
export interface ScheduledMessagesTable {
  id: string;
  organization_id: string;
  facility_id: string;
  sequence_id: string;
  sequence_step_id: string;
  subject_type: MessageSubjectTypeValue;
  subject_id: string;
  anchor_at: NullableTimestamp;
  due_at: NullableTimestamp;
  status: Generated<ScheduledMessageStatusValue>;
  attention: ScheduledMessageAttentionValue | null;
  edited_title: string | null;
  edited_body: string | null;
  edited_by: Json<Record<string, unknown>> | null;
  edited_at: NullableTimestamp;
  confirmed_title: string | null;
  confirmed_body: string | null;
  confirmed_by: Json<Record<string, unknown>> | null;
  confirmed_at: NullableTimestamp;
  skipped_by: Json<Record<string, unknown>> | null;
  skipped_at: NullableTimestamp;
  skip_reason: string | null;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  notification_id: string | null;
  sent_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CommunicationsSequencesTables {
  message_templates: MessageTemplatesTable;
  message_sequences: MessageSequencesTable;
  message_sequence_steps: MessageSequenceStepsTable;
  scheduled_messages: ScheduledMessagesTable;
}
