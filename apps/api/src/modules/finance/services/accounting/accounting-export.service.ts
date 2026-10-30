import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  errors,
  newId,
  systemPrincipal,
  type AccountingExportBatch,
  type AccountingMapping,
  type ApproveAccountingMappingInput,
  type CancelAccountingBatchInput,
  type ListAccountingBatchesQuery,
  type ListAccountingMappingsQuery,
  type Page,
  type PrepareAccountingBatchInput,
  type Principal,
  type ProposeAccountingMappingInput,
  type RetireAccountingMappingInput,
  type SubmitAccountingBatchInput,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  type AccountingExportBatchesTable,
  type AccountingExportLinesTable,
  type AccountingMappingsTable,
  type Db,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  MODULE_SETTINGS,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  renewJobLease,
  snapshotActor,
  type Clock,
  type PeriodicJobContext,
  type PeriodicJobResult,
  type Trx,
} from '../../../../kernel';
import { FinanceActions } from '../../finance.actions';
import { FinanceEvents } from '../../finance.events';
import {
  ACCOUNTING_EXPORT_PORT,
  type AccountingBatchSubmission,
  type AccountingExportPort,
  type AccountingSubmitResult,
} from '../../finance.ports';
import type { FinanceSettingsValue } from '../../finance.settings';
import {
  afterKeysetDesc,
  decodeKeyset,
  iso,
  isoOrNull,
  keysetAt,
  keysetPage,
  organizationOf,
  type Reader,
} from '../../finance.shared';
import {
  AccountingExportBatchMachine,
  AccountingMappingMachine,
} from '../../finance.state-machines';

type MappingRow = Selectable<AccountingMappingsTable>;
type BatchRow = Selectable<AccountingExportBatchesTable>;
type LineRow = Selectable<AccountingExportLinesTable>;

export const RECONCILE_ACCOUNTING_JOB = 'finance.reconcile_accounting_exports';

function toMapping(row: MappingRow): AccountingMapping {
  return {
    id: row.id,
    ledgerAccount: row.ledger_account,
    externalAccountRef: row.external_account_ref,
    status: row.status,
    proposedByPersonId: row.proposed_by_person_id,
    approvedByPersonId: row.approved_by_person_id,
    approvedAt: isoOrNull(row.approved_at),
    retiredAt: isoOrNull(row.retired_at),
    retireReason: row.retire_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

/** The exact content a batch submits; its checksum is over this JSON (SHA-256). */
function submissionLines(lines: LineRow[]): AccountingBatchSubmission['lines'] {
  return lines.map((l) => ({
    journalEntryId: l.journal_entry_id,
    externalAccountRef: l.external_account_ref,
    debitMinor: Number(l.debit_minor),
    creditMinor: Number(l.credit_minor),
    currency: l.currency,
    postedAt: iso(l.posted_at),
    memo: l.memo,
  }));
}

function checksumOf(lines: AccountingBatchSubmission['lines']): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(lines)).digest('hex')}`;
}

/**
 * Accounting mappings and export batches (FIN-07; §3.16 Accounting row, SPK-PAY-010, SPK-PAY-011,
 * §4.11, §4.12, §5.2 accounting gate). Behind the `accounting` capability (DEC-016, DEC-081):
 * proposing and approving mappings, preparing and submitting batches are new commitments; retiring
 * a mapping, canceling a prepared batch, reads, reconciliation and provider outcomes never check it.
 *
 * - No default mapping: a batch is prepared only when every account of its entries has an approved
 *   mapping (else ACCOUNTING_MAPPING_REQUIRED naming the accounts), approved by someone other than
 *   its proposer (database check `accounting_mappings_four_eyes`).
 * - At-most-once export: a journal entry has at most one live export line (partial unique index);
 *   a rejected or canceled batch's lines stop being live so the entries can be exported again.
 * - Submission (§4.11): unit of work 1 records `submitted`; the connection is called outside any
 *   transaction with the batch's idempotency key; unit of work 2 records accepted, rejected or
 *   unknown. The job `finance.reconcile_accounting_exports` asks about unknown batches and about
 *   submitted ones older than FINANCE_ACCOUNTING_SUBMIT_STALE_SECONDS, and resubmits with the same
 *   key when the connection has no record, so a stop after the call never strands a batch and the
 *   connection never records a second one.
 * - Corrections are later journals exported in a later batch (SPK-PAY-010); an exported batch never
 *   changes. Revenue recognition is not done (DEC-022).
 */
@Injectable()
export class AccountingExportService {
  private readonly logger = new Logger(AccountingExportService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ACCOUNTING_EXPORT_PORT) private readonly connection: AccountingExportPort,
    @Inject(MODULE_SETTINGS('finance')) private readonly settings: FinanceSettingsValue,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: CapabilityService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Mappings
  // -------------------------------------------------------------------------------------------

  private async lockMapping(trx: Trx, organizationId: string, id: string): Promise<MappingRow> {
    const row = await trx
      .selectFrom('accounting_mappings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('accounting mapping', id);
    return row;
  }

  private async announceMapping(trx: Trx, row: MappingRow, correlationId: string | null) {
    await this.outbox.enqueue(trx, FinanceEvents.accountingMappingChanged, {
      organizationId: row.organization_id,
      aggregateType: 'accounting_mapping',
      aggregateId: row.id,
      correlationId,
      payload: { mappingId: row.id, ledgerAccount: row.ledger_account, status: row.status },
    });
  }

  async proposeMapping(
    principal: Principal,
    input: ProposeAccountingMappingInput,
    correlationId: string | null,
  ): Promise<AccountingMapping> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.manageAccountingMappings, {
      type: 'accounting_mapping',
      organizationId,
    });
    if (!principal.personId) throw errors.accessDenied('A mapping is proposed by a named person.');
    const proposer = principal.personId;
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'accounting', trx);
      const id = newId();
      await trx
        .insertInto('accounting_mappings')
        .values({
          id,
          organization_id: organizationId,
          ledger_account: input.ledgerAccount,
          external_account_ref: input.externalAccountRef,
          proposed_by: json(snapshotActor(principal)),
          proposed_by_person_id: proposer,
          approved_by: null,
          approved_by_person_id: null,
          approved_at: null,
          retired_at: null,
          retire_reason: null,
        })
        .execute();
      const row = await this.lockMapping(trx, organizationId, id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.manageAccountingMappings.id,
        targetType: 'accounting_mapping',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          ledgerAccount: input.ledgerAccount,
          externalAccountRef: input.externalAccountRef,
        },
      });
      await this.announceMapping(trx, row, correlationId);
      return toMapping(row);
    });
  }

  async approveMapping(
    principal: Principal,
    id: string,
    input: ApproveAccountingMappingInput,
    correlationId: string | null,
  ): Promise<AccountingMapping> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.approveAccountingMapping, {
      type: 'accounting_mapping',
      id,
      organizationId,
    });
    if (!principal.personId) throw errors.accessDenied('A mapping is approved by a named person.');
    const approver = principal.personId;
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'accounting', trx);
      const row = await this.lockMapping(trx, organizationId, id);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = AccountingMappingMachine.next(row.status, 'approve');
      if (row.proposed_by_person_id === approver) {
        throw errors.resourceConflict('A mapping is approved by someone other than its proposer.', {
          code: 'FOUR_EYES_REQUIRED',
        });
      }
      try {
        await trx
          .updateTable('accounting_mappings')
          .set({
            status,
            approved_by: json(snapshotActor(principal)),
            approved_by_person_id: approver,
            approved_at: this.clock.now(),
            revision: row.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .where('revision', '=', row.revision)
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict(
            'This ledger account already has an approved mapping; retire it first.',
            { code: 'MAPPING_ALREADY_APPROVED', ledgerAccount: row.ledger_account },
          );
        }
        throw error;
      }
      const updated = await this.lockMapping(trx, organizationId, id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.approveAccountingMapping.id,
        targetType: 'accounting_mapping',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          ledgerAccount: row.ledger_account,
          externalAccountRef: row.external_account_ref,
        },
      });
      await this.announceMapping(trx, updated, correlationId);
      return toMapping(updated);
    });
  }

  /** Withdraws a proposal or retires an approved mapping (never gated by the capability). */
  async retireMapping(
    principal: Principal,
    id: string,
    input: RetireAccountingMappingInput,
    correlationId: string | null,
  ): Promise<AccountingMapping> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.manageAccountingMappings, {
      type: 'accounting_mapping',
      id,
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockMapping(trx, organizationId, id);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = AccountingMappingMachine.next(
        row.status,
        row.status === 'proposed' ? 'withdraw' : 'retire',
      );
      await trx
        .updateTable('accounting_mappings')
        .set({
          status,
          retired_at: this.clock.now(),
          retire_reason: input.reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirstOrThrow();
      const updated = await this.lockMapping(trx, organizationId, id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.manageAccountingMappings.id}.retire`,
        targetType: 'accounting_mapping',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason,
        correlationId,
        details: { from: row.status },
      });
      await this.announceMapping(trx, updated, correlationId);
      return toMapping(updated);
    });
  }

  async listMappings(
    principal: Principal,
    query: ListAccountingMappingsQuery,
  ): Promise<Page<AccountingMapping>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.readAccounting, {
      type: 'accounting_mapping',
      organizationId,
    });
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('accounting_mappings')
      .selectAll()
      .select(keysetAt('accounting_mappings').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.ledgerAccount) q = q.where('ledger_account', '=', query.ledgerAccount);
    if (cursor) q = q.where(afterKeysetDesc('accounting_mappings', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map(toMapping), nextCursor: page.nextCursor };
  }

  // -------------------------------------------------------------------------------------------
  // Batches
  // -------------------------------------------------------------------------------------------

  private async lines(db: Reader, organizationId: string, batchId: string): Promise<LineRow[]> {
    return db
      .selectFrom('accounting_export_lines')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('batch_id', '=', batchId)
      .orderBy('line_number')
      .execute();
  }

  private async batchView(
    db: Reader,
    row: BatchRow,
    withLines: boolean,
  ): Promise<AccountingExportBatch> {
    const lines = await this.lines(db, row.organization_id, row.id);
    const totals = new Map<string, { debitMinor: number; creditMinor: number }>();
    for (const line of lines) {
      const t = totals.get(line.currency) ?? { debitMinor: 0, creditMinor: 0 };
      t.debitMinor += Number(line.debit_minor);
      t.creditMinor += Number(line.credit_minor);
      totals.set(line.currency, t);
    }
    return {
      id: row.id,
      periodStart: iso(row.period_start),
      periodEnd: iso(row.period_end),
      status: row.status,
      checksum: row.checksum,
      lineCount: row.line_count,
      totals: [...totals].map(([currency, t]) => ({ currency, ...t })),
      providerReference: row.provider_reference,
      lastError: row.last_error,
      preparedByPersonId: row.prepared_by_person_id,
      preparedAt: iso(row.prepared_at),
      submittedAt: isoOrNull(row.submitted_at),
      decidedAt: isoOrNull(row.decided_at),
      canceledAt: isoOrNull(row.canceled_at),
      cancelReason: row.cancel_reason,
      revision: row.revision,
      lines: withLines
        ? lines.map((l) => ({
            id: l.id,
            lineNumber: l.line_number,
            journalEntryId: l.journal_entry_id,
            ledgerAccount: l.ledger_account,
            externalAccountRef: l.external_account_ref,
            debitMinor: Number(l.debit_minor),
            creditMinor: Number(l.credit_minor),
            currency: l.currency,
            postedAt: iso(l.posted_at),
            memo: l.memo,
            live: l.live,
          }))
        : null,
    };
  }

  private async lockBatch(trx: Trx, organizationId: string, id: string): Promise<BatchRow> {
    const row = await trx
      .selectFrom('accounting_export_batches')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('accounting export batch', id);
    return row;
  }

  private async announceBatch(trx: Trx, row: BatchRow, correlationId: string | null) {
    await this.outbox.enqueue(trx, FinanceEvents.accountingBatchChanged, {
      organizationId: row.organization_id,
      aggregateType: 'accounting_export_batch',
      aggregateId: row.id,
      correlationId,
      payload: { batchId: row.id, status: row.status, lineCount: row.line_count },
    });
  }

  /**
   * Prepares a batch from the journal entries posted in [periodStart, periodEnd) that have no live
   * export line. Refused, naming the accounts, when any of them has no approved mapping.
   */
  async prepareBatch(
    principal: Principal,
    input: PrepareAccountingBatchInput,
    correlationId: string | null,
  ): Promise<AccountingExportBatch> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.exportAccounting, {
      type: 'accounting_export_batch',
      organizationId,
    });
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    try {
      return await this.uow.run(async ({ trx }) => {
        await this.capabilities.require(organizationId, 'accounting', trx);
        const entries = await trx
          .selectFrom('journal_entries as e')
          .innerJoin('journals as j', (join) =>
            join
              .onRef('j.id', '=', 'e.journal_id')
              .onRef('j.organization_id', '=', 'e.organization_id'),
          )
          .select([
            'e.id as id',
            'e.account_code as account_code',
            'e.debit_minor as debit_minor',
            'e.credit_minor as credit_minor',
            'e.currency as currency',
            'e.memo as memo',
            'j.posted_at as posted_at',
            'j.description as description',
            'e.line_number as line_number',
          ])
          .where('e.organization_id', '=', organizationId)
          .where('j.posted_at', '>=', periodStart)
          .where('j.posted_at', '<', periodEnd)
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom('accounting_export_lines as l')
                  .select(sql`1`.as('one'))
                  .whereRef('l.organization_id', '=', 'e.organization_id')
                  .whereRef('l.journal_entry_id', '=', 'e.id')
                  .where('l.live', '=', true),
              ),
            ),
          )
          .orderBy('j.posted_at')
          .orderBy('j.id')
          .orderBy('e.line_number')
          .execute();
        if (entries.length === 0) {
          throw errors.resourceConflict('No journal entry of this period is left to export.', {
            code: 'NOTHING_TO_EXPORT',
          });
        }
        const mappings = await trx
          .selectFrom('accounting_mappings')
          .select(['ledger_account', 'external_account_ref'])
          .where('organization_id', '=', organizationId)
          .where('status', '=', 'approved')
          .execute();
        const byAccount = new Map(mappings.map((m) => [m.ledger_account, m.external_account_ref]));
        const unmapped = [...new Set(entries.map((e) => e.account_code))]
          .filter((account) => !byAccount.has(account))
          .sort();
        if (unmapped.length > 0) {
          // SPK-PAY-011, DEC-022: no account is exported under an assumed mapping.
          throw errors.resourceConflict(
            `These accounts have no approved mapping: ${unmapped.join(', ')}.`,
            { code: 'ACCOUNTING_MAPPING_REQUIRED', accounts: unmapped },
          );
        }
        const batchId = newId();
        const lines = entries.map((e, index) => ({
          id: newId(),
          organization_id: organizationId,
          batch_id: batchId,
          journal_entry_id: e.id,
          line_number: index + 1,
          ledger_account: e.account_code,
          external_account_ref: byAccount.get(e.account_code) as string,
          debit_minor: Number(e.debit_minor),
          credit_minor: Number(e.credit_minor),
          currency: e.currency,
          posted_at: new Date(e.posted_at),
          memo: e.memo ?? e.description,
        }));
        const checksum = checksumOf(
          lines.map((l) => ({
            journalEntryId: l.journal_entry_id,
            externalAccountRef: l.external_account_ref,
            debitMinor: l.debit_minor,
            creditMinor: l.credit_minor,
            currency: l.currency,
            postedAt: iso(l.posted_at),
            memo: l.memo,
          })),
        );
        const now = this.clock.now();
        await trx
          .insertInto('accounting_export_batches')
          .values({
            id: batchId,
            organization_id: organizationId,
            period_start: periodStart,
            period_end: periodEnd,
            idempotency_key: `acct-${batchId}`,
            checksum,
            line_count: lines.length,
            provider_reference: null,
            last_error: null,
            prepared_by: json(snapshotActor(principal)),
            prepared_by_person_id: principal.personId,
            prepared_at: now,
            submitted_at: null,
            decided_at: null,
            canceled_at: null,
            cancel_reason: null,
          })
          .execute();
        await trx.insertInto('accounting_export_lines').values(lines).execute();
        const row = await this.lockBatch(trx, organizationId, batchId);
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: FinanceActions.exportAccounting.id,
          targetType: 'accounting_export_batch',
          targetId: batchId,
          afterRevision: 1,
          reason: input.reason ?? null,
          correlationId,
          details: {
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            lineCount: lines.length,
            checksum,
          },
        });
        await this.announceBatch(trx, row, correlationId);
        return this.batchView(trx, row, true);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another batch took some of these entries meanwhile (accounting_export_lines_live_entry_idx).
        throw errors.resourceConflict(
          'Some of these entries were just prepared in another batch.',
          {
            code: 'ENTRIES_ALREADY_IN_BATCH',
          },
        );
      }
      throw error;
    }
  }

  /**
   * Submits a prepared batch (§4.11): `submitted` is committed first, the connection is called
   * outside any transaction, and its answer is recorded in a second unit of work.
   */
  async submitBatch(
    principal: Principal,
    id: string,
    input: SubmitAccountingBatchInput,
    correlationId: string | null,
  ): Promise<AccountingExportBatch> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.exportAccounting, {
      type: 'accounting_export_batch',
      id,
      organizationId,
    });
    const submission = await this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'accounting', trx);
      const row = await this.lockBatch(trx, organizationId, id);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = AccountingExportBatchMachine.next(row.status, 'submit');
      await trx
        .updateTable('accounting_export_batches')
        .set({ status, submitted_at: this.clock.now(), revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirstOrThrow();
      const updated = await this.lockBatch(trx, organizationId, id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.exportAccounting.id}.submit`,
        targetType: 'accounting_export_batch',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
      });
      await this.announceBatch(trx, updated, correlationId);
      return this.submissionOf(trx, updated);
    });
    const result = await this.call(() => this.connection.submitBatch(submission));
    await this.uow.run(({ trx }) =>
      this.recordOutcome(trx, organizationId, id, result, correlationId),
    );
    return this.get(principal, id);
  }

  private async submissionOf(db: Reader, row: BatchRow): Promise<AccountingBatchSubmission> {
    return {
      organizationId: row.organization_id,
      batchId: row.id,
      idempotencyKey: row.idempotency_key,
      periodStart: iso(row.period_start),
      periodEnd: iso(row.period_end),
      lines: submissionLines(await this.lines(db, row.organization_id, row.id)),
      checksum: row.checksum,
    };
  }

  /** A connection call outside any transaction; a thrown error is an unknown outcome. */
  private async call<T extends AccountingSubmitResult | { outcome: 'not_found' }>(
    fn: () => Promise<T>,
  ): Promise<T | { outcome: 'unknown'; error: string }> {
    if (this.uow.current()) {
      throw errors.internal('a provider call must never run inside a database transaction (§4.11)');
    }
    try {
      return await fn();
    } catch (error) {
      this.logger.warn(`accounting connection gave no outcome: ${String(error)}`);
      return { outcome: 'unknown', error: 'the accounting connection gave no answer' };
    }
  }

  /** Records the connection's answer through the batch machine (idempotent under replay). */
  private async recordOutcome(
    trx: Trx,
    organizationId: string,
    id: string,
    result: AccountingSubmitResult,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.lockBatch(trx, organizationId, id);
    const actor = systemPrincipal(organizationId, 'finance.accounting_export');
    const now = this.clock.now();
    if (result.outcome === 'unknown') {
      if (AccountingExportBatchMachine.can(row.status, 'lose')) {
        await trx
          .updateTable('accounting_export_batches')
          .set({
            status: AccountingExportBatchMachine.next(row.status, 'lose'),
            last_error: result.error,
            revision: row.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .execute();
        // COMMANDS-05 (§4.4 audit, SPK-PAY-011): the batch's audit trail shows when its answer was
        // lost and why, the step a finance operator reconciles.
        await this.audit.record(trx, {
          organizationId,
          actor,
          action: 'finance.accounting_batch_unknown',
          targetType: 'accounting_export_batch',
          targetId: id,
          beforeRevision: row.revision,
          afterRevision: row.revision + 1,
          correlationId,
          details: { from: row.status, error: result.error },
        });
        await this.exceptions.raise(trx, {
          organizationId,
          category: 'finance.accounting_export_unknown',
          severity: 'high',
          title:
            'An accounting export batch has no answer yet; it is reconciled, never resent blindly',
          affectedType: 'accounting_export_batch',
          affectedId: id,
          ownerQueue: 'finance_operator',
          dedupeKey: `accounting-unknown:${id}`,
          details: { lineCount: row.line_count, error: result.error },
        });
        await this.announceBatch(trx, { ...row, status: 'unknown' }, correlationId);
      } else if (row.status === 'unknown') {
        await trx
          .updateTable('accounting_export_batches')
          .set({ last_error: result.error })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .execute();
      }
      return;
    }
    const event = result.outcome === 'accepted' ? 'accept' : 'reject';
    if (!AccountingExportBatchMachine.can(row.status, event)) {
      const same =
        (result.outcome === 'accepted' && row.status === 'accepted') ||
        (result.outcome === 'rejected' && row.status === 'rejected');
      if (same) return; // a replayed answer: one effect
      await this.exceptions.raise(trx, {
        organizationId,
        category: 'finance.accounting_export_conflict',
        severity: 'critical',
        title: `The accounting connection reported ${result.outcome} for a batch recorded as ${row.status}`,
        affectedType: 'accounting_export_batch',
        affectedId: id,
        ownerQueue: 'finance_operator',
        dedupeKey: `accounting-conflict:${id}:${result.outcome}`,
        details: { recordedStatus: row.status, reported: result.outcome },
      });
      return;
    }
    const status = AccountingExportBatchMachine.next(row.status, event);
    await trx
      .updateTable('accounting_export_batches')
      .set({
        status,
        decided_at: now,
        provider_reference: result.outcome === 'accepted' ? result.providerReference : null,
        last_error: result.outcome === 'rejected' ? result.error : null,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .execute();
    if (status === 'rejected') {
      // The entries can be exported again in a new batch (at-most-once applies to live lines).
      await trx
        .updateTable('accounting_export_lines')
        .set({ live: false })
        .where('organization_id', '=', organizationId)
        .where('batch_id', '=', id)
        .where('live', '=', true)
        .execute();
      await this.exceptions.raise(trx, {
        organizationId,
        category: 'finance.accounting_export_rejected',
        severity: 'high',
        title:
          'The accounting connection rejected an export batch; its entries can be exported again',
        affectedType: 'accounting_export_batch',
        affectedId: id,
        ownerQueue: 'finance_operator',
        dedupeKey: `accounting-rejected:${id}`,
        details: { error: result.outcome === 'rejected' ? result.error : null },
      });
    }
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: `finance.accounting_batch_${status}`,
      targetType: 'accounting_export_batch',
      targetId: id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId,
      details: {
        from: row.status,
        providerReference: result.outcome === 'accepted' ? result.providerReference : null,
      },
    });
    await this.announceBatch(trx, { ...row, status }, correlationId);
  }

  /** Cancels a prepared batch; its entries can be prepared again (never gated). */
  async cancelBatch(
    principal: Principal,
    id: string,
    input: CancelAccountingBatchInput,
    correlationId: string | null,
  ): Promise<AccountingExportBatch> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.exportAccounting, {
      type: 'accounting_export_batch',
      id,
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockBatch(trx, organizationId, id);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = AccountingExportBatchMachine.next(row.status, 'cancel');
      await trx
        .updateTable('accounting_export_batches')
        .set({
          status,
          canceled_at: this.clock.now(),
          cancel_reason: input.reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('accounting_export_lines')
        .set({ live: false })
        .where('organization_id', '=', organizationId)
        .where('batch_id', '=', id)
        .where('live', '=', true)
        .execute();
      const updated = await this.lockBatch(trx, organizationId, id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.exportAccounting.id}.cancel`,
        targetType: 'accounting_export_batch',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason,
        correlationId,
      });
      await this.announceBatch(trx, updated, correlationId);
      return this.batchView(trx, updated, true);
    });
  }

  async get(principal: Principal, id: string): Promise<AccountingExportBatch> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.readAccounting, {
      type: 'accounting_export_batch',
      id,
      organizationId,
    });
    const row = await this.db
      .selectFrom('accounting_export_batches')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('accounting export batch', id);
    return this.batchView(this.db, row, true);
  }

  async list(
    principal: Principal,
    query: ListAccountingBatchesQuery,
  ): Promise<Page<AccountingExportBatch>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.readAccounting, {
      type: 'accounting_export_batch',
      organizationId,
    });
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('accounting_export_batches')
      .selectAll()
      .select(keysetAt('accounting_export_batches').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(afterKeysetDesc('accounting_export_batches', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: AccountingExportBatch[] = [];
    for (const row of page.rows) items.push(await this.batchView(this.db, row, false));
    return { items, nextCursor: page.nextCursor };
  }

  // -------------------------------------------------------------------------------------------
  // Reconciliation job (§4.12; IF-24 failure owner finance_operator)
  // -------------------------------------------------------------------------------------------

  /**
   * `finance.reconcile_accounting_exports`: for each unknown batch, and each submitted one older
   * than the stale threshold, asks the connection for the batch's status by its key (outside any
   * transaction): an answer is recorded; `not_found` means the request never arrived, so it is
   * resubmitted with the same key (the connection deduplicates on it). One small transaction per
   * batch; reads every organization (the job runs as the system).
   */
  async reconcile(context: PeriodicJobContext): Promise<PeriodicJobResult> {
    const staleBefore = new Date(
      context.now.getTime() - this.settings.ACCOUNTING_SUBMIT_STALE_SECONDS * 1000,
    );
    const due = this.db
      .selectFrom('accounting_export_batches')
      .where((eb) =>
        eb.or([
          eb('status', '=', 'unknown'),
          eb.and([eb('status', '=', 'submitted'), eb('submitted_at', '<=', staleBefore)]),
        ]),
      );
    const rows = await due
      .selectAll()
      .orderBy('updated_at')
      .orderBy('id')
      .limit(context.batchSize)
      .execute();
    let processed = 0;
    for (const row of rows) {
      // K-06 (ASYNC-06, SPK-AT-023): the run's lease is renewed before each provider call, outside
      // any transaction; once another runner holds the job (or the runner gave up on this run) no
      // further batch is asked about or resubmitted, and the rest stays due for that run.
      if (!(await renewJobLease(context))) break;
      const status = await this.call(() =>
        this.connection.batchStatus({
          organizationId: row.organization_id,
          batchId: row.id,
          idempotencyKey: row.idempotency_key,
        }),
      );
      let result: AccountingSubmitResult;
      if (status.outcome === 'not_found') {
        // The status answer is recorded only with the resubmission's outcome; without the lease
        // the batch stays as it was (submitted or unknown) and is asked about again.
        if (!(await renewJobLease(context))) break;
        const submission = await this.submissionOf(this.db, row);
        result = await this.call(() => this.connection.submitBatch(submission));
        await this.uow.run(async ({ trx }) => {
          await trx
            .updateTable('accounting_export_batches')
            .set({ submitted_at: context.now })
            .where('organization_id', '=', row.organization_id)
            .where('id', '=', row.id)
            .where('status', 'in', ['submitted', 'unknown'])
            .execute();
        });
      } else {
        result = status;
      }
      await this.uow.run(({ trx }) =>
        this.recordOutcome(trx, row.organization_id, row.id, result, null),
      );
      processed += 1;
    }
    const left = await due
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    return { processed, remaining: rows.length < context.batchSize ? 0 : Number(left.n) };
  }
}
