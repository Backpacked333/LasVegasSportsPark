import { Inject, Injectable } from '@nestjs/common';
import {
  AudienceSchema,
  MESSAGE_PLACEHOLDERS,
  ScheduledMessageMachine,
  errors,
  hasPlaceholderMarks,
  messagePlaceholdersIn,
  newId,
  renderMessageText,
  systemPrincipal,
  type Audience,
  type ConfirmScheduledMessageInput,
  type EditScheduledMessageInput,
  type GenerateMessageScheduleInput,
  type MessagePlaceholderName,
  type MessageSchedule,
  type MessageSubject,
  type Principal,
  type RestoreScheduledMessageInput,
  type ScheduledMessage,
  type ScheduledMessagePreview,
  type SkipScheduledMessageInput,
} from '@sportspark/contracts';
import {
  json,
  type Database,
  type Db,
  type ScheduledMessageAttentionValue,
  type ScheduledMessageStatusValue,
} from '@sportspark/db';
import type { UpdateObject } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  FacilityDirectory,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  ensureUpdated,
  listFacilityScope,
  snapshotActor,
  type Clock,
  type FacilitySummary,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { CommunicationsActions } from '../communications.actions';
import {
  MessageScheduleGenerated,
  ScheduledMessageChanged,
  ScheduledMessageSent,
} from '../communications.events';
import { iso, isoOrNull, organizationOf } from '../communications.shared';
import { AudienceResolver } from '../services/audience-resolver';
import { NotificationsService } from '../services/notifications.service';
import { PreferencesService } from '../services/preferences.service';
import { dueTimeOf, sameInstant, type DueTime } from './due-time';
import { MESSAGE_SEQUENCE_POLICY, type MessageSequencePolicy } from './message-sequences.policy';
import {
  loadStepContexts,
  sendTimeOf,
  type ScheduledRow,
  type SequenceRow,
  type StepContext,
} from './message-sequences.shared';
import {
  SubjectFactsReader,
  anchorOf,
  placeholderValues,
  type SubjectAudience,
  type SubjectFacts,
} from './subject-facts';

/** The actor of what the schedule does by itself: produce, follow a moved date, cancel, send. */
export const MESSAGE_SCHEDULE_ACTOR = 'communications.message_schedule';
export const SEND_SCHEDULED_MESSAGES_JOB = 'communications.send_scheduled_messages';

/** The limits one notification's text and audience definition hold (`ModuleComposeNotificationBody`). */
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const MAX_TEAM_ENTRIES = 100;
const MAX_SUBJECT_PERSONS = 500;

/** States from which a message can still change: everything but sent and canceled. */
const OPEN_STATES: readonly ScheduledMessageStatusValue[] = [
  'needs_confirmation',
  'confirmed',
  'skipped',
];

type Change =
  'confirmed' | 'edited' | 'skipped' | 'restored' | 'canceled' | 'rescheduled' | 'reopened';
type Patch = UpdateObject<Database, 'scheduled_messages'>;

/** The columns that belong to one state only, emptied when a message leaves it. */
const NOT_CONFIRMED: Patch = {
  confirmed_title: null,
  confirmed_body: null,
  confirmed_by: null,
  confirmed_at: null,
};
const NOT_SKIPPED: Patch = { skipped_by: null, skipped_at: null, skip_reason: null };

interface Rendered {
  sourceTitle: string;
  sourceBody: string;
  title: string;
  body: string;
  missing: string[];
}

interface Delivery {
  notificationId: string;
  notificationStatus: 'composed' | 'queued' | 'dispatched' | 'suppressed';
  suppressionReason: 'obsolete' | 'no_recipients' | 'authority_revoked' | null;
  recipientCount: number;
}

/** A confirmed message that is due, as the sending job reads it before claiming it. */
export interface DueCandidate {
  id: string;
  organization_id: string;
  facility_id: string;
  due_at: Date;
}

export interface SyncOptions {
  /** Also produce the messages of the sequences that apply and are not there yet. */
  materialize: boolean;
  /** With `materialize`: only sequences of these facilities (a facility-scoped manager). */
  facilityScope?: readonly string[] | null;
  correlationId: string | null;
}

/**
 * The message schedule of a season or an offering (SPK-COMMS-009, proposed amendment PA-05;
 * capability `message_sequences`, DEC-099 pending).
 *
 * - A matching active sequence produces one scheduled message per step, once: the unique index on
 *   (step, record) makes a replayed event, a second worker or a repeated request create nothing.
 * - Nothing is sent until a staff member confirms a message. Confirming stores the exact text,
 *   with the record's real details filled in, and that text is what is sent.
 * - A message follows its anchor date: when the date moves, the due time moves with it and a
 *   confirmed message returns to needing confirmation. The same happens when the text that would
 *   be sent is no longer the text that was confirmed (the template, the step or the record
 *   changed).
 * - A due confirmed message is sent through `NotificationsService.composeAndQueueIn`, with the
 *   audience as a definition (the season's teams, the offering's participants), so recipients,
 *   consent and preferences are resolved at send time (SPK-COMMS-003, SPK-COMMS-006,
 *   SPK-COMMS-007).
 * - A placeholder the record cannot fill is never sent as raw text: the preview names it and
 *   confirming is refused (the database refuses a confirmed text with placeholder marks too).
 */
@Injectable()
export class MessageScheduleService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MESSAGE_SEQUENCE_POLICY) private readonly policy: MessageSequencePolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly facilities: FacilityDirectory,
    private readonly facts: SubjectFactsReader,
    private readonly resolver: AudienceResolver,
    private readonly preferences: PreferencesService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------
  async schedule(principal: Principal, subject: MessageSubject): Promise<MessageSchedule> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CommunicationsActions.readMessageSchedule, {
      type: 'message_schedule',
      organizationId,
    });
    const facts = await this.facts.read(organizationId, subject);
    if (!facts) throw errors.notFound(subject.type, subject.id);
    const reader = this.uow.reader();
    // §4.14: a facility-scoped reader sees the messages of their facilities only.
    const scope = listFacilityScope(principal, CommunicationsActions.readMessageSchedule);
    let query = reader
      .selectFrom('scheduled_messages')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_type', '=', subject.type)
      .where('subject_id', '=', subject.id);
    if (scope) {
      if (scope.length === 0) query = query.where('id', 'is', null);
      else query = query.where('facility_id', 'in', [...scope]);
    }
    const rows = await query.execute();
    const sequences = (await this.matchingSequences(reader, organizationId, facts)).filter(
      (s) => !scope || scope.includes(s.facility_id),
    );
    const messages = await this.views(reader, organizationId, rows, facts);
    const facilityId = facts.facilityId ?? rows[0]?.facility_id ?? sequences[0]?.facility_id;
    const facility = facilityId
      ? (await this.facilities.describe(organizationId, [facilityId])).get(facilityId)
      : undefined;
    return {
      subject,
      subjectName: facts.name,
      facilityId: facility?.id ?? null,
      timezone: facility?.timezone ?? null,
      sequences: sequences.map((s) => ({ id: s.id, name: s.name })),
      messages,
    };
  }

  async get(principal: Principal, id: string): Promise<ScheduledMessage> {
    const organizationId = organizationOf(principal);
    const reader = this.uow.reader();
    const row = await this.load(reader, organizationId, id);
    if (!row) throw errors.notFound('scheduled_message', id);
    await this.authorization.require(principal, CommunicationsActions.readMessageSchedule, {
      type: 'scheduled_message',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    return this.view(reader, organizationId, row);
  }

  /**
   * SPK-COMMS-006: the text with the record's real details, what is missing, and who would
   * receive it now, by name and count only. Recipients are resolved from current permissions
   * here and again when the message is sent.
   */
  async preview(principal: Principal, id: string): Promise<ScheduledMessagePreview> {
    const organizationId = organizationOf(principal);
    const reader = this.uow.reader();
    const row = await this.load(reader, organizationId, id);
    if (!row) throw errors.notFound('scheduled_message', id);
    await this.authorization.require(principal, CommunicationsActions.previewScheduledMessage, {
      type: 'scheduled_message',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    const step = await this.stepOf(reader, organizationId, row.sequence_step_id);
    const facility = await this.facilityOf(organizationId, row.facility_id);
    const subject: MessageSubject = { type: row.subject_type, id: row.subject_id };
    const facts = await this.facts.read(organizationId, subject);
    const rendered = this.render(row, step, facts, facility);
    const fixed = row.status === 'confirmed' || row.status === 'sent';
    const title = fixed ? (row.confirmed_title as string) : rendered.title;
    const body = fixed ? (row.confirmed_body as string) : rendered.body;
    const due = facts ? this.dueOf(step, facts, facility) : null;
    const blockers: ScheduledMessagePreview['blockers'] = [];
    if (row.status !== 'needs_confirmation') blockers.push('not_awaiting_confirmation');
    else {
      if (rendered.missing.length > 0 || hasPlaceholderMarks(`${title}${body}`)) {
        blockers.push('missing_placeholder');
      }
      if (!due) blockers.push('no_due_time');
      if (title.length > TITLE_MAX || body.length > BODY_MAX) blockers.push('text_too_long');
    }
    const audience = facts ? await this.facts.audience(organizationId, subject) : null;
    const tooLarge = audience ? isTooLarge(audience) : false;
    const entries: ScheduledMessagePreview['recipients']['entries'] = [];
    if (audience && !tooLarge && !isEmpty(audience)) {
      const resolved = await this.resolver.resolve(organizationId, audienceOf(audience));
      const names = await this.persons.displayNames(
        organizationId,
        resolved.map((r) => r.personId),
      );
      for (const recipient of resolved) {
        const channels = await this.preferences.enabledChannels(
          reader,
          organizationId,
          recipient.personId,
          step.template_category,
        );
        entries.push({
          personId: recipient.personId,
          displayName: names.get(recipient.personId)?.displayName ?? 'Unknown person',
          basis: recipient.basis,
          reachable: channels.length > 0,
        });
      }
      entries.sort(
        (a, b) => a.displayName.localeCompare(b.displayName) || (a.personId < b.personId ? -1 : 1),
      );
    }
    return {
      scheduledMessageId: row.id,
      status: row.status,
      category: step.template_category,
      title,
      body,
      missingPlaceholders: (fixed ? [] : rendered.missing).map((name) => ({
        name,
        label: MESSAGE_PLACEHOLDERS[name as MessagePlaceholderName]?.label ?? name,
      })),
      dueAt: fixed ? isoOrNull(row.due_at) : due ? iso(due.dueAt) : null,
      blockers,
      recipients: {
        resolvedAt: iso(this.clock.now()),
        count: entries.length,
        reachableCount: entries.filter((e) => e.reachable).length,
        tooLarge,
        entries,
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Commands (staff)
  // -------------------------------------------------------------------------------------------
  /**
   * Produces the schedule of a season or an offering from the active sequences that apply, for a
   * record that existed before its sequence did. Existing messages are kept (one per step and
   * record); their due times are brought up to date.
   */
  async generate(
    principal: Principal,
    subject: MessageSubject,
    input: GenerateMessageScheduleInput,
    correlationId: string | null,
  ): Promise<MessageSchedule> {
    const organizationId = organizationOf(principal);
    await this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, CommunicationsActions.manageMessageSequences, {
        type: 'message_schedule',
        organizationId,
      });
      await this.capabilities.require(organizationId, 'message_sequences', trx);
      const facts = await this.facts.read(organizationId, subject);
      if (!facts) throw errors.notFound(subject.type, subject.id);
      if (facts.closed) {
        throw errors.resourceConflict(`This ${subject.type} is archived: it gets no messages.`, {
          code: 'RECORD_ARCHIVED',
        });
      }
      await this.syncSubjectIn(trx, principal, organizationId, subject, {
        materialize: true,
        facilityScope: listFacilityScope(principal, CommunicationsActions.manageMessageSequences),
        correlationId,
        reason: input.reason ?? null,
      });
    });
    return this.schedule(principal, subject);
  }

  /**
   * Keeps an edited copy of title and body for this message only, or drops it (both null). The
   * template is never changed. A confirmed message returns to needing confirmation: what was
   * confirmed is no longer what would be sent.
   */
  async edit(
    principal: Principal,
    id: string,
    input: EditScheduledMessageInput,
    correlationId: string | null,
  ): Promise<ScheduledMessage> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockForStaff(trx, principal, organizationId, id, 'confirm');
      await this.capabilities.require(organizationId, 'message_sequences', trx);
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (row.status !== 'needs_confirmation' && row.status !== 'confirmed') {
        throw errors.invalidTransition(ScheduledMessageMachine.name, row.status, 'edit');
      }
      const status =
        row.status === 'confirmed'
          ? ScheduledMessageMachine.next(row.status, 'reopen')
          : row.status;
      const edited = input.title !== null && input.body !== null;
      const updated = await this.apply(
        trx,
        principal,
        row,
        {
          status,
          ...NOT_CONFIRMED,
          attention: null,
          edited_title: edited ? input.title : null,
          edited_body: edited ? input.body : null,
          edited_by: edited ? json(snapshotActor(principal)) : null,
          edited_at: edited ? this.clock.now() : null,
        },
        {
          action: CommunicationsActions.confirmScheduledMessage.id,
          change: 'edited',
          reason: input.reason ?? null,
          correlationId,
          details: { operation: 'edit', edited, reopened: row.status === 'confirmed' },
        },
      );
      return this.view(trx, organizationId, updated);
    });
  }

  /**
   * Confirms the message: the text with the record's details as they are now is stored and is
   * what will be sent when the message is due. Refused while a placeholder cannot be filled, the
   * record has no date to count from, or the filled-in text is longer than a notice may be.
   */
  async confirm(
    principal: Principal,
    id: string,
    input: ConfirmScheduledMessageInput,
    correlationId: string | null,
  ): Promise<ScheduledMessage> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockForStaff(trx, principal, organizationId, id, 'confirm');
      await this.capabilities.require(organizationId, 'message_sequences', trx);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = ScheduledMessageMachine.next(row.status, 'confirm');
      const subject: MessageSubject = { type: row.subject_type, id: row.subject_id };
      const facts = await this.facts.read(organizationId, subject);
      if (!facts || facts.closed) {
        throw errors.resourceConflict(
          `The ${subject.type} this message is about is archived or no longer there.`,
          { code: 'RECORD_ARCHIVED' },
        );
      }
      const step = await this.stepOf(trx, organizationId, row.sequence_step_id);
      const facility = await this.facilityOf(organizationId, row.facility_id);
      const due = this.dueOf(step, facts, facility);
      if (!due) {
        throw errors.validation(
          `The ${subject.type} has no date for "${step.anchor.replaceAll('_', ' ')}" yet, so the message has no time to be sent at.`,
          { code: 'NO_DUE_TIME', anchor: step.anchor },
        );
      }
      const rendered = this.render(row, step, facts, facility);
      if (rendered.missing.length > 0 || hasPlaceholderMarks(rendered.title + rendered.body)) {
        throw errors.validation(
          `The message cannot be confirmed while a placeholder is not filled: ${
            rendered.missing.map((name) => `{{${name}}}`).join(', ') || 'unreadable placeholder'
          }. Fill it on the ${subject.type}, or edit the text of this message.`,
          { code: 'UNFILLED_PLACEHOLDER', missing: rendered.missing },
        );
      }
      if (rendered.title.length > TITLE_MAX || rendered.body.length > BODY_MAX) {
        throw errors.validation(
          `With its details filled in the message is too long (title up to ${TITLE_MAX} characters, text up to ${BODY_MAX}). Edit the text of this message.`,
          { code: 'TEXT_TOO_LONG', title: rendered.title.length, body: rendered.body.length },
        );
      }
      const now = this.clock.now();
      const updated = await this.apply(
        trx,
        principal,
        row,
        {
          status,
          attention: null,
          anchor_at: due.anchorAt,
          due_at: due.dueAt,
          confirmed_title: rendered.title,
          confirmed_body: rendered.body,
          confirmed_by: json(snapshotActor(principal)),
          confirmed_at: now,
        },
        {
          action: CommunicationsActions.confirmScheduledMessage.id,
          change: 'confirmed',
          reason: input.reason ?? null,
          correlationId,
          details: {
            operation: 'confirm',
            dueAt: iso(due.dueAt),
            edited: row.edited_title !== null,
          },
        },
      );
      return this.view(trx, organizationId, updated);
    });
  }

  /** Skips the message: it is not sent. Never needs the capability (it creates nothing). */
  async skip(
    principal: Principal,
    id: string,
    input: SkipScheduledMessageInput,
    correlationId: string | null,
  ): Promise<ScheduledMessage> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockForStaff(trx, principal, organizationId, id, 'skip');
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = ScheduledMessageMachine.next(row.status, 'skip');
      const updated = await this.apply(
        trx,
        principal,
        row,
        {
          status,
          ...NOT_CONFIRMED,
          attention: null,
          skipped_by: json(snapshotActor(principal)),
          skipped_at: this.clock.now(),
          skip_reason: input.reason ?? null,
        },
        {
          action: CommunicationsActions.skipScheduledMessage.id,
          change: 'skipped',
          reason: input.reason ?? null,
          correlationId,
          details: { operation: 'skip' },
        },
      );
      return this.view(trx, organizationId, updated);
    });
  }

  /** Brings a skipped message back: it needs confirming before anything is sent. */
  async restore(
    principal: Principal,
    id: string,
    input: RestoreScheduledMessageInput,
    correlationId: string | null,
  ): Promise<ScheduledMessage> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockForStaff(trx, principal, organizationId, id, 'confirm');
      await this.capabilities.require(organizationId, 'message_sequences', trx);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = ScheduledMessageMachine.next(row.status, 'restore');
      const restored = await this.apply(
        trx,
        principal,
        row,
        { status, ...NOT_SKIPPED, attention: null },
        {
          action: CommunicationsActions.confirmScheduledMessage.id,
          change: 'restored',
          reason: input.reason ?? null,
          correlationId,
          details: { operation: 'restore' },
        },
      );
      // Its date may have moved while it was skipped.
      const reviewed = await this.reviewIn(trx, principal, organizationId, restored, correlationId);
      return this.view(trx, organizationId, reviewed ?? restored);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Following the record (event handlers, step and template changes)
  // -------------------------------------------------------------------------------------------
  /**
   * The record was created, published or changed. `materialize` produces the messages of the
   * sequences that apply, and only while the organization has message sequences turned on: with
   * the switch off nothing is created. Messages that already exist always follow the record (a
   * moved date moves the due time and asks for confirmation again; an archived record cancels
   * its unsent messages), switch on or off: that only keeps what exists truthful and sends
   * nothing. Idempotent under replay: every write is guarded by the row's current state.
   */
  async onSubjectEvent(
    trx: Trx,
    organizationId: string,
    subject: MessageSubject,
    mode: 'materialize' | 'follow',
    correlationId: string | null,
  ): Promise<void> {
    const materialize =
      mode === 'materialize' &&
      (await this.capabilities.isEnabled(organizationId, 'message_sequences', trx));
    await this.syncSubjectIn(
      trx,
      systemPrincipal(organizationId, MESSAGE_SCHEDULE_ACTOR),
      organizationId,
      subject,
      { materialize, correlationId, reason: null },
    );
  }

  /** A step changed: its unsent messages follow (new due time, new text to confirm). */
  async followStep(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    stepId: string,
    correlationId: string | null,
  ): Promise<void> {
    await this.followWhere(trx, actor, organizationId, { stepIds: [stepId] }, correlationId);
  }

  /** A template changed: confirmed messages made from it no longer hold the text that stands. */
  async followTemplate(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    templateId: string,
    correlationId: string | null,
  ): Promise<void> {
    const steps = await trx
      .selectFrom('message_sequence_steps')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('template_id', '=', templateId)
      .execute();
    await this.followWhere(
      trx,
      actor,
      organizationId,
      { stepIds: steps.map((s) => s.id) },
      correlationId,
    );
  }

  /** A step was removed: its unsent messages are canceled; what was sent is kept. */
  async cancelForStep(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    stepId: string,
    correlationId: string | null,
  ): Promise<number> {
    const rows = await trx
      .selectFrom('scheduled_messages')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('sequence_step_id', '=', stepId)
      .where('status', 'in', [...OPEN_STATES])
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const row of rows) await this.cancel(trx, actor, row, 'step_removed', correlationId);
    return rows.length;
  }

  private async followWhere(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    filter: { stepIds: readonly string[] },
    correlationId: string | null,
  ): Promise<void> {
    if (filter.stepIds.length === 0) return;
    const subjects = await trx
      .selectFrom('scheduled_messages')
      .select(['subject_type', 'subject_id'])
      .distinct()
      .where('organization_id', '=', organizationId)
      .where('sequence_step_id', 'in', [...filter.stepIds])
      .where('status', 'in', [...OPEN_STATES])
      .orderBy('subject_id')
      .execute();
    for (const subject of subjects) {
      await this.syncSubjectIn(
        trx,
        actor,
        organizationId,
        { type: subject.subject_type, id: subject.subject_id },
        { materialize: false, correlationId, reason: null },
      );
    }
  }

  /**
   * Brings the record's schedule up to date in the caller's transaction: optionally produces the
   * missing messages, then reviews every message that can still change against the record's
   * facts as they are now.
   */
  private async syncSubjectIn(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    subject: MessageSubject,
    options: SyncOptions & { reason: string | null },
  ): Promise<void> {
    const open = await trx
      .selectFrom('scheduled_messages')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_type', '=', subject.type)
      .where('subject_id', '=', subject.id)
      .where('status', 'in', [...OPEN_STATES])
      .orderBy('id')
      .forUpdate()
      .execute();
    if (open.length === 0 && !options.materialize) return; // nothing to produce, nothing to follow
    const facts = await this.facts.read(organizationId, subject);
    if (options.materialize && facts && !facts.closed) {
      await this.materializeIn(trx, actor, organizationId, facts, options);
    }
    if (open.length === 0) return;
    const steps = new Map(
      (
        await loadStepContexts(trx, organizationId, {
          stepIds: [...new Set(open.map((r) => r.sequence_step_id))],
        })
      ).map((s) => [s.id, s]),
    );
    const facilities = await this.facilities.describe(organizationId, [
      ...new Set(open.map((r) => r.facility_id)),
    ]);
    for (const row of open) {
      const step = steps.get(row.sequence_step_id);
      const facility = facilities.get(row.facility_id);
      if (!step || !facility) throw errors.internal(`scheduled message ${row.id} lost its step`);
      await this.review(trx, actor, row, step, facts, facility, options.correlationId);
    }
  }

  /** The active sequences that apply to the record. */
  private async matchingSequences(
    db: Db | Trx,
    organizationId: string,
    facts: SubjectFacts,
  ): Promise<SequenceRow[]> {
    let query = db
      .selectFrom('message_sequences')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_type', '=', facts.subject.type)
      .where('active', '=', true)
      .where((eb) => eb.or([eb('scope_id', 'is', null), eb('scope_id', '=', facts.scopeId)]));
    // An offering belongs to a facility, and so do the sequences that apply to it. A season
    // belongs to none: the sequence's facility gives the clock its times are read in.
    if (facts.facilityId) query = query.where('facility_id', '=', facts.facilityId);
    return query.orderBy('name').orderBy('id').execute();
  }

  /**
   * One scheduled message per live step of every sequence that applies. The unique index on
   * (step, record) answers a second insert with nothing, so a replay creates nothing twice.
   */
  private async materializeIn(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    facts: SubjectFacts,
    options: SyncOptions & { reason: string | null },
  ): Promise<void> {
    const sequences = (await this.matchingSequences(trx, organizationId, facts)).filter(
      (s) => !options.facilityScope || options.facilityScope.includes(s.facility_id),
    );
    if (sequences.length === 0) return;
    const steps = (
      await loadStepContexts(trx, organizationId, { sequenceIds: sequences.map((s) => s.id) })
    ).filter((s) => s.retired_at === null);
    const facilities = await this.facilities.describe(
      organizationId,
      sequences.map((s) => s.facility_id),
    );
    for (const sequence of sequences) {
      const facility = facilities.get(sequence.facility_id);
      if (!facility) throw errors.internal(`message sequence ${sequence.id} lost its facility`);
      const created: string[] = [];
      for (const step of steps.filter((s) => s.sequence_id === sequence.id)) {
        const due = this.dueOf(step, facts, facility);
        const inserted = await trx
          .insertInto('scheduled_messages')
          .values({
            id: newId(),
            organization_id: organizationId,
            facility_id: sequence.facility_id,
            sequence_id: sequence.id,
            sequence_step_id: step.id,
            subject_type: facts.subject.type,
            subject_id: facts.subject.id,
            anchor_at: due?.anchorAt ?? null,
            due_at: due?.dueAt ?? null,
            status: ScheduledMessageMachine.initial,
          })
          .onConflict((oc) =>
            oc
              .columns(['organization_id', 'sequence_step_id', 'subject_type', 'subject_id'])
              .doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        if (inserted) created.push(inserted.id);
      }
      if (created.length === 0) continue;
      await this.audit.record(trx, {
        organizationId,
        actor,
        action: CommunicationsActions.manageMessageSequences.id,
        targetType: 'message_schedule',
        targetId: facts.subject.id,
        reason: options.reason,
        correlationId: options.correlationId,
        details: {
          operation: 'generate_schedule',
          subjectType: facts.subject.type,
          sequenceId: sequence.id,
          scheduledMessageIds: created,
        },
      });
      await this.outbox.enqueue(trx, MessageScheduleGenerated, {
        organizationId,
        aggregateType: 'message_schedule',
        aggregateId: facts.subject.id,
        payload: {
          subjectType: facts.subject.type,
          subjectId: facts.subject.id,
          sequenceId: sequence.id,
          scheduledMessageIds: created,
        },
        correlationId: options.correlationId,
      });
    }
  }

  /**
   * Reviews one locked message that can still change against the record as it is now. Returns
   * the message as it stands, or null when it was canceled.
   *
   * - The record is archived or gone, or the step was removed: canceled.
   * - The due time differs: it follows; a confirmed message needs confirming again
   *   (`anchor_moved`).
   * - Confirmed, and the text that would be sent now is not the text that was confirmed (or a
   *   placeholder can no longer be filled): needs confirming again (`text_changed`).
   */
  private async review(
    trx: Trx,
    actor: Principal,
    row: ScheduledRow,
    step: StepContext,
    facts: SubjectFacts | null,
    facility: FacilitySummary,
    correlationId: string | null,
  ): Promise<ScheduledRow | null> {
    if (!facts || facts.closed) {
      await this.cancel(trx, actor, row, 'record_archived', correlationId);
      return null;
    }
    if (step.retired_at !== null) {
      await this.cancel(trx, actor, row, 'step_removed', correlationId);
      return null;
    }
    const due = this.dueOf(step, facts, facility);
    const moved =
      !sameInstant(row.due_at, due?.dueAt ?? null) ||
      !sameInstant(row.anchor_at, due?.anchorAt ?? null);
    let attention: ScheduledMessageAttentionValue | null = null;
    if (row.status === 'confirmed') {
      if (moved) attention = 'anchor_moved';
      else {
        const rendered = this.render(row, step, facts, facility);
        if (
          rendered.missing.length > 0 ||
          rendered.title !== row.confirmed_title ||
          rendered.body !== row.confirmed_body
        ) {
          attention = 'text_changed';
        }
      }
    }
    if (!moved && !attention) return row;
    return this.apply(
      trx,
      actor,
      row,
      {
        anchor_at: due?.anchorAt ?? null,
        due_at: due?.dueAt ?? null,
        ...(attention
          ? {
              status: ScheduledMessageMachine.next(row.status, 'reopen'),
              attention,
              ...NOT_CONFIRMED,
            }
          : {}),
      },
      {
        action: 'communications.follow_scheduled_message',
        change: attention ? 'reopened' : 'rescheduled',
        reason: null,
        correlationId,
        details: {
          operation: attention ? 'reopen' : 'reschedule',
          attention,
          previousDueAt: isoOrNull(row.due_at),
          dueAt: due ? iso(due.dueAt) : null,
        },
      },
    );
  }

  /** Reviews one message whose row the caller holds locked (reads its own step and facts). */
  private async reviewIn(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    row: ScheduledRow,
    correlationId: string | null,
  ): Promise<ScheduledRow | null> {
    const step = await this.stepOf(trx, organizationId, row.sequence_step_id);
    const facility = await this.facilityOf(organizationId, row.facility_id);
    const facts = await this.facts.read(organizationId, {
      type: row.subject_type,
      id: row.subject_id,
    });
    return this.review(trx, actor, row, step, facts, facility, correlationId);
  }

  private async cancel(
    trx: Trx,
    actor: Principal,
    row: ScheduledRow,
    reason: 'record_archived' | 'step_removed',
    correlationId: string | null,
  ): Promise<void> {
    await this.apply(
      trx,
      actor,
      row,
      {
        status: ScheduledMessageMachine.next(row.status, 'cancel'),
        ...NOT_CONFIRMED,
        ...NOT_SKIPPED,
        attention: null,
        canceled_at: this.clock.now(),
        cancel_reason: reason,
      },
      {
        action: 'communications.cancel_scheduled_message',
        change: 'canceled',
        reason: null,
        correlationId,
        details: { operation: 'cancel', cause: reason },
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Sending (the periodic job)
  // -------------------------------------------------------------------------------------------
  /**
   * Confirmed messages that are due, oldest first, after the one a previous page ended on (the
   * job's candidates; nothing is locked). The job pages through them, so messages it cannot send
   * now (an organization with the switch off, a message that fails) never hold back the rest.
   */
  async dueCandidates(
    now: Date,
    limit: number,
    after: DueCandidate | null,
  ): Promise<DueCandidate[]> {
    let query = this.uow
      .reader()
      .selectFrom('scheduled_messages')
      .select(['id', 'organization_id', 'facility_id', 'due_at'])
      .where('status', '=', 'confirmed')
      .where('due_at', '<=', now);
    if (after) {
      query = query.where((eb) =>
        eb.or([
          eb('due_at', '>', after.due_at),
          eb.and([eb('due_at', '=', after.due_at), eb('id', '>', after.id)]),
        ]),
      );
    }
    const rows = await query.orderBy('due_at').orderBy('id').limit(limit).execute();
    return rows.map((row) => ({ ...row, due_at: new Date(row.due_at as Date) }));
  }

  /** Whether the organization has message sequences turned on (the job asks once per run). */
  sendingEnabled(organizationId: string): Promise<boolean> {
    return this.capabilities.isEnabled(organizationId, 'message_sequences');
  }

  /**
   * Sends one due message in its own transaction, or does what stands in its way: the row is
   * claimed with `FOR UPDATE SKIP LOCKED` and re-read, so a second worker, a replayed pass or a
   * message staff skipped a moment ago sends nothing. Before sending, the message is reviewed
   * like any other change of its record (a moved date or a changed text sends nothing and asks
   * for confirmation). The audience is a definition resolved by the notification path now, never
   * a list kept from the preview. Returns whether the row was handled.
   */
  async sendDue(organizationId: string, id: string, now: Date): Promise<boolean> {
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('scheduled_messages')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('status', '=', 'confirmed')
        .where('due_at', '<=', now)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return false; // sent, skipped or moved meanwhile, or another worker holds it
      // With the switch off nothing is sent; the confirmed message waits as it is.
      if (!(await this.capabilities.isEnabled(organizationId, 'message_sequences', trx))) {
        return false;
      }
      const actor = systemPrincipal(organizationId, SEND_SCHEDULED_MESSAGES_JOB);
      const correlationId = `scheduled-message:${row.id}`;
      const reviewed = await this.reviewIn(trx, actor, organizationId, row, correlationId);
      // Canceled, or returned to needing confirmation (a moved date, a changed text): not sent.
      if (!reviewed || reviewed.status !== 'confirmed') return true;
      const subject: MessageSubject = { type: row.subject_type, id: row.subject_id };
      const audience = await this.facts.audience(organizationId, subject);
      const blocked: ScheduledMessageAttentionValue | null = isEmpty(audience)
        ? 'no_audience'
        : isTooLarge(audience)
          ? 'audience_too_large'
          : null;
      if (blocked) {
        await this.apply(
          trx,
          actor,
          reviewed,
          {
            status: ScheduledMessageMachine.next(reviewed.status, 'reopen'),
            attention: blocked,
            ...NOT_CONFIRMED,
          },
          {
            action: 'communications.follow_scheduled_message',
            change: 'reopened',
            reason: null,
            correlationId,
            details: { operation: 'reopen', attention: blocked },
          },
        );
        return true;
      }
      const step = await this.stepOf(trx, organizationId, row.sequence_step_id);
      const notification = await this.notifications.composeAndQueueIn(trx, actor, {
        kind: this.policy.noticeKind,
        category: step.template_category,
        facilityId: row.facility_id,
        subject: { type: row.subject_type, id: row.subject_id },
        audience: audienceOf(audience),
        title: reviewed.confirmed_title as string,
        body: reviewed.confirmed_body as string,
        // Who is enrolled in an offering is customer-private: its recipients are re-checked
        // against current authority before dispatch (§4.7 invariant 10). A season's teams are
        // addressed as teams, like its results.
        protected: row.subject_type === 'offering',
        correlationId,
      });
      const status = ScheduledMessageMachine.next(reviewed.status, 'send');
      const result = await trx
        .updateTable('scheduled_messages')
        .set({
          status,
          notification_id: notification.id,
          sent_at: now,
          revision: reviewed.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .where('revision', '=', reviewed.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(reviewed.revision, reviewed.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor,
        action: 'communications.send_scheduled_message',
        targetType: 'scheduled_message',
        targetId: row.id,
        beforeRevision: reviewed.revision,
        afterRevision: reviewed.revision + 1,
        correlationId,
        details: {
          notificationId: notification.id,
          notificationStatus: notification.status,
          confirmedBy: reviewed.confirmed_by,
          dueAt: isoOrNull(reviewed.due_at),
        },
      });
      await this.outbox.enqueue(trx, ScheduledMessageSent, {
        organizationId,
        aggregateType: 'scheduled_message',
        aggregateId: row.id,
        payload: {
          scheduledMessageId: row.id,
          notificationId: notification.id,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
        },
        correlationId,
      });
      return true;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  private dueOf(step: StepContext, facts: SubjectFacts, facility: FacilitySummary): DueTime | null {
    const anchor = anchorOf(facts, step.anchor);
    if (!anchor) return null;
    return dueTimeOf(anchor, step.offset_days, sendTimeOf(step, this.policy), facility.timezone);
  }

  /** The title and body with the record's details filled in, and what could not be filled. */
  private render(
    row: ScheduledRow,
    step: StepContext,
    facts: SubjectFacts | null,
    facility: FacilitySummary,
  ): Rendered {
    const sourceTitle = row.edited_title ?? step.template_title;
    const sourceBody = row.edited_body ?? step.template_body;
    if (!facts) {
      return {
        sourceTitle,
        sourceBody,
        title: sourceTitle,
        body: sourceBody,
        missing: messagePlaceholdersIn(`${sourceTitle}\n${sourceBody}`),
      };
    }
    const values = placeholderValues(facts, facility.timezone, facility.name);
    const title = renderMessageText(sourceTitle, values);
    const body = renderMessageText(sourceBody, values);
    return {
      sourceTitle,
      sourceBody,
      title: title.text,
      body: body.text,
      missing: [...new Set([...title.missing, ...body.missing])],
    };
  }

  private async lockForStaff(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    id: string,
    intent: 'confirm' | 'skip',
  ): Promise<ScheduledRow> {
    const row = await trx
      .selectFrom('scheduled_messages')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('scheduled_message', id);
    await this.authorization.require(
      principal,
      intent === 'skip'
        ? CommunicationsActions.skipScheduledMessage
        : CommunicationsActions.confirmScheduledMessage,
      { type: 'scheduled_message', id, organizationId, facilityId: row.facility_id },
    );
    return row;
  }

  /** One guarded update of a locked row, with its audit record and its event. */
  private async apply(
    trx: Trx,
    actor: Principal,
    row: ScheduledRow,
    patch: Patch,
    meta: {
      action: string;
      change: Change;
      reason: string | null;
      correlationId: string | null;
      details: Record<string, unknown>;
    },
  ): Promise<ScheduledRow> {
    const result = await trx
      .updateTable('scheduled_messages')
      .set({ ...patch, revision: row.revision + 1 })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .executeTakeFirst();
    ensureUpdated(result.numUpdatedRows, () =>
      errors.staleRevision(row.revision, row.revision + 1),
    );
    const updated = await this.load(trx, row.organization_id, row.id);
    if (!updated) throw errors.internal('scheduled message vanished after update');
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor,
      action: meta.action,
      targetType: 'scheduled_message',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: updated.revision,
      reason: meta.reason,
      correlationId: meta.correlationId,
      details: { ...meta.details, status: updated.status, previousStatus: row.status },
    });
    await this.outbox.enqueue(trx, ScheduledMessageChanged, {
      organizationId: row.organization_id,
      aggregateType: 'scheduled_message',
      aggregateId: row.id,
      payload: {
        scheduledMessageId: row.id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        change: meta.change,
        status: updated.status,
        previousStatus: row.status,
        attention: updated.attention,
        dueAt: isoOrNull(updated.due_at),
      },
      correlationId: meta.correlationId,
    });
    return updated;
  }

  private async load(
    db: Db | Trx,
    organizationId: string,
    id: string,
  ): Promise<ScheduledRow | null> {
    const row = await db
      .selectFrom('scheduled_messages')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ?? null;
  }

  private async stepOf(db: Db | Trx, organizationId: string, stepId: string): Promise<StepContext> {
    const [step] = await loadStepContexts(db, organizationId, { stepIds: [stepId] });
    if (!step) throw errors.internal(`message sequence step ${stepId} is missing`);
    return step;
  }

  private async facilityOf(organizationId: string, facilityId: string): Promise<FacilitySummary> {
    const facility = (await this.facilities.describe(organizationId, [facilityId])).get(facilityId);
    if (!facility) throw errors.internal(`facility ${facilityId} is missing`);
    return facility;
  }

  private async view(
    db: Db | Trx,
    organizationId: string,
    row: ScheduledRow,
  ): Promise<ScheduledMessage> {
    const facts = await this.facts.read(organizationId, {
      type: row.subject_type,
      id: row.subject_id,
    });
    const [view] = await this.views(db, organizationId, [row], facts);
    return view as ScheduledMessage;
  }

  /** The messages as staff read them, in the order they are due (undated ones last). */
  private async views(
    db: Db | Trx,
    organizationId: string,
    rows: ScheduledRow[],
    facts: SubjectFacts | null,
  ): Promise<ScheduledMessage[]> {
    if (rows.length === 0) return [];
    const steps = new Map(
      (
        await loadStepContexts(db, organizationId, {
          stepIds: [...new Set(rows.map((r) => r.sequence_step_id))],
        })
      ).map((s) => [s.id, s]),
    );
    const facilities = await this.facilities.describe(organizationId, [
      ...new Set(rows.map((r) => r.facility_id)),
    ]);
    const deliveries = await this.deliveries(
      db,
      organizationId,
      rows.flatMap((r) => (r.notification_id ? [r.notification_id] : [])),
    );
    const views = rows.map((row) => {
      const step = steps.get(row.sequence_step_id);
      const facility = facilities.get(row.facility_id);
      if (!step || !facility) throw errors.internal(`scheduled message ${row.id} lost its step`);
      const rendered = this.render(row, step, facts, facility);
      const fixed = row.status === 'confirmed' || row.status === 'sent';
      const delivery = row.notification_id ? deliveries.get(row.notification_id) : undefined;
      const view: ScheduledMessage = {
        id: row.id,
        facilityId: row.facility_id,
        subject: { type: row.subject_type, id: row.subject_id },
        sequenceId: row.sequence_id,
        sequenceName: step.sequence_name,
        stepId: step.id,
        templateId: step.template_id,
        templateName: step.template_name,
        category: step.template_category,
        anchor: step.anchor,
        offsetDays: step.offset_days,
        sendTimeLocal: sendTimeOf(step, this.policy),
        anchorAt: isoOrNull(row.anchor_at),
        dueAt: isoOrNull(row.due_at),
        status: row.status,
        attention: row.attention,
        edited: row.edited_title !== null,
        title: fixed ? (row.confirmed_title as string) : rendered.title,
        body: fixed ? (row.confirmed_body as string) : rendered.body,
        sourceTitle: rendered.sourceTitle,
        sourceBody: rendered.sourceBody,
        missingPlaceholders: fixed ? [] : rendered.missing,
        confirmedAt: isoOrNull(row.confirmed_at),
        skippedAt: isoOrNull(row.skipped_at),
        skipReason: row.skip_reason,
        canceledAt: isoOrNull(row.canceled_at),
        cancelReason: row.cancel_reason,
        sentAt: isoOrNull(row.sent_at),
        delivery: delivery ?? null,
        revision: row.revision,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
      return { view, position: step.position };
    });
    const dueKey = (m: ScheduledMessage): number =>
      m.dueAt ? new Date(m.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return views
      .sort(
        (a, b) =>
          dueKey(a.view) - dueKey(b.view) ||
          a.position - b.position ||
          (a.view.id < b.view.id ? -1 : 1),
      )
      .map((v) => v.view);
  }

  /** What each sent message produced: the notification's actual state and how many it reached. */
  private async deliveries(
    db: Db | Trx,
    organizationId: string,
    notificationIds: readonly string[],
  ): Promise<Map<string, Delivery>> {
    const out = new Map<string, Delivery>();
    if (notificationIds.length === 0) return out;
    const notices = await db
      .selectFrom('notifications')
      .select(['id', 'status', 'suppression_reason'])
      .where('organization_id', '=', organizationId)
      .where('id', 'in', [...notificationIds])
      .execute();
    const counts = await db
      .selectFrom('notification_recipients')
      .select(({ fn }) => ['notification_id', fn.countAll<string>().as('recipients')])
      .where('organization_id', '=', organizationId)
      .where('notification_id', 'in', [...notificationIds])
      .groupBy('notification_id')
      .execute();
    const byNotice = new Map(counts.map((c) => [c.notification_id, Number(c.recipients)]));
    for (const notice of notices) {
      out.set(notice.id, {
        notificationId: notice.id,
        notificationStatus: notice.status,
        suppressionReason: notice.suppression_reason,
        recipientCount: byNotice.get(notice.id) ?? 0,
      });
    }
    return out;
  }
}

const isEmpty = (audience: SubjectAudience): boolean =>
  audience.teamEntryIds.length === 0 && audience.subjectPersonIds.length === 0;

/** One notification addresses at most this many teams and people (`AudienceSchema`). */
const isTooLarge = (audience: SubjectAudience): boolean =>
  audience.teamEntryIds.length > MAX_TEAM_ENTRIES ||
  audience.subjectPersonIds.length > MAX_SUBJECT_PERSONS;

const audienceOf = (audience: SubjectAudience): Audience =>
  AudienceSchema.parse({
    teamEntryIds: audience.teamEntryIds,
    subjectPersonIds: audience.subjectPersonIds,
  });
