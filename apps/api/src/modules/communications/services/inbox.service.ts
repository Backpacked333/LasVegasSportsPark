import { Inject, Injectable } from '@nestjs/common';
import {
  AudienceSchema,
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
  type RecipientBasisValue,
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
import { AudienceResolver } from './audience-resolver';
import { MergedPersons } from './merged-persons';

const InboxCursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

/** An inbox row plus what the protected-notice re-check needs (never part of the response). */
interface EntitlementRow extends InboxRow {
  protected: boolean;
  audience: unknown;
  recipient_person_id: string;
  resolved_basis: RecipientBasisValue;
  basis_detail: string | null;
}

/**
 * The in-app inbox (SPK-UX-003): every in-app delivery attempt addressed to the principal's own
 * person, newest first, with the real delivery state (delivered, read, acknowledged; SPK-COMMS-004).
 * Reading and acknowledging are self-only commands; nobody reads another person's inbox here.
 * A protected notice is served only while the recipient still holds the authority that justified
 * it, re-checked on every read like a calendar feed (SPK-IAM-006 "revocation must affect new
 * protected requests", SPK-AT-017, invariant 10); the delivered fact itself is never rewritten.
 *
 * Person merges (COM-05, SPK-IAM-007): nothing is rewritten. The survivor's inbox lists the notices
 * delivered to every person merged into them (identity's `personIdsResolvingTo`), and they read and
 * acknowledge them as their own. A protected notice of a merged person is re-checked for the
 * survivor, who holds the merged person's re-pointed authority.
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly resolver: AudienceResolver,
    private readonly merges: MergedPersons,
  ) {}

  async list(principal: Principal, query: InboxQuery): Promise<Page<InboxItem>> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    await this.authorize(principal, organizationId, personId, CommunicationsActions.readInbox);
    const cursor = decodeCursor(query.cursor, InboxCursor);
    const reader = this.uow.reader();
    const personIds = await this.inboxPersons(reader, organizationId, personId);
    let q = this.inboxQuery(reader, organizationId, personIds)
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
    const items: InboxItem[] = [];
    for (const row of rows.slice(0, query.limit)) {
      if (await this.stillEntitled(organizationId, personId, row)) items.push(toInboxItem(row));
    }
    // The cursor follows the rows read, so paging moves past items withheld above.
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
      const personIds = await this.inboxPersons(trx, organizationId, personId);
      const attempt = await this.loadMine(trx, organizationId, personIds, attemptId);
      await this.authorize(principal, organizationId, personId, CommunicationsActions.acknowledge);
      await this.assertEntitled(trx, organizationId, personId, personIds, attemptId);
      assertExpectedRevision(input.expectedRevision, attempt.revision);
      if (attempt.status === 'read' || attempt.status === 'acknowledged') {
        return this.itemFor(trx, organizationId, personIds, attemptId); // reading twice is not an error
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
      return this.itemFor(trx, organizationId, personIds, attemptId);
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
      const personIds = await this.inboxPersons(trx, organizationId, personId);
      const attempt = await this.loadMine(trx, organizationId, personIds, attemptId);
      await this.authorize(principal, organizationId, personId, CommunicationsActions.acknowledge);
      await this.assertEntitled(trx, organizationId, personId, personIds, attemptId);
      assertExpectedRevision(input.expectedRevision, attempt.revision);
      if (attempt.status === 'acknowledged') {
        return this.itemFor(trx, organizationId, personIds, attemptId); // recorded once per recipient
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
      return this.itemFor(trx, organizationId, personIds, attemptId);
    });
  }

  // -------------------------------------------------------------------------------------------
  /**
   * The people whose in-app notices this person reads (COM-05, SPK-IAM-007): themself and, after a
   * merge, everyone merged into them (identity's merge chain, MergedPersons).
   */
  private inboxPersons(db: Db | Trx, organizationId: string, personId: string): Promise<string[]> {
    return this.merges.resolving(db, organizationId, personId);
  }

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

  /**
   * An in-app attempt addressed to this person (or a person merged into them), locked for update;
   * anything else is not found (§4.10).
   */
  private async loadMine(
    trx: Trx,
    organizationId: string,
    personIds: readonly string[],
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
    if (!recipient || !personIds.includes(recipient.person_id)) {
      throw errors.protectedNotFound('notice');
    }
    return attempt;
  }

  private inboxQuery(db: Db | Trx, organizationId: string, personIds: readonly string[]) {
    return (
      db
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
          'a.revision as attempt_revision',
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
          'n.protected',
          'n.audience',
          'r.person_id as recipient_person_id',
          'r.resolved_basis',
          'r.basis_detail',
          'r.subject_person_ids',
        ])
        .where('a.organization_id', '=', organizationId)
        .where('a.channel', '=', 'in_app')
        .where('r.person_id', 'in', [...personIds])
        // A recipient revoked from a protected notice is never served it (SPK-IAM-006).
        .where((eb) => eb.or([eb('n.protected', '=', false), eb('r.status', '!=', 'revoked')]))
    );
  }

  /**
   * Unprotected notices are served as delivered. A protected one only while the recipient still
   * holds, right now, the authority that justified their inclusion (invariant 10, SPK-AT-017). A
   * notice addressed to a person merged into the reader is re-checked for the reader (the survivor
   * holds the merged person's re-pointed grants; COM-05): the merged person stands for the reader
   * as recipient and as their own subject.
   */
  private async stillEntitled(
    organizationId: string,
    readerPersonId: string,
    row: EntitlementRow,
    trx?: Trx,
  ): Promise<boolean> {
    if (!row.protected) return true;
    const audience = AudienceSchema.parse(row.audience);
    const merged = row.recipient_person_id !== readerPersonId ? row.recipient_person_id : null;
    return this.resolver.isStillAuthorized(
      organizationId,
      {
        personId: readerPersonId,
        basis: row.resolved_basis,
        basisDetail: row.basis_detail,
        subjectPersonIds: row.subject_person_ids.map((s) => (s === merged ? readerPersonId : s)),
        audience,
      },
      audience.facilityId,
      trx,
    );
  }

  /** Read and acknowledge act only on a notice the person may still be served (§4.10 not found). */
  private async assertEntitled(
    trx: Trx,
    organizationId: string,
    personId: string,
    personIds: readonly string[],
    attemptId: string,
  ): Promise<void> {
    const row = await this.inboxQuery(trx, organizationId, personIds)
      .where('a.id', '=', attemptId)
      .executeTakeFirst();
    if (!row || !(await this.stillEntitled(organizationId, personId, row, trx))) {
      throw errors.protectedNotFound('notice');
    }
  }

  /** The item after a command; entitlement was asserted earlier in the same transaction. */
  private async itemFor(
    trx: Trx,
    organizationId: string,
    personIds: readonly string[],
    attemptId: string,
  ): Promise<InboxItem> {
    const row = await this.inboxQuery(trx, organizationId, personIds)
      .where('a.id', '=', attemptId)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('notice');
    return toInboxItem(row);
  }
}
