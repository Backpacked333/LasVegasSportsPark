import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, executorFor, type Trx } from '../../../kernel';
import type {
  ConditionFinding,
  FinancialConditionsPort,
  FixtureConditionContext,
} from '../../competition';
import { FinancialStandingService } from './financial-standing.service';

/** Same shape as entry's FinancialStanding (entry consumes this service; §4.2 order). */
export type ParticipationStanding =
  | { status: 'clear' }
  | {
      status: 'outstanding';
      related: boolean;
      amountMinor: number;
      currency: string;
      reference: string | null;
    }
  | { status: 'unknown'; explanation: string };

/**
 * Finance facts other modules evaluate participation against. Read-only, organization-scoped and
 * through the caller's transaction when there is one (§4.2: callers never read finance tables).
 *
 * - Fixture readiness "Applicable financial conditions" (SPK-READY-001), registered as
 *   competition's FINANCIAL_CONDITIONS_IMPL: no open obligation of a competing team entry is
 *   satisfied; an open one is reported `unknown`, never a block and never a pass, because whether
 *   an open team balance affects play is pending POL-017 / DEC-056.
 * - Arrival standing (SPK-ENTRY-004): delegated to FinancialStandingService, which finance
 *   registers as entry's FINANCIAL_STANDING_IMPL (FIN-03). Entry decides what a balance does
 *   (informational by default, DEC-056).
 */
@Injectable()
export class ParticipationStandingService implements FinancialConditionsPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly standing: FinancialStandingService,
  ) {}

  async fixtureConditions(
    organizationId: string,
    context: FixtureConditionContext,
    trx?: Trx,
  ): Promise<ConditionFinding[]> {
    if (context.teamEntryIds.length === 0) return [];
    const open = await (trx ?? executorFor(this.db))
      .selectFrom('obligations')
      .select([
        'id',
        'debtor_team_entry_id',
        'amount_minor',
        'allocated_minor',
        'currency',
        'due_at',
      ])
      .where('organization_id', '=', organizationId)
      .where('debtor_kind', '=', 'team_entry')
      .where('debtor_team_entry_id', 'in', context.teamEntryIds)
      .where('status', '=', 'open')
      .orderBy('due_at')
      .orderBy('id')
      .execute();
    const byEntry = new Map<string, typeof open>();
    for (const row of open) {
      const entry = row.debtor_team_entry_id as string;
      byEntry.set(entry, [...(byEntry.get(entry) ?? []), row]);
    }
    const findings: ConditionFinding[] = [];
    for (const [teamEntryId, rows] of byEntry) {
      const totals = new Map<string, number>();
      for (const row of rows) {
        const remaining = Number(row.amount_minor) - Number(row.allocated_minor);
        totals.set(row.currency, (totals.get(row.currency) ?? 0) + remaining);
      }
      const amounts = [...totals].map(([currency, minor]) => `${minor} ${currency} (minor units)`);
      const first = rows[0];
      findings.push({
        // POL-017 / DEC-056 (pending): whether an open team balance affects play is undecided, so
        // the condition is neither a pass nor a block.
        status: 'unknown',
        code: 'team_balance_policy_pending',
        message: `The team entry has ${rows.length} open obligation(s) totalling ${amounts.join(', ')}; whether an open team balance affects play awaits the approved participation policy (POL-017, DEC-056).`,
        source: { type: 'team_entry', id: teamEntryId },
        responsibleRole: 'finance_operator',
        requiredAction:
          'Settle the team obligations, or record the approved participation policy for team balances (POL-017).',
        deadline: first ? new Date(first.due_at).toISOString() : null,
      });
    }
    return findings;
  }

  /**
   * Arrival standing (SPK-ENTRY-004): the same answer as FINANCIAL_STANDING_IMPL (FIN-03), for
   * callers that resolve this service directly.
   */
  async standingOf(
    organizationId: string,
    personId: string,
    context: { offeringId: string | null; at: Date },
    trx?: Trx,
  ): Promise<ParticipationStanding> {
    return this.standing.standingOf(organizationId, personId, context, trx);
  }
}
