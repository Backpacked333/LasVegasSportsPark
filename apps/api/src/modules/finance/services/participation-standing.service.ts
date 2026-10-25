import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, executorFor, type Trx } from '../../../kernel';
import type {
  ConditionFinding,
  FinancialConditionsPort,
  FixtureConditionContext,
} from '../../competition';

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
 * - Arrival standing (SPK-ENTRY-004), consumed by entry: due, open obligations of the participant,
 *   `related` when one belongs to the activity's offering (an order line of the participant). Entry
 *   decides what an unrelated balance does (informational by default, DEC-056).
 */
@Injectable()
export class ParticipationStandingService implements FinancialConditionsPort {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

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

  async standingOf(
    organizationId: string,
    personId: string,
    context: { offeringId: string | null; at: Date },
    trx?: Trx,
  ): Promise<ParticipationStanding> {
    const db = trx ?? executorFor(this.db);
    const due = await db
      .selectFrom('obligations')
      .select(['id', 'order_id', 'amount_minor', 'allocated_minor', 'currency'])
      .where('organization_id', '=', organizationId)
      .where('debtor_kind', '=', 'person')
      .where('debtor_person_id', '=', personId)
      .where('status', '=', 'open')
      .where('due_at', '<=', context.at)
      .orderBy('due_at')
      .orderBy('id')
      .execute();
    if (due.length === 0) return { status: 'clear' };
    let relatedIds = new Set<string>();
    const orderIds = [...new Set(due.map((o) => o.order_id).filter((id): id is string => !!id))];
    if (context.offeringId && orderIds.length > 0) {
      const lines = await db
        .selectFrom('order_lines')
        .select('order_id')
        .where('organization_id', '=', organizationId)
        .where('order_id', 'in', orderIds)
        .where('participant_person_id', '=', personId)
        .where('offering_id', '=', context.offeringId)
        .execute();
      const relatedOrders = new Set(lines.map((l) => l.order_id));
      relatedIds = new Set(
        due.filter((o) => o.order_id && relatedOrders.has(o.order_id)).map((o) => o.id),
      );
    }
    const related = relatedIds.size > 0;
    const counted = related ? due.filter((o) => relatedIds.has(o.id)) : due;
    const currency = (counted[0] as (typeof due)[number]).currency;
    const amountMinor = counted
      .filter((o) => o.currency === currency)
      .reduce((sum, o) => sum + Number(o.amount_minor) - Number(o.allocated_minor), 0);
    return {
      status: 'outstanding',
      related,
      amountMinor,
      currency,
      reference: (counted[0] as (typeof due)[number]).id,
    };
  }
}
