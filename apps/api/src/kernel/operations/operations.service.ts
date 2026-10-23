import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Operation,
  type OperationStatus,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db, type OperationsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import { snapshotActor } from '../audit/audit.writer';
import { defineActions } from '../authorization/actions';
import { AuthorizationService } from '../authorization/authorization.service';
import type { Clock } from '../clock';
import type { Trx } from '../database/unit-of-work';
import { CLOCK, DATABASE } from '../tokens';

export const OperationActions = defineActions({
  read: {
    id: 'operations.read',
    description: 'Read an asynchronous operation outcome (requester or staff)',
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
      'coach',
      'official',
    ],
    requirements: ['§4.8'],
  },
});

export interface CreateOperationInput {
  organizationId: string;
  kind: string;
  requestedBy: Principal;
  correlationId?: string | null;
  input?: unknown;
  status?: Extract<OperationStatus, 'pending' | 'running'>;
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
      })
      .execute();
    return id;
  }

  async transition(
    trx: Trx,
    id: string,
    to: OperationStatus,
    data: { result?: unknown; error?: { code: string; message: string; details?: unknown } } = {},
  ): Promise<void> {
    const current = await trx
      .selectFrom('operations')
      .select(['status', 'revision'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw errors.notFound('operation', id);
    if (TERMINAL.includes(current.status)) {
      throw errors.invalidTransition('Operation', current.status, to);
    }
    const now = this.clock.now();
    await trx
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
      .execute();
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
    const decision = await this.authorization.decide(principal, OperationActions.read, {
      type: 'operation',
      id,
      organizationId: row.organization_id,
      protected: true,
    });
    const requester = row.requested_by as { accountId?: string | null };
    const isRequester = principal.accountId !== null && requester.accountId === principal.accountId;
    if (!decision.allowed && !isRequester) throw errors.protectedNotFound('operation');
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
