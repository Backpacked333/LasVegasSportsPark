import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ActionId,
  type Operation,
  type OperationStatus,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db, type OperationsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import { snapshotActor } from '../audit/audit.writer';
import { defineActions, type ActionDefinition } from '../authorization/actions';
import { AuthorizationService } from '../authorization/authorization.service';
import type { Clock } from '../clock';
import { currentCommitFence } from '../database/commit-fence';
import { ensureUpdated } from '../database/revision';
import { executorFor } from '../database/transaction-context';
import type { Trx } from '../database/unit-of-work';
import { CLOCK, DATABASE } from '../tokens';

/**
 * The default read authority for an operation that names no read scope of its own. Coaches and
 * officials are not operators of other people's commands: they read the outcomes they requested
 * (§4.14 least privilege). An owning module narrows a sensitive outcome further with `readScope`.
 */
export const OperationActions = defineActions({
  read: {
    id: 'operations.read',
    description: 'Read an asynchronous operation outcome (requester or operating staff)',
    staffRoles: [
      'front_desk',
      'league_manager',
      'program_manager',
      'scheduler',
      'finance_operator',
      'facilities_operator',
      'general_manager',
      'system_administrator',
      'support_operator',
    ],
    requirements: ['§4.8', '§4.14'],
  },
});

/**
 * Who besides the requester may read an operation's outcome (§4.14 object-level authorization):
 * the owning module's read action, evaluated against the facility and the subject persons the
 * operation concerns. A customer-private outcome passes the subjects (a guardian with the
 * action's permission reads it; another household does not).
 */
export interface OperationReadScope {
  action: ActionDefinition;
  facilityId?: string | null;
  subjectPersonIds?: readonly string[];
}

export interface CreateOperationInput {
  organizationId: string;
  kind: string;
  requestedBy: Principal;
  correlationId?: string | null;
  input?: unknown;
  status?: Extract<OperationStatus, 'pending' | 'running'>;
  /**
   * Inside an idempotent request the key is linked to the first operation the request creates
   * (§4.9). A coordinator that creates its own operation after a nested step created one passes
   * `primary: true` so the key names the coordinator's operation instead.
   */
  primary?: boolean;
  /** Read authority besides the requester; default: `operations.read`, organization-wide. */
  readScope?: OperationReadScope;
}

const TERMINAL: OperationStatus[] = ['succeeded', 'failed', 'compensated'];

/** Durable operations (§4.8 GET /v1/operations/{id}): the readable outcome of multi-step commands. */
@Injectable()
export class OperationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
  ) {}

  async create(trx: Trx, input: CreateOperationInput): Promise<string> {
    const id = newId();
    const now = this.clock.now();
    await trx
      .insertInto('operations')
      .values({
        id,
        organization_id: input.organizationId,
        kind: input.kind,
        status: input.status ?? 'pending',
        requested_by: json(snapshotActor(input.requestedBy)),
        correlation_id: input.correlationId ?? null,
        input: input.input === undefined ? null : json(input.input as object),
        result: null,
        error: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
        read_action: input.readScope?.action.id ?? null,
        facility_id: input.readScope?.facilityId ?? null,
        subject_person_ids: [...(input.readScope?.subjectPersonIds ?? [])],
      })
      .execute();
    // §4.9: the request's idempotency key names the operation it started, atomically with it.
    // Operations created by outbox or inbox handlers run outside any request and are not linked.
    await currentCommitFence()?.linkOperation(trx, id, { primary: input.primary });
    return id;
  }

  async transition(
    trx: Trx,
    id: string,
    to: OperationStatus,
    data: { result?: unknown; error?: { code: string; message: string; details?: unknown } } = {},
  ): Promise<void> {
    // §4.9, §4.6: lock the row so a concurrent transition waits and then sees the committed state
    // (and fails the terminal check) instead of being silently lost.
    const current = await trx
      .selectFrom('operations')
      .select(['status', 'revision'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw errors.notFound('operation', id);
    if (TERMINAL.includes(current.status)) {
      throw errors.invalidTransition('Operation', current.status, to);
    }
    const now = this.clock.now();
    const updated = await trx
      .updateTable('operations')
      .set({
        status: to,
        revision: current.revision + 1,
        result: data.result === undefined ? undefined : json(data.result as object),
        error: data.error === undefined ? undefined : json(data.error),
        completed_at: TERMINAL.includes(to) ? now : null,
      })
      .where('id', '=', id)
      .where('revision', '=', current.revision)
      .executeTakeFirst();
    ensureUpdated(updated.numUpdatedRows, () =>
      errors.staleRevision(current.revision, current.revision + 1),
    );
  }

  /**
   * Who requested an operation (K-10, IF-29): the principal kind, account and person recorded at
   * creation, or null for an unknown id or another organization's operation. The caller
   * authorizes its own context first.
   */
  async requestedBy(
    organizationId: string,
    operationId: string,
    db?: Db | Trx,
  ): Promise<{ kind: string; accountId: string | null; personId: string | null } | null> {
    const row = await (db ?? executorFor(this.db))
      .selectFrom('operations')
      .select('requested_by')
      .where('organization_id', '=', organizationId)
      .where('id', '=', operationId)
      .executeTakeFirst();
    if (!row) return null;
    const actor = (row.requested_by ?? {}) as Record<string, unknown>;
    return {
      kind: typeof actor['kind'] === 'string' ? actor['kind'] : 'unknown',
      accountId: typeof actor['accountId'] === 'string' ? actor['accountId'] : null,
      personId: typeof actor['personId'] === 'string' ? actor['personId'] : null,
    };
  }

  /** Returns the operation when the principal may see it; protected not-found otherwise. */
  async find(principal: Principal, id: string): Promise<Operation> {
    const row = await this.db
      .selectFrom('operations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || row.organization_id !== principal.organizationId)
      throw errors.protectedNotFound('operation');
    const requester = row.requested_by as { accountId?: string | null };
    const isRequester = principal.accountId !== null && requester.accountId === principal.accountId;
    if (isRequester) return toOperation(row);
    // §4.14: the owning module's read action within the operation's facility and subjects. An
    // action id that is no longer registered grants nothing (the decision denies unknown actions).
    const action: ActionId | ActionDefinition = row.read_action
      ? (row.read_action as ActionId)
      : OperationActions.read;
    const decision = await this.authorization.decide(principal, action, {
      type: 'operation',
      id,
      organizationId: row.organization_id,
      facilityId: row.facility_id,
      subjectPersonIds: row.subject_person_ids.length > 0 ? row.subject_person_ids : undefined,
      protected: true,
    });
    if (!decision.allowed) throw errors.protectedNotFound('operation');
    return toOperation(row);
  }
}

export function toOperation(row: Selectable<OperationsTable>): Operation {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    correlationId: row.correlation_id,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}
