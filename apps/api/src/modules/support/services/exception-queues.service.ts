import { Inject, Injectable } from '@nestjs/common';
import {
  StaffRole,
  errors,
  newId,
  type CreateExceptionQueueInput,
  type ExceptionQueue,
  type Principal,
  type UpdateExceptionQueueInput,
} from '@sportspark/contracts';
import { isCheckViolation, isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
} from '../../../kernel';
import { SupportActions } from '../support.actions';
import { ExceptionQueueChanged } from '../support.events';
import { SUPPORT_POLICY, type SupportPolicy } from '../support.policy';
import {
  organizationOf,
  toExceptionQueue,
  type ExceptionQueueRow,
  type Reader,
} from '../support.shared';

/** The staff role names a queue may be named after when no queue row configures it. */
const ROLE_NAMES = new Set<string>(StaffRole.options);

/** What the workflow needs to know about a queue: who owns it and its service levels. */
export interface ResolvedQueue {
  name: string;
  owningRoles: readonly string[];
  acknowledgeWithinMinutes: number | null;
  resolveWithinMinutes: number | null;
  configured: boolean;
}

/**
 * Exception queues (SPK-UX-006 "owner or responsible queue", §5.11 "operational issues must have
 * owners"). Kernel exceptions and support cases name a queue; a configured queue lists its owning
 * staff roles and service levels; an unconfigured queue named after a staff role is owned by that
 * role (the convention every module uses for `ownerQueue`) and has no service level.
 */
@Injectable()
export class ExceptionQueuesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(SUPPORT_POLICY) private readonly policy: SupportPolicy,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async list(principal: Principal): Promise<ExceptionQueue[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SupportActions.readToday, {
      type: 'exception_queue',
      organizationId,
    });
    const rows = await this.db
      .selectFrom('exception_queues')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .execute();
    return rows.map(toExceptionQueue);
  }

  async create(
    principal: Principal,
    input: CreateExceptionQueueInput,
    correlationId: string | null,
  ): Promise<ExceptionQueue> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SupportActions.manageQueues, {
      type: 'exception_queue',
      organizationId,
    });
    const id = newId();
    try {
      return await this.uow.run(async ({ trx }) => {
        await trx
          .insertInto('exception_queues')
          .values({
            id,
            organization_id: organizationId,
            name: input.name,
            description: input.description ?? null,
            owning_roles: [...new Set(input.owningRoles)],
            acknowledge_within_minutes: input.acknowledgeWithinMinutes ?? null,
            resolve_within_minutes: input.resolveWithinMinutes ?? null,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: SupportActions.manageQueues.id,
          targetType: 'exception_queue',
          targetId: id,
          afterRevision: 1,
          reason: input.reason ?? null,
          correlationId,
          details: { name: input.name, owningRoles: input.owningRoles },
        });
        await this.outbox.enqueue(trx, ExceptionQueueChanged, {
          organizationId,
          aggregateType: 'exception_queue',
          aggregateId: id,
          payload: { queueId: id, name: input.name, revision: 1 },
          correlationId,
        });
        return toExceptionQueue(await this.loadOrThrow(trx, organizationId, id));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.resourceConflict(`An exception queue named ${input.name} already exists.`, {
          code: 'QUEUE_NAME_TAKEN',
        });
      }
      throw error;
    }
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateExceptionQueueInput,
    correlationId: string | null,
  ): Promise<ExceptionQueue> {
    const organizationId = organizationOf(principal);
    try {
      return await this.uow.run(async ({ trx }) => {
        const row = await trx
          .selectFrom('exception_queues')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw errors.notFound('exception queue', id);
        await this.authorization.require(principal, SupportActions.manageQueues, {
          type: 'exception_queue',
          id,
          organizationId,
        });
        assertExpectedRevision(input.expectedRevision, row.revision);
        const fields = Object.keys(input).filter(
          (k) => !['expectedRevision', 'reason', 'policyReferences'].includes(k),
        );
        const result = await trx
          .updateTable('exception_queues')
          .set({
            description: input.description === undefined ? row.description : input.description,
            owning_roles: input.owningRoles ? [...new Set(input.owningRoles)] : row.owning_roles,
            acknowledge_within_minutes:
              input.acknowledgeWithinMinutes === undefined
                ? row.acknowledge_within_minutes
                : input.acknowledgeWithinMinutes,
            resolve_within_minutes:
              input.resolveWithinMinutes === undefined
                ? row.resolve_within_minutes
                : input.resolveWithinMinutes,
            status: input.status ?? row.status,
            revision: row.revision + 1,
          })
          .where('id', '=', id)
          .where('revision', '=', row.revision)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) === 0) {
          throw errors.staleRevision(input.expectedRevision, row.revision + 1);
        }
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: SupportActions.manageQueues.id,
          targetType: 'exception_queue',
          targetId: id,
          beforeRevision: row.revision,
          afterRevision: row.revision + 1,
          reason: input.reason ?? null,
          correlationId,
          details: { fields },
        });
        await this.outbox.enqueue(trx, ExceptionQueueChanged, {
          organizationId,
          aggregateType: 'exception_queue',
          aggregateId: id,
          payload: { queueId: id, name: row.name, revision: row.revision + 1 },
          correlationId,
        });
        return toExceptionQueue(await this.loadOrThrow(trx, organizationId, id));
      });
    } catch (error) {
      if (isCheckViolation(error)) {
        throw errors.validation('Acknowledgment cannot be due after resolution.', {
          code: 'QUEUE_SERVICE_LEVELS',
        });
      }
      throw error;
    }
  }

  /** Every active configured queue of the organization, by name. */
  async configured(db: Reader, organizationId: string): Promise<Map<string, ExceptionQueueRow>> {
    const rows = await db
      .selectFrom('exception_queues')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .execute();
    return new Map(rows.map((r) => [r.name, r]));
  }

  resolve(name: string, configured: Map<string, ExceptionQueueRow>): ResolvedQueue {
    const row = configured.get(name);
    if (row) {
      return {
        name,
        owningRoles: row.owning_roles,
        acknowledgeWithinMinutes: row.acknowledge_within_minutes,
        resolveWithinMinutes: row.resolve_within_minutes,
        configured: true,
      };
    }
    return {
      name,
      owningRoles: ROLE_NAMES.has(name) ? [name] : [],
      acknowledgeWithinMinutes: null,
      resolveWithinMinutes: null,
      configured: false,
    };
  }

  /**
   * SPK-UX-006 "within the viewer's scope": oversight roles (and the system) see every queue;
   * other staff see the queues their roles own.
   */
  visibleTo(principal: Principal, queue: ResolvedQueue): boolean {
    if (principal.kind === 'system') return true;
    if (principal.kind !== 'staff') return false;
    if (principal.staffRoles.some((r) => this.policy.oversightRoles.includes(r))) return true;
    return queue.owningRoles.some((r) => principal.staffRoles.includes(r as StaffRole));
  }

  /** A queue a case or exception may name: a configured active queue or a staff role's queue. */
  async assertKnown(db: Reader, organizationId: string, name: string): Promise<void> {
    if (ROLE_NAMES.has(name)) return;
    const row = await db
      .selectFrom('exception_queues')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('name', '=', name)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!row) {
      throw errors.validation(`Unknown queue ${name}: configure it or use a staff role queue.`, {
        code: 'UNKNOWN_QUEUE',
      });
    }
  }

  private async loadOrThrow(db: Reader, organizationId: string, id: string) {
    const row = await db
      .selectFrom('exception_queues')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('exception queue', id);
    return row;
  }
}
