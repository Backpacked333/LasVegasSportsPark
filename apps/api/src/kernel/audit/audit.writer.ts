import { Inject, Injectable } from '@nestjs/common';
import { newId, type Principal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import type { Clock } from '../clock';
import type { Trx } from '../database/unit-of-work';
import { CLOCK } from '../tokens';

export interface AuditEntry {
  organizationId: string;
  actor: Principal;
  action: string;
  targetType: string;
  targetId: string;
  beforeRevision?: number | null;
  afterRevision?: number | null;
  reason?: string | null;
  correlationId?: string | null;
  operationId?: string | null;
  /** Never include child personal information or secrets here (§4.14). */
  details?: Record<string, unknown>;
}

/** Writes append-only audit records inside the caller's transaction so audit and change commit together. */
@Injectable()
export class AuditWriter {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async record(trx: Trx, entry: AuditEntry): Promise<string> {
    const id = newId();
    await trx
      .insertInto('audit_records')
      .values({
        id,
        organization_id: entry.organizationId,
        occurred_at: this.clock.now(),
        actor: json(snapshotActor(entry.actor)),
        action: entry.action,
        target_type: entry.targetType,
        target_id: entry.targetId,
        before_revision: entry.beforeRevision ?? null,
        after_revision: entry.afterRevision ?? null,
        reason: entry.reason ?? null,
        correlation_id: entry.correlationId ?? null,
        operation_id: entry.operationId ?? null,
        details: json(entry.details ?? {}),
      })
      .execute();
    return id;
  }
}

export function snapshotActor(principal: Principal): Record<string, unknown> {
  return {
    kind: principal.kind,
    accountId: principal.accountId,
    personId: principal.personId,
    staffRoles: principal.staffRoles,
    sessionId: principal.sessionId,
    actorLabel: principal.actorLabel,
  };
}
