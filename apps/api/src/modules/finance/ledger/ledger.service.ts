import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type LedgerAccount,
  type LedgerBalance,
  type Principal,
} from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { CLOCK, snapshotActor, type Clock, type Trx } from '../../../kernel';
import type { Reader } from '../finance.shared';

export interface PostingLine {
  account: LedgerAccount;
  debitMinor?: number;
  creditMinor?: number;
  personId?: string | null;
  orderId?: string | null;
  obligationId?: string | null;
  memo?: string | null;
}

export interface PostJournalInput {
  organizationId: string;
  /** The financial fact being posted (receipt, refund, obligation, credit, …). */
  sourceType: string;
  sourceId: string;
  /** One journal per fact and purpose (invariant 5): a replay returns the existing journal. */
  purpose: string;
  description: string;
  currency: string;
  lines: readonly PostingLine[];
  actor: Principal;
  correlationId?: string | null;
  operationId?: string | null;
}

/** Drops zero lines and refuses an unbalanced or one-sided posting before the database does. */
export function balancedLines(lines: readonly PostingLine[]): PostingLine[] {
  const kept = lines.filter((l) => (l.debitMinor ?? 0) > 0 || (l.creditMinor ?? 0) > 0);
  for (const line of kept) {
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit < 0 || credit < 0) {
      throw errors.internal('journal lines must be non-negative integers of minor units');
    }
    if (debit > 0 && credit > 0) throw errors.internal('a journal line is a debit or a credit');
  }
  const debits = kept.reduce((acc, l) => acc + (l.debitMinor ?? 0), 0);
  const credits = kept.reduce((acc, l) => acc + (l.creditMinor ?? 0), 0);
  if (kept.length < 2 || debits !== credits) {
    throw errors.internal(`journal does not balance (debits ${debits}, credits ${credits})`);
  }
  return kept;
}

/**
 * Append-only operational subledger (SPK-PAY-010). Journals and entries are never updated or
 * deleted (database `forbid_mutation`); every journal balances at commit (deferred constraint
 * trigger); a correction is a reversing journal whose entries name what they reverse. Balances
 * are computed sums — no stored balance exists to overwrite.
 */
@Injectable()
export class LedgerService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async post(trx: Trx, input: PostJournalInput): Promise<{ journalId: string; replayed: boolean }> {
    const existing = await trx
      .selectFrom('journals')
      .select('id')
      .where('organization_id', '=', input.organizationId)
      .where('source_type', '=', input.sourceType)
      .where('source_id', '=', input.sourceId)
      .where('purpose', '=', input.purpose)
      .executeTakeFirst();
    if (existing) return { journalId: existing.id, replayed: true };
    const lines = balancedLines(input.lines);
    const journalId = newId();
    await trx
      .insertInto('journals')
      .values({
        id: journalId,
        organization_id: input.organizationId,
        source_type: input.sourceType,
        source_id: input.sourceId,
        purpose: input.purpose,
        description: input.description,
        currency: input.currency,
        reversal_of_journal_id: null,
        posted_at: this.clock.now(),
        posted_by: json(snapshotActor(input.actor)),
        correlation_id: input.correlationId ?? null,
        operation_id: input.operationId ?? null,
      })
      .execute();
    await trx
      .insertInto('journal_entries')
      .values(
        lines.map((line, index) => ({
          id: newId(),
          organization_id: input.organizationId,
          journal_id: journalId,
          line_number: index + 1,
          account_code: line.account,
          debit_minor: line.debitMinor ?? 0,
          credit_minor: line.creditMinor ?? 0,
          currency: input.currency,
          person_id: line.personId ?? null,
          order_id: line.orderId ?? null,
          obligation_id: line.obligationId ?? null,
          reversal_of_entry_id: null,
          memo: line.memo ?? null,
        })),
      )
      .execute();
    return { journalId, replayed: false };
  }

  /**
   * Posts the reversing journal of an earlier posting (SPK-PAY-010 "posted corrections create
   * reversing entries"). Idempotent: a journal is reversed at most once (unique index).
   */
  async reverse(
    trx: Trx,
    input: {
      organizationId: string;
      sourceType: string;
      sourceId: string;
      purpose: string;
      reversalPurpose: string;
      description: string;
      actor: Principal;
      correlationId?: string | null;
    },
  ): Promise<string | null> {
    const original = await trx
      .selectFrom('journals')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('source_type', '=', input.sourceType)
      .where('source_id', '=', input.sourceId)
      .where('purpose', '=', input.purpose)
      .executeTakeFirst();
    if (!original) return null;
    const already = await trx
      .selectFrom('journals')
      .select('id')
      .where('organization_id', '=', input.organizationId)
      .where('reversal_of_journal_id', '=', original.id)
      .executeTakeFirst();
    if (already) return already.id;
    const entries = await trx
      .selectFrom('journal_entries')
      .selectAll()
      .where('journal_id', '=', original.id)
      .orderBy('line_number')
      .execute();
    const journalId = newId();
    await trx
      .insertInto('journals')
      .values({
        id: journalId,
        organization_id: input.organizationId,
        source_type: input.sourceType,
        source_id: input.sourceId,
        purpose: input.reversalPurpose,
        description: input.description,
        currency: original.currency,
        reversal_of_journal_id: original.id,
        posted_at: this.clock.now(),
        posted_by: json(snapshotActor(input.actor)),
        correlation_id: input.correlationId ?? null,
        operation_id: original.operation_id,
      })
      .execute();
    await trx
      .insertInto('journal_entries')
      .values(
        entries.map((entry, index) => ({
          id: newId(),
          organization_id: input.organizationId,
          journal_id: journalId,
          line_number: index + 1,
          account_code: entry.account_code,
          debit_minor: entry.credit_minor,
          credit_minor: entry.debit_minor,
          currency: entry.currency,
          person_id: entry.person_id,
          order_id: entry.order_id,
          obligation_id: entry.obligation_id,
          reversal_of_entry_id: entry.id,
          memo: `reversal: ${entry.memo ?? entry.account_code}`,
        })),
      )
      .execute();
    return journalId;
  }

  /** Computed balances per account (debit-positive). */
  async balances(
    db: Reader,
    organizationId: string,
    currency: string,
    window?: { from: Date; to: Date },
  ): Promise<LedgerBalance[]> {
    let q = db
      .selectFrom('journal_entries')
      .innerJoin('journals', 'journals.id', 'journal_entries.journal_id')
      .select((eb) => [
        'journal_entries.account_code as account_code',
        eb.fn.sum<number>('journal_entries.debit_minor').as('debits'),
        eb.fn.sum<number>('journal_entries.credit_minor').as('credits'),
      ])
      .where('journal_entries.organization_id', '=', organizationId)
      .where('journal_entries.currency', '=', currency)
      .groupBy('journal_entries.account_code')
      .orderBy('journal_entries.account_code');
    if (window) {
      q = q
        .where('journals.posted_at', '>=', window.from)
        .where('journals.posted_at', '<', window.to);
    }
    const rows = await q.execute();
    return rows.map((row) => {
      const debitMinor = Number(row.debits ?? 0);
      const creditMinor = Number(row.credits ?? 0);
      return {
        accountCode: row.account_code,
        debitMinor,
        creditMinor,
        balanceMinor: debitMinor - creditMinor,
      };
    });
  }
}
