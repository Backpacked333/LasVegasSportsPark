import {
  messagePlaceholdersIn,
  type MessageSequence,
  type MessageSequenceStep,
  type MessageTemplate,
} from '@sportspark/contracts';
import type {
  Db,
  MessageSequenceStepsTable,
  MessageSequencesTable,
  MessageTemplatesTable,
  ScheduledMessagesTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { Trx } from '../../../kernel';
import { iso, isoOrNull } from '../communications.shared';
import type { MessageSequencePolicy } from './message-sequences.policy';

export type TemplateRow = Selectable<MessageTemplatesTable>;
export type SequenceRow = Selectable<MessageSequencesTable>;
export type StepRow = Selectable<MessageSequenceStepsTable>;
export type ScheduledRow = Selectable<ScheduledMessagesTable>;

/** A step with the template and sequence it belongs to, as the schedule needs it. */
export interface StepContext extends StepRow {
  template_name: string;
  template_title: string;
  template_body: string;
  template_category: TemplateRow['category'];
  sequence_name: string;
}

export function toTemplate(row: TemplateRow): MessageTemplate {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    title: row.title,
    body: row.body,
    placeholders: messagePlaceholdersIn(`${row.title}\n${row.body}`),
    status: row.status,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export const sendTimeOf = (
  step: Pick<StepRow, 'send_time_local'>,
  policy: MessageSequencePolicy,
): string => step.send_time_local ?? policy.defaultSendTimeLocal;

export function toStep(
  row: StepRow & { template_name: string },
  policy: MessageSequencePolicy,
): MessageSequenceStep {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    position: row.position,
    templateId: row.template_id,
    templateName: row.template_name,
    anchor: row.anchor,
    offsetDays: row.offset_days,
    sendTimeLocal: row.send_time_local,
    effectiveSendTimeLocal: sendTimeOf(row, policy),
    retiredAt: isoOrNull(row.retired_at),
    revision: row.revision,
  };
}

export function toSequence(row: SequenceRow, steps: MessageSequenceStep[]): MessageSequence {
  return {
    id: row.id,
    name: row.name,
    facilityId: row.facility_id,
    subjectType: row.subject_type,
    scopeId: row.scope_id,
    active: row.active,
    steps,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The steps of the sequences with their template names, in sequence order. */
export async function loadSteps(
  db: Db | Trx,
  organizationId: string,
  sequenceIds: readonly string[],
): Promise<Array<StepRow & { template_name: string }>> {
  if (sequenceIds.length === 0) return [];
  return db
    .selectFrom('message_sequence_steps as s')
    .innerJoin('message_templates as t', (join) =>
      join.onRef('t.organization_id', '=', 's.organization_id').onRef('t.id', '=', 's.template_id'),
    )
    .selectAll('s')
    .select('t.name as template_name')
    .where('s.organization_id', '=', organizationId)
    .where('s.sequence_id', 'in', [...sequenceIds])
    .orderBy('s.position')
    .orderBy('s.id')
    .execute();
}

/** Steps with everything a scheduled message reads from its template and sequence. */
export async function loadStepContexts(
  db: Db | Trx,
  organizationId: string,
  filter: { stepIds?: readonly string[]; sequenceIds?: readonly string[] },
): Promise<StepContext[]> {
  if (filter.stepIds?.length === 0 || filter.sequenceIds?.length === 0) return [];
  let query = db
    .selectFrom('message_sequence_steps as s')
    .innerJoin('message_templates as t', (join) =>
      join.onRef('t.organization_id', '=', 's.organization_id').onRef('t.id', '=', 's.template_id'),
    )
    .innerJoin('message_sequences as q', (join) =>
      join.onRef('q.organization_id', '=', 's.organization_id').onRef('q.id', '=', 's.sequence_id'),
    )
    .selectAll('s')
    .select([
      't.name as template_name',
      't.title as template_title',
      't.body as template_body',
      't.category as template_category',
      'q.name as sequence_name',
    ])
    .where('s.organization_id', '=', organizationId);
  if (filter.stepIds) query = query.where('s.id', 'in', [...filter.stepIds]);
  if (filter.sequenceIds) query = query.where('s.sequence_id', 'in', [...filter.sequenceIds]);
  return query.orderBy('s.position').orderBy('s.id').execute();
}
