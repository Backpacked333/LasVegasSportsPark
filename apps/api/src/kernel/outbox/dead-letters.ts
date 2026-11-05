import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  InboxEventMachine,
  OutboxEventMachine,
  StaffRole,
  systemPrincipal,
  type DeadLetterReplayView,
  type InboxEventState,
  type OutboxEventState,
  type Principal,
  type ReplayDeadLetterInput,
} from '@sportspark/contracts';
import { AuditWriter } from '../audit/audit.writer';
import type { ActionDefinition } from '../authorization/actions';
import { AuthorizationService } from '../authorization/authorization.service';
import { CoreActions } from '../authorization/core-actions';
import type { Clock } from '../clock';
import { UnitOfWork, type Trx } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { CLOCK } from '../tokens';

export const OUTBOX_DEAD_LETTER_CATEGORY = 'reliability.outbox_dead_letter';
export const INBOX_DEAD_LETTER_CATEGORY = 'reliability.inbox_dead_letter';

/** The exception dedupe key of a dead-lettered outbox or inbox event. */
export const deadLetterKey = (source: 'outbox' | 'inbox', eventId: string) =>
  `${source}:${eventId}`;

/**
 * Supported resolution of a dead letter (R3-OPERATIONS-03, §5.11 "operational issues must have
 * owners and supported resolution actions", §4.12 "workers must tolerate interruption and replay",
 * SPK-UX-006). Once the cause is fixed (a deployed fix, a dependency back), the owner replays the
 * event: it returns to the worker (`OutboxEventMachine` / `InboxEventMachine` `replay`) with its
 * attempts reset and a fresh retry time, its consumptions kept, so handlers that already ran are
 * skipped and only the failed ones run again. The replay is audited and counted
 * (`replay_count`, `replayed_at`, migration 0014). Its dead-letter exception stays open until the
 * worker settles the replayed event and resolves it (`resolveReplayed`); a dead letter's exception
 * cannot be resolved by hand while its event has not settled (OperationalExceptions.transition),
 * only closed with a reason when the follow-up is no longer wanted.
 */
@Injectable()
export class DeadLetters {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  async replayOutboxEvent(
    principal: Principal,
    id: string,
    input: ReplayDeadLetterInput,
    correlationId: string | null,
  ): Promise<DeadLetterReplayView> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('outbox_events')
        .select(['id', 'status', 'failure_owner', 'replay_count', 'event_type'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      // §4.10: another organization's event is simply not found.
      if (!row) throw errors.notFound('outbox event', id);
      await this.requireReplay(principal, row.failure_owner, {
        type: 'outbox_event',
        id,
        organizationId,
      });
      const to = OutboxEventMachine.next(row.status as OutboxEventState, 'replay');
      const now = this.clock.now();
      const replayCount = row.replay_count + 1;
      await trx
        .updateTable('outbox_events')
        .set({
          status: to,
          attempts: 0,
          available_at: now,
          locked_by: null,
          locked_until: null,
          dispatched_at: null,
          replay_count: replayCount,
          replayed_at: now,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('status', '=', row.status)
        .executeTakeFirstOrThrow();
      const exceptionId = await openDeadLetterException(
        trx,
        organizationId,
        deadLetterKey('outbox', id),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'core.dead_letter_replayed',
        targetType: 'outbox_event',
        targetId: id,
        reason: input.reason,
        correlationId,
        details: {
          eventType: row.event_type,
          replayCount,
          exceptionId,
          policyReferences: input.policyReferences ?? [],
        },
      });
      return {
        id,
        source: 'outbox',
        status: 'pending',
        attempts: 0,
        availableAt: now.toISOString(),
        replayCount,
        replayedAt: now.toISOString(),
        exceptionId,
      };
    });
  }

  async replayInboxEvent(
    principal: Principal,
    id: string,
    input: ReplayDeadLetterInput,
    correlationId: string | null,
  ): Promise<DeadLetterReplayView> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      // An event without an organization belongs to no organization's staff: it is not found here.
      const row = await trx
        .selectFrom('inbox_events')
        .select(['id', 'status', 'failure_owner', 'replay_count', 'provider', 'event_type'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw errors.notFound('provider event', id);
      await this.requireReplay(principal, row.failure_owner, {
        type: 'provider_event',
        id,
        organizationId,
      });
      const to = InboxEventMachine.next(row.status as InboxEventState, 'replay');
      const now = this.clock.now();
      const replayCount = row.replay_count + 1;
      await trx
        .updateTable('inbox_events')
        .set({
          status: to,
          attempts: 0,
          available_at: now,
          locked_by: null,
          locked_until: null,
          processed_at: null,
          replay_count: replayCount,
          replayed_at: now,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('status', '=', row.status)
        .executeTakeFirstOrThrow();
      const exceptionId = await openDeadLetterException(
        trx,
        organizationId,
        deadLetterKey('inbox', id),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'core.dead_letter_replayed',
        targetType: 'provider_event',
        targetId: id,
        reason: input.reason,
        correlationId,
        details: {
          provider: row.provider,
          eventType: row.event_type,
          replayCount,
          exceptionId,
          policyReferences: input.policyReferences ?? [],
        },
      });
      return {
        id,
        source: 'inbox',
        status: 'received',
        attempts: 0,
        availableAt: now.toISOString(),
        replayCount,
        replayedAt: now.toISOString(),
        exceptionId,
      };
    });
  }

  /** The failure owner's own queue, else core.replay_dead_letter (general manager, system admin). */
  private async requireReplay(
    principal: Principal,
    failureOwner: string | null,
    target: { type: string; id: string; organizationId: string },
  ): Promise<void> {
    const own = ownQueueReplay(principal, failureOwner);
    if (own && (await this.authorization.decide(principal, own, target)).allowed) return;
    await this.authorization.require(principal, CoreActions.replayDeadLetter, target);
  }
}

/**
 * Resolves the dead-letter exception of an event the worker has just settled after a replay, in
 * the worker's transaction (after the event's own status write, so the exception's guard sees it
 * settled). A no-op when no such exception is open (closed by hand, or the event never had one).
 */
export async function resolveReplayedDeadLetter(
  trx: Trx,
  exceptions: OperationalExceptions,
  input: {
    organizationId: string;
    source: 'outbox' | 'inbox';
    eventId: string;
    actorLabel: string;
  },
): Promise<void> {
  await resolveOpenException(trx, exceptions, {
    organizationId: input.organizationId,
    dedupeKey: deadLetterKey(input.source, input.eventId),
    categories: [OUTBOX_DEAD_LETTER_CATEGORY, INBOX_DEAD_LETTER_CATEGORY],
    actorLabel: input.actorLabel,
    reason: 'The replayed follow-up was delivered',
    resolution: { resolvedBy: input.actorLabel, source: input.source, eventId: input.eventId },
  });
}

// ---------------------------------------------------------------------------------------------
// Waiting for a missing handler (§5.11, completing R3-OPERATIONS-01)
// ---------------------------------------------------------------------------------------------

export const OUTBOX_WAITING_CATEGORY = 'reliability.outbox_waiting_for_handler';
export const INBOX_WAITING_CATEGORY = 'reliability.inbox_waiting_for_handler';
/** Who owns an event that waits for a handler: a deploy question, so system administration. */
export const HANDLER_WAIT_OWNER = 'system_administrator';

/** The exception dedupe key of an outbox or inbox event that waits for a missing handler. */
export const handlerWaitKey = (source: 'outbox' | 'inbox', eventId: string) =>
  `${source}-wait:${eventId}`;

/**
 * Tells the owner that an event has waited too long for handlers its producing build registered
 * and the processing build lacks (§5.11 "operational issues must have owners"; migration 0015,
 * OUTBOX_MISSING_HANDLER_ESCALATE_AFTER_SECONDS). Runs in the worker's transaction with the
 * event's deferral, so it is raised once per wait: while it is open it is deduplicated, and one
 * closed by hand during this wait (an owner who accepted it) is not raised again. Returns whether
 * a new exception was opened.
 */
export async function escalateHandlerWait(
  trx: Trx,
  exceptions: OperationalExceptions,
  input: {
    organizationId: string;
    source: 'outbox' | 'inbox';
    eventId: string;
    eventType: string;
    affectedType: string;
    affectedId: string;
    missingHandlers: readonly string[];
    waitingSince: Date;
    appVersion: string;
    workerId: string;
  },
): Promise<boolean> {
  const dedupeKey = handlerWaitKey(input.source, input.eventId);
  const earlier = await trx
    .selectFrom('operational_exceptions')
    .select('id')
    .where('organization_id', '=', input.organizationId)
    .where('dedupe_key', '=', dedupeKey)
    .where('opened_at', '>=', input.waitingSince)
    .executeTakeFirst();
  if (earlier) return false;
  const { deduplicated } = await exceptions.raise(trx, {
    organizationId: input.organizationId,
    category: input.source === 'outbox' ? OUTBOX_WAITING_CATEGORY : INBOX_WAITING_CATEGORY,
    severity: 'high',
    title: `Follow-up for ${input.eventType} is waiting for handler(s) ${input.missingHandlers.join(', ')} that the running build does not register`,
    affectedType: input.affectedType,
    affectedId: input.affectedId,
    ownerQueue: HANDLER_WAIT_OWNER,
    dedupeKey,
    details: {
      source: input.source,
      eventId: input.eventId,
      eventType: input.eventType,
      missingHandlers: [...input.missingHandlers],
      waitingSince: input.waitingSince.toISOString(),
      build: input.appVersion,
      workerId: input.workerId,
      resolution:
        'Deploy a build that registers these handlers, or one that declares them retired (EventHandlerRegistry.retire, Inbox.retire); the worker then settles the event and resolves this exception.',
    },
  });
  return !deduplicated;
}

/**
 * Resolves the wait exception of an event the worker has just settled, in the worker's transaction
 * (after the event's status write). A no-op when none is open (never raised, or closed by hand).
 */
export async function resolveHandlerWait(
  trx: Trx,
  exceptions: OperationalExceptions,
  input: {
    organizationId: string;
    source: 'outbox' | 'inbox';
    eventId: string;
    actorLabel: string;
  },
): Promise<void> {
  await resolveOpenException(trx, exceptions, {
    organizationId: input.organizationId,
    dedupeKey: handlerWaitKey(input.source, input.eventId),
    categories: [OUTBOX_WAITING_CATEGORY, INBOX_WAITING_CATEGORY],
    actorLabel: input.actorLabel,
    reason: 'Every handler the event expected has run or is retired; the follow-up settled',
    resolution: { resolvedBy: input.actorLabel, source: input.source, eventId: input.eventId },
  });
}

/**
 * Resolves the open (or acknowledged) exception with this key, as the worker. The row is locked
 * first and its status read under the lock (R3-OPERATIONS-03): an operator who closes it at the
 * same moment either commits first (the lock waits, then the row no longer qualifies and nothing is
 * done) or waits for this transaction (and then closes a resolved exception). Without the lock the
 * worker read it open, the close committed, and the transition refused INVALID_TRANSITION inside
 * the worker's settle transaction, rolling back the event's own dispatch.
 */
async function resolveOpenException(
  trx: Trx,
  exceptions: OperationalExceptions,
  input: {
    organizationId: string;
    dedupeKey: string;
    categories: readonly string[];
    actorLabel: string;
    reason: string;
    resolution: Record<string, unknown>;
  },
): Promise<void> {
  const exceptionId = await openExceptionByKey(trx, input.organizationId, input.dedupeKey, {
    categories: input.categories,
    lock: true,
  });
  if (!exceptionId) return;
  await exceptions.transition(
    trx,
    systemPrincipal(input.organizationId, input.actorLabel),
    exceptionId,
    'resolved',
    { reason: input.reason, resolution: input.resolution },
  );
}

async function openDeadLetterException(
  trx: Trx,
  organizationId: string,
  dedupeKey: string,
): Promise<string | null> {
  return openExceptionByKey(trx, organizationId, dedupeKey, {
    categories: [OUTBOX_DEAD_LETTER_CATEGORY, INBOX_DEAD_LETTER_CATEGORY],
    lock: false,
  });
}

async function openExceptionByKey(
  trx: Trx,
  organizationId: string,
  dedupeKey: string,
  options: { categories: readonly string[]; lock: boolean },
): Promise<string | null> {
  const query = trx
    .selectFrom('operational_exceptions')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('dedupe_key', '=', dedupeKey)
    .where('category', 'in', [...options.categories])
    .where('status', 'in', ['open', 'acknowledged']);
  const row = await (options.lock ? query.forUpdate() : query).executeTakeFirst();
  return row?.id ?? null;
}

function organizationOf(principal: Principal): string {
  if (principal.kind === 'anonymous' || !principal.organizationId) {
    throw errors.authenticationRequired();
  }
  return principal.organizationId;
}

/**
 * `core.replay_own_dead_letter` narrowed to the one staff role the failure owner names, or null
 * when the principal does not hold that role (the same rule as `exceptions.manage_own_queue`).
 */
function ownQueueReplay(
  principal: Principal,
  failureOwner: string | null,
): ActionDefinition | null {
  if (principal.kind !== 'staff' || !failureOwner) return null;
  const role = StaffRole.safeParse(failureOwner);
  if (!role.success || !principal.staffRoles.includes(role.data)) return null;
  if (!CoreActions.replayOwnDeadLetter.staffRoles.includes(role.data)) return null;
  return { ...CoreActions.replayOwnDeadLetter, staffRoles: [role.data] };
}
