import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type AcknowledgeInput,
  type InboxItem,
  type InboxQuery,
  type MarkReadInput,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CommunicationsActions } from '../communications.actions';
import { NotificationAcknowledged, NotificationRead } from '../communications.events';
import { DeliveryAttemptMachine } from '../communications.machines';
import {
  iso,
  organizationOf,
  personOf,
  toInboxItem,
  type AttemptRow,
  type InboxRow,
} from '../communications.shared';

const InboxCursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

/**
 * The in-app inbox (SPK-UX-003): every in-app delivery attempt addressed to the principal's own
 * person, newest first, with the real delivery state (delivered, read, acknowledged; SPK-COMMS-004).
 * Reading and acknowledging are self-only commands; nobody reads another person's inbox here.
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async list(principal: Principal, query: InboxQuery): Promise<Page<InboxItem>> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    await this.authorize(principal, organizationId, personId, CommunicationsActions.readInbox);
    const cursor = decodeCursor(query.cursor, InboxCursor);
    let q = this.inboxQuery(this.uow.reader(), organizationId, personId)
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id', 'desc')
      .limit(query.limit + 1);
    if (query.unreadOnly) q = q.where('a.status', '=', 'delivered');
    if (cursor) {
      q = q.where(
        sql<boolean>`(a.created_at, a.id) < (${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const items = rows.slice(0, query.limit).map(toInboxItem);
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last
        ? encodeCursor({ createdAt: iso(last.attempt_created_at), id: last.attempt_id })
        : null,
    };
  }

  async markRead(
    principal: Principal,
    attemptId: string,
    input: MarkReadInput,
    correlationId: string | null,
  ): Promise<InboxItem> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    return this.uow.run(async ({ trx }) => {
      const attempt = await this.loadMine(trx, organizationId, personId, attemptId);
      await this.authorize(principal, organizationId, personId, CommunicationsActions.acknowledge);
      assertExpectedRevision(input.expectedRevision, attempt.revision);
      if (attempt.status === 'read' || attempt.status === 'acknowledged') {
        return this.itemFor(trx, organizationId, personId, attemptId); // reading twice is not an error
      }
      const now = this.clock.now();
      await trx
        .updateTable('delivery_attempts')
        .set({
          status: DeliveryAttemptMachine.next(attempt.status, 'read'),
          read_at: now,
          revision: attempt.revision + 1,
        })
        .where('id', '=', attempt.id)
        .where('revision', '=', attempt.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'communications.read',
        targetType: 'delivery_attempt',
        targetId: attempt.id,
        beforeRevision: attempt.revision,
        afterRevision: attempt.revision + 1,
        correlationId,
      });
      await this.outbox.enqueue(trx, NotificationRead, {
        organizationId,
        aggregateType: 'delivery_attempt',
        aggregateId: attempt.id,
        payload: {
          attemptId: attempt.id,
          notificationId: attempt.notification_id,
          recipientId: attempt.recipient_id,
          channel: attempt.channel,
          provider: attempt.provider,
          personId,
        },
        correlationId,
      });
      return this.itemFor(trx, organizationId, personId, attemptId);
    });
  }

  async acknowledge(
    principal: Principal,
    attemptId: string,
    input: AcknowledgeInput,
    correlationId: string | null,
  ): Promise<InboxItem> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    return this.uow.run(async ({ trx }) => {
      const attempt = await this.loadMine(trx, organizationId, personId, attemptId);
      await this.authorize(principal, organizationId, personId, CommunicationsActions.acknowledge);
      assertExpectedRevision(input.expectedRevision, attempt.revision);
      if (attempt.status === 'acknowledged') {
        return this.itemFor(trx, organizationId, personId, attemptId); // recorded once per recipient
      }
      const now = this.clock.now();
      const to = DeliveryAttemptMachine.next(attempt.status, 'acknowledge');
      await trx
        .updateTable('delivery_attempts')
        .set({
          status: to,
          read_at: attempt.read_at ?? now,
          acknowledged_at: now,
          revision: attempt.revision + 1,
        })
        .where('id', '=', attempt.id)
        .where('revision', '=', attempt.revision)
        .execute();
      const acknowledgmentId = newId();
      await trx
        .insertInto('notification_acknowledgments')
        .values({
          id: acknowledgmentId,
          organization_id: organizationId,
          notification_id: attempt.notification_id,
          recipient_id: attempt.recipient_id,
          delivery_attempt_id: attempt.id,
          acknowledged_at: now,
          via: 'in_app',
          acknowledged_by: json(snapshotActor(principal)),
          note: input.note ?? null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.acknowledge.id,
        targetType: 'delivery_attempt',
        targetId: attempt.id,
        beforeRevision: attempt.revision,
        afterRevision: attempt.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { acknowledgmentId },
      });
      await this.outbox.enqueue(trx, NotificationAcknowledged, {
        organizationId,
        aggregateType: 'delivery_attempt',
        aggregateId: attempt.id,
        payload: {
          attemptId: attempt.id,
          notificationId: attempt.notification_id,
          recipientId: attempt.recipient_id,
          channel: attempt.channel,
          provider: attempt.provider,
          personId,
          acknowledgmentId,
        },
        correlationId,
      });
      return this.itemFor(trx, organizationId, personId, attemptId);
    });
  }

  // -------------------------------------------------------------------------------------------
  private async authorize(
    principal: Principal,
    organizationId: string,
    personId: string,
    action: typeof CommunicationsActions.readInbox | typeof CommunicationsActions.acknowledge,
  ): Promise<void> {
    await this.authorization.require(principal, action, {
      type: 'inbox',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
  }

  /** An in-app attempt addressed to this person, locked for update; anything else is not found (§4.10). */
  private async loadMine(
    trx: Trx,
    organizationId: string,
    personId: string,
    attemptId: string,
  ): Promise<AttemptRow> {
    const attempt = await trx
      .selectFrom('delivery_attempts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', attemptId)
      .where('channel', '=', 'in_app')
      .forUpdate()
      .executeTakeFirst();
    if (!attempt) throw errors.protectedNotFound('notice');
    const recipient = await trx
      .selectFrom('notification_recipients')
      .select('person_id')
      .where('id', '=', attempt.recipient_id)
      .executeTakeFirst();
    if (recipient?.person_id !== personId) throw errors.protectedNotFound('notice');
    return attempt;
  }

  private inboxQuery(db: Db | Trx, organizationId: string, personId: string) {
    return db
      .selectFrom('delivery_attempts as a')
      .innerJoin('notifications as n', (join) =>
        join
          .onRef('n.organization_id', '=', 'a.organization_id')
          .onRef('n.id', '=', 'a.notification_id'),
      )
      .innerJoin('notification_recipients as r', (join) =>
        join
          .onRef('r.organization_id', '=', 'a.organization_id')
          .onRef('r.id', '=', 'a.recipient_id'),
      )
      .select([
        'a.id as attempt_id',
        'a.status as attempt_status',
        'a.created_at as attempt_created_at',
        'a.delivered_at',
        'a.read_at',
        'a.acknowledged_at',
        'n.id as notification_id',
        'n.kind',
        'n.category',
        'n.title',
        'n.body',
        'n.facility_id',
        'n.subject_type',
        'n.subject_id',
        'n.details_before',
        'n.details_after',
        'n.superseded_by_notification_id',
      ])
      .where('a.organization_id', '=', organizationId)
      .where('a.channel', '=', 'in_app')
      .where('r.person_id', '=', personId);
  }

  private async itemFor(
    db: Db | Trx,
    organizationId: string,
    personId: string,
    attemptId: string,
  ): Promise<InboxItem> {
    const row = await this.inboxQuery(db, organizationId, personId)
      .where('a.id', '=', attemptId)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('notice');
    return toInboxItem(row as InboxRow);
  }
}
