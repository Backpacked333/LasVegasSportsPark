import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, executorFor, type Trx } from '../../../kernel';
import type {
  ConditionFinding,
  FinancialConditionsPort,
  FixtureConditionContext,
  TeamEntryFinancialStatus,
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
 *   an open team balance affects play is pending POL-017 / DEC-056. The finding names the entry
 *   only, never the balance's count, amounts or due date (R3-TRACE-B-01).
 * - Team entry financial status (R2-JOURNEYS-05, SPK-COMP-004): none, clear or outstanding from
 *   the obligations that name the entry as debtor, shown on the team entry workspace.
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

  /**
   * R3-TRACE-B-01 (§4.14 object- and field-level authorization, §4.7 invariant 1, SPK-PAY-004,
   * SPK-CAP-002): readiness is read by everyone who may read the fixture, players and guardians of
   * BOTH teams included, and competition passes this finding through as it is. A team balance's
   * count, amounts and due date go only to viewers finance lets read the team obligation
   * (`finance.read_obligation`; the team entry workspace, R2-JOURNEYS-05), so the finding names
   * which entry has an open balance and nothing about it: no count, no amount, no due date (its
   * deadline is null) and no obligation id. Whether an open team balance affects play is pending
   * (POL-017 / DEC-056), so it stays `unknown`, never a pass and never a block.
   */
  async fixtureConditions(
    organizationId: string,
    context: FixtureConditionContext,
    trx?: Trx,
  ): Promise<ConditionFinding[]> {
    if (context.teamEntryIds.length === 0) return [];
    const open = await (trx ?? executorFor(this.db))
      .selectFrom('obligations')
      .select('debtor_team_entry_id')
      .distinct()
      .where('organization_id', '=', organizationId)
      .where('debtor_kind', '=', 'team_entry')
      .where('debtor_team_entry_id', 'in', context.teamEntryIds)
      .where('status', '=', 'open')
      .execute();
    const withBalance = new Set(open.map((row) => row.debtor_team_entry_id as string));
    // In the fixture's own order (home, then away), whatever order the database returns.
    return context.teamEntryIds
      .filter(
        (teamEntryId, index, all) =>
          withBalance.has(teamEntryId) && all.indexOf(teamEntryId) === index,
      )
      .map((teamEntryId) => ({
        status: 'unknown' as const,
        code: 'team_balance_policy_pending',
        message:
          'This team has an open balance. Whether an open team balance affects play awaits the approved participation policy (POL-017).',
        source: { type: 'team_entry', id: teamEntryId },
        responsibleRole: 'finance_operator',
        requiredAction:
          'The team settles its balance, or the finance operator records the approved participation policy for team balances.',
        deadline: null,
      }));
  }

  /**
   * R2-JOURNEYS-05 (SPK-COMP-004, SPK-CAP-002): the team entry's financial status from the
   * obligations that name it as debtor, leaving out canceled ones. No such obligation is `none`;
   * any open one is `outstanding` with the count of open obligations, the remaining amount per
   * currency in minor units (SPK-PAY-001) and the earliest open due date; otherwise every one is
   * settled or written off and the entry is `clear`.
   */
  async entryFinancialStatus(
    organizationId: string,
    teamEntryId: string,
    trx?: Trx,
  ): Promise<TeamEntryFinancialStatus> {
    const rows = await (trx ?? executorFor(this.db))
      .selectFrom('obligations')
      .select(['status', 'amount_minor', 'allocated_minor', 'currency', 'due_at'])
      .where('organization_id', '=', organizationId)
      .where('debtor_kind', '=', 'team_entry')
      .where('debtor_team_entry_id', '=', teamEntryId)
      .where('status', '<>', 'canceled')
      .orderBy('due_at')
      .orderBy('id')
      .execute();
    if (rows.length === 0) return { status: 'none' };
    const open = rows.filter((r) => r.status === 'open');
    if (open.length === 0) return { status: 'clear' };
    const totals = new Map<string, number>();
    for (const row of open) {
      const remaining = Number(row.amount_minor) - Number(row.allocated_minor);
      totals.set(row.currency, (totals.get(row.currency) ?? 0) + remaining);
    }
    return {
      status: 'outstanding',
      openObligations: open.length,
      outstanding: [...totals]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amountMinor]) => ({ amountMinor, currency })),
      nextDueAt: new Date(open[0]!.due_at).toISOString(),
    };
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
