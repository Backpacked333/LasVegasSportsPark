import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, executorFor, toAuditRecord, type AuditRecord, type Trx } from '../../../kernel';

/**
 * The two audit lookups a case-action link needs that the kernel does not expose yet (SUP-02,
 * §4.2). `AuditReader` (K-08, IF-44) reads a record's history by target; a link names the
 * evidence of a command by the audit record's id, or by the operation that ran the command, and
 * neither carries the target. Until the kernel offers `AuditReader.byId` and a read by operation,
 * these two read-only selects of `audit_records` are the only place support reads a kernel table
 * (`__tests__/kernel-boundary.spec.ts` enforces it). Every other read of kernel records goes
 * through `OperationalExceptions`, `OperationsService`, `AuditReader`, `OutboxHistory` or
 * `FacilityDirectory`, and no kernel table is ever written here.
 */
@Injectable()
export class AuditEvidence {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /** One audit record of the organization by id, or null (another organization's reads as null). */
  async byId(organizationId: string, id: string, trx?: Trx): Promise<AuditRecord | null> {
    const row = await (trx ?? executorFor(this.db))
      .selectFrom('audit_records')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toAuditRecord(row) : null;
  }

  /** The first audit record of `action` written by the operation, or null. */
  async ofOperation(
    organizationId: string,
    operationId: string,
    action: string,
    trx?: Trx,
  ): Promise<AuditRecord | null> {
    const row = await (trx ?? executorFor(this.db))
      .selectFrom('audit_records')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('operation_id', '=', operationId)
      .where('action', '=', action)
      .orderBy('occurred_at')
      .orderBy('id')
      .executeTakeFirst();
    return row ? toAuditRecord(row) : null;
  }
}
