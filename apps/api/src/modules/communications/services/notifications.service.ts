import { Inject, Injectable } from '@nestjs/common';
import {
  ModuleComposeNotificationBody,
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  systemPrincipal,
  z,
  type Audience,
  type DeliveryFailureCodeValue,
  type ListNotificationsQuery,
  type Notification,
  type NotificationCategoryValue,
  type NotificationKindValue,
  type NotificationDeliveries,
  type Page,
  type Principal,
  type RecipientPreview,
  type SuppressionReasonSchema,
} from '@sportspark/contracts';
import { json, type Db, type DeliveryAttemptsTable } from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type ActionDefinition,
  type Clock,
  type Trx,
  listFacilityScope,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, PeopleService, type PersonDirectoryPort } from '../../identity';
import { CommunicationsActions } from '../communications.actions';
import {
  DeliveryDelivered,
  DeliveryFailed,
  DeliveryRequested,
  NotificationComposed,
  NotificationDispatched,
  NotificationQueued,
  NotificationSuppressed,
  RecipientRevoked,
} from '../communications.events';
import {
  DeliveryAttemptMachine,
  NotificationMachine,
  RecipientMachine,
} from '../communications.machines';
import { COMMUNICATIONS_POLICY, type CommunicationsPolicy } from '../communications.policy';
import {
  CreatedCursor,
  afterCursor,
  audienceOf,
  cursorInstant,
  iso,
  organizationOf,
  toAttempt,
  toNotification,
  toRecipient,
  type NotificationRow,
  type RecipientRow,
} from '../communications.shared';
import { CHANNEL_PROVIDERS, type ChannelProviderPort } from '../ports';
import { AudienceResolver, type ResolvedRecipient } from './audience-resolver';
import { PreferencesService } from './preferences.service';

/**
 * Input for services composing notices (staff controller or another module's handler). The
 * controller has already checked the request text (`ComposeNotificationBody`); in-process callers
 * compose from text they store, read with `ModuleComposeNotificationBody` (R2-TENANCY-INPUT-04).
 */
export type ComposeInput = z.input<typeof ModuleComposeNotificationBody> & {
  /** The domain event that triggered the notice; a replay never composes a second one. */
  sourceEventId?: string | null;
  correlationId?: string | null;
};

export interface QueueOptions {
  expectedRevision?: number;
  reason?: string | null;
  correlationId?: string | null;
}

type SuppressionReason = z.infer<typeof SuppressionReasonSchema>;

const within = (values: readonly string[], of: readonly string[]): boolean =>
  values.every((value) => of.includes(value));

/**
 * Does the newer audience address at least every party the older one does (SPK-COMMS-005,
 * R4-COMMS-AUTOMATION-03)? The same or more subject persons, team entries, explicit persons and
 * staff roles, the roles in a scope that contains the older one's (every facility, or the same).
 */
export function audienceIncludes(newer: Audience, older: Audience): boolean {
  return (
    within(older.subjectPersonIds, newer.subjectPersonIds) &&
    within(older.teamEntryIds, newer.teamEntryIds) &&
    within(older.personIds, newer.personIds) &&
    within(older.staffRoles, newer.staffRoles) &&
    (older.staffRoles.length === 0 ||
      newer.facilityId === null ||
      newer.facilityId === older.facilityId)
  );
}

/**
 * Notifications (SPK-COMMS-002/003/005/006). Lifecycle: composed → queued (recipients resolved
 * from current permissions, delivery requested through the outbox) → dispatched (recipients
 * re-checked, delivery attempts created) or suppressed (obsolete, nobody left to tell). Other
 * modules compose through `composeAndQueueIn` inside their own transaction.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(COMMUNICATIONS_POLICY) private readonly policy: CommunicationsPolicy,
    @Inject(CHANNEL_PROVIDERS) private readonly providers: ChannelProviderPort[],
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly resolver: AudienceResolver,
    private readonly preferences: PreferencesService,
    private readonly people: PeopleService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Composition (SPK-COMMS-006 step 1)
  // -------------------------------------------------------------------------------------------
  async compose(
    principal: Principal,
    input: ComposeInput,
    correlationId: string | null,
  ): Promise<Notification> {
    return this.uow.run(async ({ trx }) =>
      toNotification(await this.composeIn(trx, principal, { ...input, correlationId })),
    );
  }

  async composeIn(trx: Trx, principal: Principal, input: ComposeInput): Promise<NotificationRow> {
    const organizationId = organizationOf(principal);
    const parsed = ModuleComposeNotificationBody.parse(input);
    if (parsed.protected && parsed.audience.personIds.length > 0) {
      // Invariant 10 / SPK-AT-017: protected content reaches people only through a basis that is
      // re-checked before dispatch (subject persons, team entries, staff roles within a facility);
      // a person named by id carries no authority that could be re-checked.
      throw errors.validation(
        'A protected notice must address people through subject persons, team entries or staff roles, whose authority is re-checked before dispatch; explicit person ids carry no authority.',
        { code: 'PROTECTED_EXPLICIT_RECIPIENT', path: 'audience.personIds' },
      );
    }
    await this.requireAudience(
      principal,
      CommunicationsActions.compose,
      { organizationId, facilityId: parsed.facilityId ?? null },
      parsed.audience,
    );
    if (parsed.facilityId) await this.assertFacility(trx, organizationId, parsed.facilityId);
    const category = this.categoryOf(parsed.kind, parsed.category);
    const id = newId();
    const createdByPersonId = await this.knownPersonId(trx, organizationId, principal.personId);
    await trx
      .insertInto('notifications')
      .values({
        id,
        organization_id: organizationId,
        facility_id: parsed.facilityId ?? null,
        kind: parsed.kind,
        category,
        subject_type: parsed.subject?.type ?? null,
        subject_id: parsed.subject?.id ?? null,
        audience: json(parsed.audience),
        title: parsed.title,
        body: parsed.body,
        details_before: parsed.detailsBefore ? json(parsed.detailsBefore) : null,
        details_after: parsed.detailsAfter ? json(parsed.detailsAfter) : null,
        protected: parsed.protected,
        created_by: json(snapshotActor(principal)),
        created_by_person_id: createdByPersonId,
        source_event_id: input.sourceEventId ?? null,
        scheduled_for: parsed.scheduledFor ? new Date(parsed.scheduledFor) : null,
        supersedes_notification_id: null,
        superseded_by_notification_id: null,
        suppression_reason: null,
        queued_at: null,
        dispatched_at: null,
        suppressed_at: null,
        correlation_id: input.correlationId ?? null,
        operation_id: null,
      })
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: CommunicationsActions.compose.id,
      targetType: 'notification',
      targetId: id,
      afterRevision: 1,
      reason: parsed.reason ?? null,
      correlationId: input.correlationId ?? null,
      details: {
        kind: parsed.kind,
        category,
        protected: parsed.protected,
        subject: parsed.subject ?? null,
      },
    });
    await this.outbox.enqueue(trx, NotificationComposed, {
      organizationId,
      aggregateType: 'notification',
      aggregateId: id,
      payload: {
        notificationId: id,
        kind: parsed.kind,
        category,
        protected: parsed.protected,
      },
      correlationId: input.correlationId ?? null,
    });
    return this.loadOrThrow(trx, organizationId, id);
  }

  /**
   * SPK-COMMS-007: the category follows the policy's binding for the kind; a contradicting one is
   * refused, and a kind the policy leaves open must name its category (DEC-062 pending: the binding
   * is configuration, the refusal is the conservative default).
   */
  private categoryOf(
    kind: NotificationKindValue,
    requested: NotificationCategoryValue | undefined,
  ): NotificationCategoryValue {
    const bound = this.policy.categoryByKind[kind] ?? 'choose';
    if (bound === 'choose') {
      if (!requested) {
        throw errors.validation('This kind of notice must name its category.', {
          code: 'CATEGORY_REQUIRED',
          path: 'category',
          kind,
          allowed: ['operational', 'promotional'],
        });
      }
      return requested;
    }
    if (requested && requested !== bound) {
      throw errors.validation(`A ${kind.replace(/_/g, ' ')} notice is ${bound}.`, {
        code: 'CATEGORY_MISMATCH',
        path: 'category',
        kind,
        category: requested,
        required: bound,
      });
    }
    return bound;
  }

  /** For other modules: compose and queue in the caller's transaction (system or staff principal). */
  async composeAndQueueIn(
    trx: Trx,
    principal: Principal,
    input: ComposeInput,
  ): Promise<NotificationRow> {
    const composed = await this.composeIn(trx, principal, input);
    return this.queueIn(trx, principal, composed.id, {
      correlationId: input.correlationId ?? null,
    });
  }

  async composeAndQueue(
    principal: Principal,
    input: ComposeInput,
    correlationId: string | null = null,
  ): Promise<Notification> {
    return this.uow.run(async ({ trx }) =>
      toNotification(await this.composeAndQueueIn(trx, principal, { ...input, correlationId })),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Send (SPK-COMMS-006 step 3): resolve recipients now, supersede obsolete notices, request delivery
  // -------------------------------------------------------------------------------------------
  async send(
    principal: Principal,
    id: string,
    options: QueueOptions,
    correlationId: string | null,
  ): Promise<Notification> {
    return this.uow.run(async ({ trx }) =>
      toNotification(await this.queueIn(trx, principal, id, { ...options, correlationId })),
    );
  }

  async queueIn(
    trx: Trx,
    principal: Principal,
    notificationId: string,
    options: QueueOptions = {},
  ): Promise<NotificationRow> {
    const organizationId = organizationOf(principal);
    const row = await this.loadForUpdate(trx, organizationId, notificationId);
    if (!row) throw errors.notFound('notification', notificationId);
    await this.requireAudience(
      principal,
      CommunicationsActions.send,
      { id: row.id, organizationId, facilityId: row.facility_id },
      audienceOf(row),
    );
    assertExpectedRevision(options.expectedRevision, row.revision);
    const to = NotificationMachine.next(row.status, 'queue');
    const now = this.clock.now();
    const correlationId = options.correlationId ?? row.correlation_id;

    const recipients = await this.resolver.resolve(organizationId, audienceOf(row), trx);
    if (recipients.length === 0) {
      await this.suppress(trx, principal, row, 'no_recipients', null, correlationId);
      return this.loadOrThrow(trx, organizationId, row.id);
    }

    // SPK-COMMS-005: a newer schedule notice makes unsent notices about the same subject obsolete,
    // for the people it reaches (R4-COMMS-AUTOMATION-03).
    const supersedes = await this.supersedeObsolete(trx, principal, row, recipients, correlationId);

    const operationId = await this.operations.create(trx, {
      organizationId,
      kind: 'communications.send_notification',
      requestedBy: principal,
      correlationId,
      input: { notificationId: row.id, recipients: recipients.length },
      status: 'running',
    });
    await trx
      .updateTable('notifications')
      .set({
        status: to,
        queued_at: now,
        operation_id: operationId,
        supersedes_notification_id: supersedes,
        correlation_id: correlationId,
        revision: row.revision + 1,
      })
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await trx
      .insertInto('notification_recipients')
      .values(
        recipients.map((r) => ({
          id: newId(),
          organization_id: organizationId,
          notification_id: row.id,
          person_id: r.personId,
          resolved_basis: r.basis,
          basis_detail: r.basisDetail,
          subject_person_ids: r.subjectPersonIds,
          resolved_at: now,
        })),
      )
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: CommunicationsActions.send.id,
      targetType: 'notification',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason: options.reason ?? null,
      correlationId,
      operationId,
      details: { recipients: recipients.length, supersedes, scheduledFor: row.scheduled_for },
    });
    await this.outbox.enqueue(trx, NotificationQueued, {
      organizationId,
      aggregateType: 'notification',
      aggregateId: row.id,
      payload: {
        notificationId: row.id,
        recipientCount: recipients.length,
        scheduledFor: row.scheduled_for ? iso(row.scheduled_for) : null,
        supersedesNotificationId: supersedes,
      },
      correlationId,
      operationId,
    });
    const scheduledFor = row.scheduled_for ? new Date(row.scheduled_for) : null;
    await this.outbox.enqueue(trx, DeliveryRequested, {
      organizationId,
      aggregateType: 'notification',
      aggregateId: row.id,
      payload: { notificationId: row.id },
      correlationId,
      operationId,
      ...(scheduledFor && scheduledFor.getTime() > now.getTime()
        ? { availableAt: scheduledFor }
        : {}),
    });
    return this.loadOrThrow(trx, organizationId, row.id);
  }

  // -------------------------------------------------------------------------------------------
  // Dispatch (outbox handler core): re-check recipients, create attempts (SPK-COMMS-003/004)
  // -------------------------------------------------------------------------------------------
  async dispatch(
    trx: Trx,
    organizationId: string,
    notificationId: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.loadForUpdate(trx, organizationId, notificationId);
    if (!row || row.status !== 'queued') return; // suppressed meanwhile, or a replay
    const actor = systemPrincipal(organizationId, 'communications.dispatch');
    const now = this.clock.now();
    // SPK-COMMS-005 (R4-COMMS-AUTOMATION-03): a recipient a newer notice reached before this one
    // went out is not sent it at all, on any channel (migration 1011 refuses the attempt too).
    const recipients = await trx
      .selectFrom('notification_recipients')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('notification_id', '=', row.id)
      .where('status', '=', 'pending')
      .where('superseded_by_notification_id', 'is', null)
      .orderBy('person_id')
      .execute();
    const replaced = await trx
      .selectFrom('notification_recipients')
      .select('superseded_by_notification_id')
      .where('organization_id', '=', organizationId)
      .where('notification_id', '=', row.id)
      .where('status', '=', 'pending')
      .where('superseded_by_notification_id', 'is not', null)
      .execute();
    let authorized = 0;
    let revoked = 0;
    let attempts = 0;
    const audience = audienceOf(row);
    for (const recipient of recipients) {
      // Invariant 10: a protected notice is re-checked against current authority at dispatch time,
      // in the audience's own facility scope (the one resolution used, SPK-COMMS-003).
      const ok = row.protected
        ? await this.resolver.isStillAuthorized(
            organizationId,
            {
              personId: recipient.person_id,
              basis: recipient.resolved_basis,
              basisDetail: recipient.basis_detail,
              subjectPersonIds: recipient.subject_person_ids,
              audience,
            },
            audience.facilityId,
            trx,
          )
        : true;
      if (!ok) {
        await this.revokeRecipient(
          trx,
          row,
          recipient,
          'authority_revoked_before_dispatch',
          correlationId,
        );
        revoked += 1;
        continue;
      }
      await trx
        .updateTable('notification_recipients')
        .set({
          status: RecipientMachine.next(recipient.status, 'authorize'),
          authorized_at: now,
          revision: recipient.revision + 1,
        })
        .where('id', '=', recipient.id)
        .where('revision', '=', recipient.revision)
        .execute();
      authorized += 1;
      const channels = await this.preferences.enabledChannels(
        trx,
        organizationId,
        recipient.person_id,
        row.category,
      );
      for (const channel of channels) {
        const attemptId = newId();
        if (channel === 'in_app') {
          // The platform delivers its own in-app channel: delivered is confirmed, not inferred.
          await trx
            .insertInto('delivery_attempts')
            .values({
              id: attemptId,
              organization_id: organizationId,
              notification_id: row.id,
              recipient_id: recipient.id,
              channel,
              provider: 'in_app',
              provider_message_id: null,
              status: DeliveryAttemptMachine.next('queued', 'deliver'),
              queued_at: now,
              ready_at: now,
              locked_until: null,
              attempted_at: now,
              accepted_at: null,
              delivered_at: now,
              failed_at: null,
              read_at: null,
              acknowledged_at: null,
              provider_response: null,
              failure_code: null,
              error: null,
            })
            .execute();
          await this.outbox.enqueue(trx, DeliveryDelivered, {
            organizationId,
            aggregateType: 'delivery_attempt',
            aggregateId: attemptId,
            payload: {
              attemptId,
              notificationId: row.id,
              recipientId: recipient.id,
              channel,
              provider: 'in_app',
            },
            correlationId,
          });
        } else {
          const provider = this.providers.find((p) => p.channel === channel);
          if (!provider) continue; // channel approved for nobody until a provider exists (DEC-020)
          await trx
            .insertInto('delivery_attempts')
            .values({
              id: attemptId,
              organization_id: organizationId,
              notification_id: row.id,
              recipient_id: recipient.id,
              channel,
              provider: provider.name,
              provider_message_id: null,
              status: 'queued',
              queued_at: now,
              ready_at: now,
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
        }
        attempts += 1;
      }
    }
    if (authorized === 0) {
      // Nobody left to tell: everyone lost the authority, or a newer notice reached the rest.
      await this.suppress(
        trx,
        actor,
        row,
        revoked > 0 ? 'authority_revoked' : replaced.length > 0 ? 'obsolete' : 'no_recipients',
        revoked > 0 ? null : (replaced[0]?.superseded_by_notification_id ?? null),
        correlationId,
      );
      return;
    }
    await trx
      .updateTable('notifications')
      .set({
        status: NotificationMachine.next(row.status, 'dispatch'),
        dispatched_at: now,
        revision: row.revision + 1,
      })
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'communications.dispatch',
      targetType: 'notification',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId,
      operationId: row.operation_id,
      details: { authorized, revoked, superseded: replaced.length, attempts },
    });
    await this.outbox.enqueue(trx, NotificationDispatched, {
      organizationId,
      aggregateType: 'notification',
      aggregateId: row.id,
      payload: {
        notificationId: row.id,
        authorizedRecipients: authorized,
        revokedRecipients: revoked,
        attempts,
      },
      correlationId,
      operationId: row.operation_id,
    });
    if (row.operation_id) {
      await this.operations.transition(trx, row.operation_id, 'succeeded', {
        result: { notificationId: row.id, authorized, revoked, attempts },
      });
    }
  }

  /**
   * SPK-IAM-006 / SPK-AT-017: an actor lost a `receive_messages` grant over a subject. Every
   * protected notice still awaiting platform dispatch, or whose external attempts have not yet been
   * handed to a provider, is re-evaluated for that actor; delivered items are not recalled.
   */
  async reevaluateRecipients(
    trx: Trx,
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    correlationId: string | null,
  ): Promise<{ examined: number; revoked: number }> {
    const rows = await trx
      .selectFrom('notification_recipients as r')
      .innerJoin('notifications as n', (join) =>
        join
          .onRef('n.organization_id', '=', 'r.organization_id')
          .onRef('n.id', '=', 'r.notification_id'),
      )
      .selectAll('r')
      .where('r.organization_id', '=', organizationId)
      .where('r.person_id', '=', actorPersonId)
      .where('r.status', 'in', ['pending', 'authorized'])
      .where('n.protected', '=', true)
      .where('n.status', 'in', ['queued', 'dispatched'])
      .where(sql<boolean>`${subjectPersonId}::uuid = any(r.subject_person_ids)`)
      .orderBy('r.created_at')
      .execute();
    let revoked = 0;
    for (const recipient of rows) {
      const notification = await this.loadForUpdate(trx, organizationId, recipient.notification_id);
      if (!notification) continue;
      const audience = audienceOf(notification);
      const still = await this.resolver.isStillAuthorized(
        organizationId,
        {
          personId: recipient.person_id,
          basis: recipient.resolved_basis,
          basisDetail: recipient.basis_detail,
          subjectPersonIds: recipient.subject_person_ids,
          audience,
        },
        audience.facilityId,
        trx,
      );
      if (still) continue;
      if (recipient.status === 'authorized') {
        const unsent = await trx
          .selectFrom('delivery_attempts')
          .select('id')
          .where('recipient_id', '=', recipient.id)
          .where('status', '=', 'queued')
          .where('attempted_at', 'is', null)
          .executeTakeFirst();
        if (!unsent) continue; // everything already handed over: cannot be recalled (SPK-IAM-006)
      }
      await this.revokeRecipient(
        trx,
        notification,
        recipient,
        'authority_revoked_while_queued',
        correlationId,
      );
      revoked += 1;
    }
    return { examined: rows.length, revoked };
  }

  /** Marks the recipient revoked and fails every external attempt not yet handed to a provider. */
  async revokeRecipient(
    trx: Trx,
    notification: NotificationRow,
    recipient: RecipientRow,
    reason: string,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = notification.organization_id;
    const actor = systemPrincipal(organizationId, 'communications.authority_recheck');
    const now = this.clock.now();
    await trx
      .updateTable('notification_recipients')
      .set({
        status: RecipientMachine.next(recipient.status, 'revoke'),
        revoked_at: now,
        revocation_reason: reason,
        revision: recipient.revision + 1,
      })
      .where('id', '=', recipient.id)
      .where('revision', '=', recipient.revision)
      .execute();
    const unsent = await trx
      .selectFrom('delivery_attempts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('recipient_id', '=', recipient.id)
      .where('status', '=', 'queued')
      .where('attempted_at', 'is', null)
      .execute();
    await this.failUnsent(trx, unsent, {
      failureCode: 'RECIPIENT_REVOKED',
      error: `recipient authority revoked before hand-off (${reason})`,
      eventError: reason,
      at: now,
      correlationId,
    });
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'communications.revoke_recipient',
      targetType: 'notification_recipient',
      targetId: recipient.id,
      beforeRevision: recipient.revision,
      afterRevision: recipient.revision + 1,
      reason,
      correlationId,
      details: { notificationId: notification.id, failedAttempts: unsent.length },
    });
    await this.outbox.enqueue(trx, RecipientRevoked, {
      organizationId,
      aggregateType: 'notification',
      aggregateId: notification.id,
      payload: {
        notificationId: notification.id,
        recipientId: recipient.id,
        personId: recipient.person_id,
        reason,
      },
      correlationId,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads (staff)
  // -------------------------------------------------------------------------------------------
  async get(principal: Principal, id: string): Promise<Notification> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.uow.reader(), organizationId, id);
    if (!row) throw errors.notFound('notification', id);
    await this.authorization.require(principal, CommunicationsActions.readNotification, {
      type: 'notification',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    return toNotification(row);
  }

  async list(principal: Principal, query: ListNotificationsQuery): Promise<Page<Notification>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CommunicationsActions.readNotification, {
      type: 'notification',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    const cursor = decodeCursor(query.cursor, CreatedCursor);
    let q = this.uow
      .reader()
      .selectFrom('notifications')
      .selectAll()
      .select(cursorInstant('notifications.created_at').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.kind) q = q.where('kind', '=', query.kind);
    if (query.facilityId) q = q.where('facility_id', '=', query.facilityId);
    // §4.14 object-level authorization: a facility-scoped staff reader lists only organization-wide
    // notices and notices of their own facilities, the same rows get()/deliveries() would allow.
    // The scope is that of the roles holding the read action (identity-05).
    const scope = listFacilityScope(principal, CommunicationsActions.readNotification);
    if (scope) {
      const facilityIds = [...scope];
      q = q.where((eb) =>
        facilityIds.length > 0
          ? eb.or([eb('facility_id', 'is', null), eb('facility_id', 'in', facilityIds)])
          : eb('facility_id', 'is', null),
      );
    }
    if (cursor) q = q.where(afterCursor('notifications.created_at', 'notifications.id', cursor));
    const rows = await q.execute();
    const items = rows.slice(0, query.limit).map(toNotification);
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeCursor({ createdAt: last.cursor_at, id: last.id }) : null,
    };
  }

  async deliveries(principal: Principal, id: string): Promise<NotificationDeliveries> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.uow.reader(), organizationId, id);
    if (!row) throw errors.notFound('notification', id);
    await this.authorization.require(principal, CommunicationsActions.readNotification, {
      type: 'notification',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    const reader = this.uow.reader();
    const recipients = await reader
      .selectFrom('notification_recipients')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('notification_id', '=', id)
      .orderBy('person_id')
      .execute();
    const attempts = await reader
      .selectFrom('delivery_attempts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('notification_id', '=', id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    // SPK-UX-006 (COM-02): staff see who each recipient is, by name only (IF-09).
    const names = await this.persons.displayNames(
      organizationId,
      recipients.map((r) => r.person_id),
    );
    return {
      notification: toNotification(row),
      recipients: recipients.map((r) =>
        toRecipient(r, names.get(r.person_id)?.displayName ?? null),
      ),
      attempts: attempts.map(toAttempt),
    };
  }

  /** SPK-COMMS-006 step 2: names and a count resolved right now; never a contact list. */
  async previewRecipients(principal: Principal, id: string): Promise<RecipientPreview> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.uow.reader(), organizationId, id);
    if (!row) throw errors.notFound('notification', id);
    await this.requireAudience(
      principal,
      CommunicationsActions.previewRecipients,
      { id, organizationId, facilityId: row.facility_id },
      audienceOf(row),
    );
    const resolved = await this.resolver.resolve(organizationId, audienceOf(row));
    const recipients = [];
    for (const r of resolved) {
      const person = await this.people.loadPerson(this.uow.reader(), organizationId, r.personId);
      recipients.push({
        personId: r.personId,
        displayName: person ? `${person.given_name} ${person.family_name}` : 'Unknown person',
        basis: r.basis,
        basisDetail: r.basisDetail,
        subjectPersonIds: r.subjectPersonIds,
      });
    }
    return {
      notificationId: id,
      resolvedAt: iso(this.clock.now()),
      count: recipients.length,
      recipients,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  /**
   * SPK-COMMS-006 "compose messages against an authorized audience", §4.14: the audience's facility
   * is part of the target, not only the notification's facility tag, so a facility-scoped composer
   * cannot reach another facility's staff; nor can they address a staff role across every facility.
   */
  private async requireAudience(
    principal: Principal,
    action: ActionDefinition,
    target: { id?: string; organizationId: string; facilityId: string | null },
    audience: Audience,
  ): Promise<void> {
    for (const facilityId of new Set([target.facilityId, audience.facilityId])) {
      await this.authorization.require(principal, action, {
        type: 'notification',
        ...target,
        facilityId,
      });
    }
    if (
      listFacilityScope(principal, action) !== null &&
      audience.staffRoles.length > 0 &&
      audience.facilityId === null
    ) {
      throw errors.accessDenied(
        'A facility-scoped composer addresses staff roles within one of their facilities.',
        { action: action.id },
      );
    }
  }

  /**
   * Fails attempts that were never handed to a provider (queued, `attempted_at` null), fenced on
   * that state so an attempt a worker marked for hand-off in the meantime is left to the worker
   * (its provider call is in flight and cannot be recalled). Returns the attempts failed.
   */
  private async failUnsent(
    trx: Trx,
    attempts: Selectable<DeliveryAttemptsTable>[],
    input: {
      failureCode: DeliveryFailureCodeValue;
      error: string;
      eventError: string;
      at: Date;
      correlationId: string | null;
    },
  ): Promise<string[]> {
    const failed: string[] = [];
    for (const attempt of attempts) {
      const updated = await trx
        .updateTable('delivery_attempts')
        .set({
          status: DeliveryAttemptMachine.next(attempt.status, 'fail'),
          failed_at: input.at,
          failure_code: input.failureCode,
          error: input.error,
          revision: attempt.revision + 1,
        })
        .where('id', '=', attempt.id)
        .where('revision', '=', attempt.revision)
        .where('status', '=', 'queued')
        .where('attempted_at', 'is', null)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) continue;
      failed.push(attempt.id);
      await this.outbox.enqueue(trx, DeliveryFailed, {
        organizationId: attempt.organization_id,
        aggregateType: 'delivery_attempt',
        aggregateId: attempt.id,
        payload: {
          attemptId: attempt.id,
          notificationId: attempt.notification_id,
          recipientId: attempt.recipient_id,
          channel: attempt.channel,
          provider: attempt.provider,
          failureCode: input.failureCode,
          error: input.eventError,
        },
        correlationId: input.correlationId,
      });
    }
    return failed;
  }

  /**
   * SPK-COMMS-005 "suppress obsolete unsent reminders", for the people the newer notice reaches
   * (R4-COMMS-AUTOMATION-03). An older schedule notice about the same subject is obsolete as a
   * whole only when the newer notice covers it (`coverageOf`): it addresses at least the same
   * parties, or it reaches every one of the older notice's remaining recipients. Then an unsent
   * (composed or queued) older notice is suppressed, and a dispatched one points at the newer
   * notice and loses its push/email/SMS attempts not yet handed to a provider.
   *
   * A narrower notice (one team of a fixture, the one family a support operator resends to) never
   * suppresses or marks replaced what other people were told, but nothing stale reaches the
   * people it does reach: each of the older notice's recipients it covers carries the newer
   * notice's id from now on (`notification_recipients.superseded_by_notification_id`, migration
   * 1011). A queued older notice is then never dispatched to them (no in-app, push, email or SMS
   * copy); a dispatched one loses their unsent external attempts, and no hand-off or retry sends
   * it to them later. A composed staff draft covered only in part is left alone (it has no
   * recipients yet; it is resolved when staff send it).
   */
  private async supersedeObsolete(
    trx: Trx,
    principal: Principal,
    row: NotificationRow,
    recipients: readonly ResolvedRecipient[],
    correlationId: string | null,
  ): Promise<string | null> {
    if (row.subject_type === null || row.subject_id === null) return null;
    if (!this.policy.supersedingKinds.includes(row.kind)) return null;
    const supersedable = [...this.policy.supersedableKinds];
    if (supersedable.length === 0) return null;
    const audience = audienceOf(row);
    const reached = new Set(recipients.map((r) => r.personId));
    const now = this.clock.now();
    // Locked, so a dispatch running meanwhile is either finished first (the notice is then handled
    // as dispatched below) or waits for this transaction.
    const obsolete = await trx
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', row.organization_id)
      .where('subject_type', '=', row.subject_type)
      .where('subject_id', '=', row.subject_id)
      .where('id', '<>', row.id)
      .where('kind', 'in', supersedable)
      .where('status', 'in', ['composed', 'queued'])
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .execute();
    let supersedes: string | null = null;
    /** Older notices covered only in part: the recipients the newer notice reaches. */
    const partly = new Map<string, { status: string; recipientIds: string[] }>();
    for (const old of obsolete) {
      const coverage = await this.coverageOf(trx, audience, reached, old);
      if (coverage.full) {
        await this.suppress(trx, principal, old, 'obsolete', row.id, correlationId);
        supersedes = old.id;
      } else if (coverage.coveredRecipientIds.length > 0) {
        partly.set(old.id, { status: old.status, recipientIds: coverage.coveredRecipientIds });
      }
    }
    // Already dispatched notices about the subject point at the newer one so inboxes can show it,
    // and their push/email/SMS attempts not yet handed to a provider are never sent: the stale
    // "moved to 5 pm" must not arrive after the cancellation (SPK-COMMS-005). Delivered in-app items
    // stay; their inbox shows the pointer. An attempt a worker already marked for hand-off is the
    // worker's (fenced in failUnsent; the worker re-checks the pointer under its own lock).
    const dispatched = await trx
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', row.organization_id)
      .where('subject_type', '=', row.subject_type)
      .where('subject_id', '=', row.subject_id)
      .where('id', '<>', row.id)
      .where('kind', 'in', supersedable)
      .where('status', '=', 'dispatched')
      .where('superseded_by_notification_id', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .execute();
    const ids: string[] = [];
    for (const old of dispatched) {
      const coverage = await this.coverageOf(trx, audience, reached, old);
      if (coverage.full) ids.push(old.id);
      else if (coverage.coveredRecipientIds.length > 0) {
        partly.set(old.id, { status: old.status, recipientIds: coverage.coveredRecipientIds });
      }
    }
    if (ids.length > 0) {
      await trx
        .updateTable('notifications')
        .set({ superseded_by_notification_id: row.id })
        .where('organization_id', '=', row.organization_id)
        .where('id', 'in', ids)
        .execute();
    }
    const coveredRecipientIds = [...partly.values()].flatMap((p) => p.recipientIds);
    if (coveredRecipientIds.length > 0) {
      // The durable per-recipient fact, written before the unsent attempts are read: a retry that
      // holds the recipient's lock commits first and its new attempt is failed below, or it reads
      // the pointer and is refused (migration 1011 refuses the attempt either way).
      await trx
        .updateTable('notification_recipients')
        .set({ superseded_by_notification_id: row.id, superseded_at: now })
        .where('organization_id', '=', row.organization_id)
        .where('id', 'in', coveredRecipientIds)
        .where('superseded_by_notification_id', 'is', null)
        .execute();
    }
    if (ids.length === 0 && coveredRecipientIds.length === 0) return supersedes;
    const unsent = await trx
      .selectFrom('delivery_attempts')
      .selectAll()
      .where('organization_id', '=', row.organization_id)
      .where((eb) =>
        eb.or([
          ...(ids.length > 0 ? [eb('notification_id', 'in', ids)] : []),
          ...(coveredRecipientIds.length > 0
            ? [eb('recipient_id', 'in', coveredRecipientIds)]
            : []),
        ]),
      )
      .where('channel', '<>', 'in_app')
      .where('status', '=', 'queued')
      .where('attempted_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute();
    const failed = await this.failUnsent(trx, unsent, {
      failureCode: 'SUPERSEDED',
      error: `superseded by notification ${row.id} before hand-off`,
      eventError: `superseded by notification ${row.id}`,
      at: now,
      correlationId,
    });
    const failedOf = (notificationId: string): string[] =>
      failed.filter((a) => unsent.find((u) => u.id === a)?.notification_id === notificationId);
    for (const id of ids) {
      await this.audit.record(trx, {
        organizationId: row.organization_id,
        actor: principal,
        action: 'communications.notification_superseded',
        targetType: 'notification',
        targetId: id,
        reason: 'obsolete',
        correlationId,
        details: { supersededBy: row.id, failedAttemptIds: failedOf(id) },
      });
    }
    for (const [id, { status, recipientIds }] of partly) {
      // The older notice stands for everyone else: no notification pointer. The covered people
      // are named; a queued notice is never sent to them, a dispatched one sends them nothing more.
      await this.audit.record(trx, {
        organizationId: row.organization_id,
        actor: principal,
        action: 'communications.notification_superseded_for_recipients',
        targetType: 'notification',
        targetId: id,
        reason: 'obsolete',
        correlationId,
        details: {
          supersededBy: row.id,
          notificationStatus: status,
          recipientIds,
          failedAttemptIds: failedOf(id),
        },
      });
    }
    return supersedes;
  }

  /**
   * Does the newer notice (its audience and the people it resolved to now) cover an older one?
   * Fully when it addresses at least the older notice's parties (`audienceIncludes`: a person who
   * left the roster since is no longer one of them), or when it reaches every person the older
   * notice is still to tell (still unresolved for a composed notice: resolved now, from current
   * permissions; for a queued or dispatched one, its recipients neither revoked nor already
   * replaced by another notice). Otherwise only the recipients it reaches are covered (none for a
   * composed notice, which has no recipients yet).
   */
  private async coverageOf(
    trx: Trx,
    newer: Audience,
    reached: ReadonlySet<string>,
    old: NotificationRow,
  ): Promise<{ full: boolean; coveredRecipientIds: string[] }> {
    if (audienceIncludes(newer, audienceOf(old))) return { full: true, coveredRecipientIds: [] };
    if (old.status === 'composed') {
      const resolved = await this.resolver.resolve(old.organization_id, audienceOf(old), trx);
      return { full: resolved.every((r) => reached.has(r.personId)), coveredRecipientIds: [] };
    }
    const rows = await trx
      .selectFrom('notification_recipients')
      .select(['id', 'person_id'])
      .where('organization_id', '=', old.organization_id)
      .where('notification_id', '=', old.id)
      .where('status', '<>', 'revoked')
      .where('superseded_by_notification_id', 'is', null)
      .orderBy('id')
      .execute();
    const covered = rows.filter((r) => reached.has(r.person_id)).map((r) => r.id);
    return { full: covered.length === rows.length, coveredRecipientIds: covered };
  }

  private async suppress(
    trx: Trx,
    actor: Principal,
    row: NotificationRow,
    reason: SuppressionReason,
    supersededBy: string | null,
    correlationId: string | null,
  ): Promise<void> {
    const now = this.clock.now();
    await trx
      .updateTable('notifications')
      .set({
        status: NotificationMachine.next(row.status, 'suppress'),
        suppressed_at: now,
        suppression_reason: reason,
        superseded_by_notification_id: supersededBy ?? row.superseded_by_notification_id,
        revision: row.revision + 1,
      })
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor,
      action: 'communications.suppress',
      targetType: 'notification',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason,
      correlationId,
      operationId: row.operation_id,
      details: { supersededBy },
    });
    await this.outbox.enqueue(trx, NotificationSuppressed, {
      organizationId: row.organization_id,
      aggregateType: 'notification',
      aggregateId: row.id,
      payload: { notificationId: row.id, reason, supersededByNotificationId: supersededBy },
      correlationId,
      operationId: row.operation_id,
    });
    if (row.operation_id) {
      await this.operations.transition(trx, row.operation_id, 'succeeded', {
        result: { notificationId: row.id, suppressed: reason, supersededBy },
      });
    }
  }

  private async assertFacility(trx: Trx, organizationId: string, facilityId: string) {
    const facility = await trx
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!facility) throw errors.notFound('facility', facilityId);
  }

  private async knownPersonId(
    trx: Trx,
    organizationId: string,
    personId: string | null,
  ): Promise<string | null> {
    if (!personId) return null;
    const person = await this.persons.findPerson(organizationId, personId, trx);
    return person ? person.id : null;
  }

  async load(db: Db | Trx, organizationId: string, id: string): Promise<NotificationRow | null> {
    const row = await db
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ?? null;
  }

  private async loadForUpdate(trx: Trx, organizationId: string, id: string) {
    const row = await trx
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row ?? null;
  }

  private async loadOrThrow(db: Db | Trx, organizationId: string, id: string) {
    const row = await this.load(db, organizationId, id);
    if (!row) throw errors.notFound('notification', id);
    return row;
  }
}
