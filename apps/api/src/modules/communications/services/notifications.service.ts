import { Inject, Injectable } from '@nestjs/common';
import {
  ComposeNotificationBody,
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  systemPrincipal,
  z,
  type Audience,
  type ListNotificationsQuery,
  type Notification,
  type NotificationDeliveries,
  type Page,
  type Principal,
  type RecipientPreview,
  type SuppressionReasonSchema,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
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
  audienceOf,
  iso,
  organizationOf,
  toAttempt,
  toNotification,
  toRecipient,
  type NotificationRow,
  type RecipientRow,
} from '../communications.shared';
import { CHANNEL_PROVIDERS, type ChannelProviderPort } from '../ports';
import { AudienceResolver } from './audience-resolver';
import { PreferencesService } from './preferences.service';

/** Input for services composing notices (staff controller or another module's handler). */
export type ComposeInput = z.input<typeof ComposeNotificationBody> & {
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

const ListCursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

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
    const parsed = ComposeNotificationBody.parse(input);
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
    const id = newId();
    const createdByPersonId = await this.knownPersonId(trx, organizationId, principal.personId);
    await trx
      .insertInto('notifications')
      .values({
        id,
        organization_id: organizationId,
        facility_id: parsed.facilityId ?? null,
        kind: parsed.kind,
        category: parsed.category,
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
        category: parsed.category,
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
        category: parsed.category,
        protected: parsed.protected,
      },
      correlationId: input.correlationId ?? null,
    });
    return this.loadOrThrow(trx, organizationId, id);
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

    // SPK-COMMS-005: a newer schedule notice makes unsent notices about the same subject obsolete.
    const supersedes = await this.supersedeObsolete(trx, principal, row, correlationId);

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
    const recipients = await trx
      .selectFrom('notification_recipients')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('notification_id', '=', row.id)
      .where('status', '=', 'pending')
      .orderBy('person_id')
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
      await this.suppress(
        trx,
        actor,
        row,
        revoked > 0 ? 'authority_revoked' : 'no_recipients',
        null,
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
      details: { authorized, revoked, attempts },
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
    for (const attempt of unsent) {
      await trx
        .updateTable('delivery_attempts')
        .set({
          status: DeliveryAttemptMachine.next(attempt.status, 'fail'),
          failed_at: now,
          failure_code: 'RECIPIENT_REVOKED',
          error: `recipient authority revoked before hand-off (${reason})`,
          revision: attempt.revision + 1,
        })
        .where('id', '=', attempt.id)
        .where('revision', '=', attempt.revision)
        .execute();
      await this.outbox.enqueue(trx, DeliveryFailed, {
        organizationId,
        aggregateType: 'delivery_attempt',
        aggregateId: attempt.id,
        payload: {
          attemptId: attempt.id,
          notificationId: notification.id,
          recipientId: recipient.id,
          channel: attempt.channel,
          provider: attempt.provider,
          failureCode: 'RECIPIENT_REVOKED',
          error: reason,
        },
        correlationId,
      });
    }
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
    const cursor = decodeCursor(query.cursor, ListCursor);
    let q = this.uow
      .reader()
      .selectFrom('notifications')
      .selectAll()
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
    if (cursor) {
      q = q.where(
        sql<boolean>`(created_at, id) < (${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const items = rows.slice(0, query.limit).map(toNotification);
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeCursor({ createdAt: iso(last.created_at), id: last.id }) : null,
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
    return {
      notification: toNotification(row),
      recipients: recipients.map(toRecipient),
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

  private async supersedeObsolete(
    trx: Trx,
    principal: Principal,
    row: NotificationRow,
    correlationId: string | null,
  ): Promise<string | null> {
    if (row.subject_type === null || row.subject_id === null) return null;
    if (!this.policy.supersedingKinds.includes(row.kind)) return null;
    const supersedable = [...this.policy.supersedableKinds];
    if (supersedable.length === 0) return null;
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
      .execute();
    let supersedes: string | null = null;
    for (const old of obsolete) {
      await this.suppress(trx, principal, old, 'obsolete', row.id, correlationId);
      supersedes = old.id;
    }
    // Already delivered notices about the subject point at the newer one so inboxes can show it.
    await trx
      .updateTable('notifications')
      .set({ superseded_by_notification_id: row.id })
      .where('organization_id', '=', row.organization_id)
      .where('subject_type', '=', row.subject_type)
      .where('subject_id', '=', row.subject_id)
      .where('id', '<>', row.id)
      .where('kind', 'in', supersedable)
      .where('status', '=', 'dispatched')
      .where('superseded_by_notification_id', 'is', null)
      .execute();
    return supersedes;
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
