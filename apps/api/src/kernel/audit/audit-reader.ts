import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  z,
  type AuditRecordView,
  type ListAuditRecordsQueryInput,
  type ListProviderEventsQueryInput,
  type Page,
  type Principal,
  type ProviderEventView,
} from '@sportspark/contracts';
import type { AuditRecordsTable, Db, InboxEventsTable } from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import { CoreActions } from '../authorization/core-actions';
import { AuthorizationService } from '../authorization/authorization.service';
import { executorFor } from '../database/transaction-context';
import { UnitOfWork, type Trx } from '../database/unit-of-work';
import { DATABASE } from '../tokens';
import { AuditWriter } from './audit.writer';

const Cursor = z.object({ at: z.string(), id: z.uuid() });

/** One audit record as it is read back (§4.14). */
export type AuditRecord = AuditRecordView;

export function toAuditRecord(row: Selectable<AuditRecordsTable>): AuditRecord {
  const actor = (row.actor ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    id: row.id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    actor: {
      kind: text(actor['kind']) ?? 'unknown',
      accountId: text(actor['accountId']),
      personId: text(actor['personId']),
      staffRoles: Array.isArray(actor['staffRoles']) ? (actor['staffRoles'] as string[]) : [],
      sessionId: text(actor['sessionId']),
      actorLabel: text(actor['actorLabel']) ?? '',
    },
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    beforeRevision: row.before_revision,
    afterRevision: row.after_revision,
    reason: row.reason,
    correlationId: row.correlation_id,
    operationId: row.operation_id,
    details: (row.details ?? {}) as Record<string, unknown>,
  };
}

/**
 * Audit history of one record for the modules (K-08, IF-44; §4.2: audit_records is a kernel
 * table, so a module reads its records' history here). Newest first; never another
 * organization's records; reads join the active transaction unless a handle is passed.
 */
@Injectable()
export class AuditReader {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async forTarget(
    organizationId: string,
    targetType: string,
    targetId: string,
    options: { actions?: readonly string[]; limit?: number } = {},
    db?: Db | Trx,
  ): Promise<AuditRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    let query = (db ?? executorFor(this.db))
      .selectFrom('audit_records')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId);
    if (options.actions) {
      if (options.actions.length === 0) return [];
      query = query.where('action', 'in', [...options.actions]);
    }
    const rows = await query
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toAuditRecord);
  }
}

/**
 * The audit log and provider-event reads for authorized staff (K-08, §4.14, §4.12). Reading the
 * audit log is itself a privileged action, so the read and its own audit record commit together.
 * Provider events never expose their payloads (§4.14: they may carry customer data).
 */
@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  async listAuditRecords(
    principal: Principal,
    query: ListAuditRecordsQueryInput,
    correlationId: string | null,
  ): Promise<Page<AuditRecord>> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, CoreActions.viewAudit, {
        type: 'audit_log',
        organizationId,
      });
      const cursor = decodeCursor(query.cursor, Cursor);
      if (query.cursor && !cursor) throw errors.validation('The cursor is not valid.');
      let q = trx
        .selectFrom('audit_records')
        .selectAll()
        .where('organization_id', '=', organizationId);
      if (query.targetType) q = q.where('target_type', '=', query.targetType);
      if (query.targetId) q = q.where('target_id', '=', query.targetId);
      if (query.actorPersonId) {
        q = q.where(sql<string>`actor ->> 'personId'`, '=', query.actorPersonId);
      }
      if (query.action) q = q.where('action', '=', query.action);
      if (query.operationId) q = q.where('operation_id', '=', query.operationId);
      if (query.correlationId) q = q.where('correlation_id', '=', query.correlationId);
      if (query.from) q = q.where('occurred_at', '>=', new Date(query.from));
      if (query.to) q = q.where('occurred_at', '<', new Date(query.to));
      if (cursor) {
        const at = new Date(cursor.at);
        q = q.where((eb) =>
          eb.or([
            eb('occurred_at', '<', at),
            eb.and([eb('occurred_at', '=', at), eb('id', '<', cursor.id)]),
          ]),
        );
      }
      const rows = await q
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.limit + 1)
        .execute();
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      // §4.14: the read of privileged history is itself audited, with the filters it used.
      const { cursor: _cursor, limit: _limit, ...filters } = query;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CoreActions.viewAudit.id,
        targetType: 'audit_log',
        targetId: organizationId,
        correlationId,
        details: { filters, cursor: query.cursor ?? null, returned: page.length },
      });
      return {
        items: page.map(toAuditRecord),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ at: new Date(last.occurred_at).toISOString(), id: last.id })
            : null,
      };
    });
  }

  async listProviderEvents(
    principal: Principal,
    query: ListProviderEventsQueryInput,
  ): Promise<Page<ProviderEventView>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CoreActions.viewProviderEvents, {
      type: 'provider_event',
      organizationId,
    });
    const cursor = decodeCursor(query.cursor, Cursor);
    if (query.cursor && !cursor) throw errors.validation('The cursor is not valid.');
    let q = this.db
      .selectFrom('inbox_events')
      .select([
        'id',
        'provider',
        'provider_event_id',
        'event_type',
        'signature_verified',
        'status',
        'attempts',
        'last_error',
        'received_at',
        'processed_at',
      ])
      .where('organization_id', '=', organizationId);
    if (query.provider) q = q.where('provider', '=', query.provider);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.eventType) q = q.where('event_type', '=', query.eventType);
    if (query.from) q = q.where('received_at', '>=', new Date(query.from));
    if (query.to) q = q.where('received_at', '<', new Date(query.to));
    if (cursor) {
      const at = new Date(cursor.at);
      q = q.where((eb) =>
        eb.or([
          eb('received_at', '<', at),
          eb.and([eb('received_at', '=', at), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('received_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toProviderEvent),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: new Date(last.received_at).toISOString(), id: last.id })
          : null,
    };
  }
}

function toProviderEvent(
  row: Pick<
    Selectable<InboxEventsTable>,
    | 'id'
    | 'provider'
    | 'provider_event_id'
    | 'event_type'
    | 'signature_verified'
    | 'status'
    | 'attempts'
    | 'last_error'
    | 'received_at'
    | 'processed_at'
  >,
): ProviderEventView {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    signatureVerified: row.signature_verified,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    receivedAt: new Date(row.received_at).toISOString(),
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
  };
}

function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}
