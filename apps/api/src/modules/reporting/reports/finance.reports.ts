import { Injectable } from '@nestjs/common';
import type { MetricValue, ReportRow } from '@sportspark/contracts';
import { column, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import { REPORTING_SETTING_NAMES } from '../reporting.settings';
import { DAY_MS, iso, metricValue } from '../reporting.shared';

const LIVE_NOTE =
  'Evaluated live from the finance subledger at the request instant; a past as-of instant cannot be reconstructed. The stored report run is the reproducible record.';

/**
 * Aging band of a due instant at the as-of instant. `upperBounds` are the configured upper bounds
 * in days past due (REPORTING_AGING_BANDS_DAYS, DEC-007), the last band open-ended; without
 * configured bands every balance is `unbanded` (REP-03: no invented policy value).
 */
export function agingBand(dueAt: Date, asOf: Date, upperBounds: readonly number[] | null): string {
  if (upperBounds === null || upperBounds.length === 0) return 'unbanded';
  if (dueAt.getTime() > asOf.getTime()) return 'not_due';
  const daysPast = Math.floor((asOf.getTime() - dueAt.getTime()) / DAY_MS);
  let lower = 0;
  for (const upper of upperBounds) {
    if (daysPast <= upper) return `${lower}-${upper}`;
    lower = upper + 1;
  }
  return `over_${upperBounds[upperBounds.length - 1]!}`;
}

function sumByCurrency<T>(
  items: readonly T[],
  currency: (t: T) => string,
  amount: (t: T) => number,
) {
  const out = new Map<string, { count: number; amount: number }>();
  for (const item of items) {
    const c = currency(item);
    const entry = out.get(c) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += amount(item);
    out.set(c, entry);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * R09 outstanding obligations and R10 payment and refund reconciliation (SPK-REPORT-002), read
 * through the finance views of migration 1300. Money is integer minor units with its currency and
 * is never summed across currencies (SPK-PAY-001, G5); receipts are never presented as sales (G6).
 */
@Injectable()
export class FinanceReports {
  readonly outstandingObligations: ReportDefinition<'outstanding_obligations'> = {
    key: 'outstanding_obligations',
    title: 'Outstanding obligations',
    requirementIds: ['SPK-REPORT-002', 'SPK-PAY-004', 'SPK-PAY-006', 'SPK-PAY-009', 'SPK-PAY-010'],
    viewAction: ReportingActions.viewFinancialReports,
    exportAction: ReportingActions.exportFinancial,
    scope: 'organization',
    pointInTime: 'none',
    pointInTimeNote: LIVE_NOTE,
    settings: [REPORTING_SETTING_NAMES.agingBands],
    compute: async (ctx) => {
      const obligations = await ctx.db
        .selectFrom('reporting_obligations_v')
        .select(['mode', 'amount_minor', 'allocated_minor', 'currency', 'due_at'])
        .where('organization_id', '=', ctx.organizationId)
        .where('status', '=', 'open')
        .execute();
      const groups = new Map<string, { count: number; amount: number; remaining: number }>();
      const remainingByCurrency = new Map<string, { count: number; remaining: number }>();
      for (const o of obligations) {
        const remaining = o.amount_minor - o.allocated_minor;
        if (remaining <= 0) continue;
        const band = agingBand(new Date(o.due_at), ctx.asOf, ctx.policy.agingBandDays);
        const key = JSON.stringify([o.currency, o.mode, band]);
        const g = groups.get(key) ?? { count: 0, amount: 0, remaining: 0 };
        g.count += 1;
        g.amount += o.amount_minor;
        g.remaining += remaining;
        groups.set(key, g);
        const c = remainingByCurrency.get(o.currency) ?? { count: 0, remaining: 0 };
        c.count += 1;
        c.remaining += remaining;
        remainingByCurrency.set(o.currency, c);
      }
      const installments = await ctx.db
        .selectFrom('reporting_installments_v')
        .select(['amount_minor', 'currency'])
        .where('organization_id', '=', ctx.organizationId)
        .where('status', 'in', ['scheduled', 'failed'])
        .where('due_at', '<', ctx.asOf)
        .execute();
      const credits = await ctx.db
        .selectFrom('reporting_credits_v')
        .select(['remaining_minor', 'currency'])
        .where('organization_id', '=', ctx.organizationId)
        .where('status', '=', 'active')
        .where('remaining_minor', '>', 0)
        .execute();

      const values: MetricValue[] = [];
      for (const [currency, c] of [...remainingByCurrency.entries()].sort(([a], [b]) =>
        a < b ? -1 : 1,
      )) {
        values.push(
          metricValue('MET-039', 'Outstanding balance', 'minor_units', c.remaining, { currency }),
        );
        values.push(
          metricValue('MET-039', 'Open obligations with a balance', 'count', c.count, { currency }),
        );
      }
      if (remainingByCurrency.size === 0) {
        values.push(metricValue('MET-039', 'Open obligations with a balance', 'count', 0));
      }
      for (const [currency, c] of sumByCurrency(
        installments,
        (i) => i.currency,
        (i) => i.amount_minor,
      )) {
        values.push(
          metricValue('MET-040', 'Overdue installments', 'minor_units', c.amount, { currency }),
        );
        values.push(
          metricValue('MET-040', 'Overdue installment count', 'count', c.count, { currency }),
        );
      }
      if (installments.length === 0)
        values.push(metricValue('MET-040', 'Overdue installment count', 'count', 0));
      for (const [currency, c] of sumByCurrency(
        credits,
        (i) => i.currency,
        (i) => i.remaining_minor,
      )) {
        values.push(
          metricValue('MET-043', 'Credits outstanding', 'minor_units', c.amount, { currency }),
        );
      }
      const rows: ReportRow[] = [...groups.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, g]) => {
          const [currency, mode, band] = JSON.parse(key) as string[];
          return {
            currency: currency ?? null,
            mode: mode ?? null,
            agingBand: band ?? null,
            obligations: g.count,
            amountMinor: g.amount,
            remainingMinor: g.remaining,
          };
        });
      return {
        scope: { from: null, to: null },
        values,
        columns: [
          column('currency', 'Currency'),
          column('mode', 'Obligation mode'),
          column('agingBand', 'Aging band (days past due)'),
          column('obligations', 'Obligations', 'count'),
          column('amountMinor', 'Amount', 'minor_units'),
          column('remainingMinor', 'Remaining', 'minor_units'),
        ],
        rows,
        disclosures: [
          ctx.policy.agingBandDays === null
            ? 'No aging bands are configured (REPORTING_AGING_BANDS_DAYS, DEC-007): balances are unbanded totals per currency and obligation mode.'
            : `Aging bands at ${ctx.policy.agingBandDays.join(', ')} days past due, the last open-ended (REPORTING_AGING_BANDS_DAYS, DEC-007).`,
          'Totals are per currency and never converted or combined (SPK-PAY-001).',
          'Contribution requests are not receipts and do not reduce a balance (SPK-PAY-004).',
        ],
      };
    },
  };

  readonly paymentReconciliation: ReportDefinition<'payment_reconciliation'> = {
    key: 'payment_reconciliation',
    title: 'Payment and refund reconciliation',
    requirementIds: ['SPK-REPORT-002', 'SPK-PAY-007', 'SPK-PAY-008', 'SPK-PAY-011'],
    viewAction: ReportingActions.viewFinancialReports,
    exportAction: ReportingActions.exportFinancial,
    scope: 'organization',
    pointInTime: 'none',
    pointInTimeNote: LIVE_NOTE,
    compute: async (ctx, params) => {
      const start = new Date(params.periodStart);
      const end = new Date(params.periodEnd);
      const org = ctx.organizationId;
      const payments = await ctx.db
        .selectFrom('reporting_payment_attempts_v')
        .select(['status', 'currency', 'provider', 'amount_minor'])
        .where('organization_id', '=', org)
        .where('submitted_at', '>=', start)
        .where('submitted_at', '<', end)
        .execute();
      // MET-045: an attempt never submitted has no submission instant to place it in the period,
      // so these are counted over all time at the request instant, by state, and labelled so.
      const notSubmitted = await ctx.db
        .selectFrom('reporting_payment_attempts_v')
        .select(['status', 'currency', 'amount_minor'])
        .where('organization_id', '=', org)
        .where('submitted_at', 'is', null)
        .execute();
      const unknown = await ctx.db
        .selectFrom('reporting_payment_attempts_v')
        .select(['currency', 'amount_minor', 'unknown_since'])
        .where('organization_id', '=', org)
        .where('status', '=', 'unknown')
        .execute();
      const refunds = await ctx.db
        .selectFrom('reporting_refund_attempts_v')
        .select(['status', 'currency', 'purpose', 'amount_minor'])
        .where('organization_id', '=', org)
        .where('submitted_at', '>=', start)
        .where('submitted_at', '<', end)
        .execute();
      const reserved = await ctx.db
        .selectFrom('reporting_refund_attempts_v')
        .select(['currency', 'amount_minor'])
        .where('organization_id', '=', org)
        .where('status', 'in', ['requested', 'processing', 'unknown'])
        .where('reservation_status', '=', 'reserved')
        .execute();
      const settlements = await ctx.db
        .selectFrom('reporting_settlements_v')
        .select(['kind', 'provider', 'currency', 'difference_minor', 'status'])
        .where('organization_id', '=', org)
        .where('performed_at', '>=', start)
        .where('performed_at', '<', end)
        .execute();
      const receipts = await ctx.db
        .selectFrom('reporting_receipts_v')
        .select(['currency', 'amount_minor'])
        .where('organization_id', '=', org)
        .where('received_at', '>=', start)
        .where('received_at', '<', end)
        .execute();
      const sales = await ctx.db
        .selectFrom('reporting_order_lines_v')
        .select(['currency', 'total_minor'])
        .where('organization_id', '=', org)
        .where('fulfillment_status', '=', 'fulfilled')
        .where('fulfilled_at', '>=', start)
        .where('fulfilled_at', '<', end)
        .execute();

      const rows: ReportRow[] = [];
      const grouped = <T>(
        section: string,
        items: readonly T[],
        key: (t: T) => [string, string, string],
        amount: (t: T) => number,
      ) => {
        const map = new Map<string, { count: number; amount: number }>();
        for (const item of items) {
          const k = JSON.stringify(key(item));
          const g = map.get(k) ?? { count: 0, amount: 0 };
          g.count += 1;
          g.amount += amount(item);
          map.set(k, g);
        }
        for (const [k, g] of [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
          const [state, currency, detail] = JSON.parse(k) as string[];
          rows.push({
            section,
            state: state ?? null,
            currency: currency ?? null,
            detail: detail ?? null,
            count: g.count,
            amountMinor: g.amount,
          });
        }
      };
      grouped(
        'payment_attempts',
        payments,
        (p) => [p.status, p.currency, p.provider],
        (p) => p.amount_minor,
      );
      grouped(
        'payment_attempts_never_submitted',
        notSubmitted,
        (p) => [p.status, p.currency, 'all time, at the request instant'],
        (p) => p.amount_minor,
      );
      grouped(
        'refund_attempts',
        refunds,
        (r) => [r.status, r.currency, r.purpose],
        (r) => r.amount_minor,
      );
      grouped(
        'settlements',
        settlements,
        (s) => [s.status, s.currency, `${s.kind}${s.provider ? `:${s.provider}` : ''}`],
        (s) => s.difference_minor,
      );

      const values: MetricValue[] = [];
      for (const [currency, c] of sumByCurrency(
        payments,
        (p) => p.currency,
        (p) => p.amount_minor,
      )) {
        values.push(
          metricValue('MET-045', 'Payment attempts submitted', 'minor_units', c.amount, {
            currency,
          }),
        );
        values.push(
          metricValue('MET-045', 'Payment attempts submitted (count)', 'count', c.count, {
            currency,
          }),
        );
      }
      for (const [currency, c] of sumByCurrency(
        payments.filter((p) => p.status === 'succeeded'),
        (p) => p.currency,
        (p) => p.amount_minor,
      )) {
        values.push(
          metricValue('MET-045', 'Succeeded payment attempts', 'minor_units', c.amount, {
            currency,
            dimensions: { state: 'succeeded' },
          }),
        );
      }
      values.push(
        metricValue(
          'MET-045',
          'Attempts never submitted to a provider (all time, at the request instant)',
          'count',
          notSubmitted.length,
          { dimensions: { window: 'all_time' } },
        ),
      );
      values.push(metricValue('MET-046', 'Unknown payment outcomes', 'count', unknown.length));
      const oldest = unknown
        .map((u) =>
          u.unknown_since ? ctx.asOf.getTime() - new Date(u.unknown_since).getTime() : 0,
        )
        .reduce((a, b) => Math.max(a, b), 0);
      values.push(
        metricValue(
          'MET-046',
          'Oldest unknown outcome (minutes)',
          'minutes',
          unknown.length ? Math.floor(oldest / 60_000) : null,
          {
            unavailableReason: 'no unknown payment outcome',
          },
        ),
      );
      for (const [currency, c] of sumByCurrency(
        unknown,
        (u) => u.currency,
        (u) => u.amount_minor,
      )) {
        values.push(
          metricValue('MET-046', 'Unknown payment amount', 'minor_units', c.amount, { currency }),
        );
      }
      for (const [currency, c] of sumByCurrency(
        refunds,
        (r) => r.currency,
        (r) => r.amount_minor,
      )) {
        values.push(
          metricValue('MET-047', 'Refund attempts submitted', 'minor_units', c.amount, {
            currency,
          }),
        );
      }
      values.push(
        metricValue('MET-047', 'Refund attempts submitted (count)', 'count', refunds.length),
      );
      for (const [currency, c] of sumByCurrency(
        reserved,
        (r) => r.currency,
        (r) => r.amount_minor,
      )) {
        values.push(
          metricValue('MET-048', 'Refund reservations outstanding', 'minor_units', c.amount, {
            currency,
          }),
        );
      }
      values.push(
        metricValue(
          'MET-049',
          'Reconciliations with a discrepancy',
          'count',
          settlements.filter((s) => s.status === 'discrepancy').length,
        ),
      );
      for (const [currency, c] of sumByCurrency(
        settlements,
        (s) => s.currency,
        (s) => s.difference_minor,
      )) {
        values.push(
          metricValue('MET-049', 'Settlement variance', 'minor_units', c.amount, { currency }),
        );
      }
      for (const [currency, c] of sumByCurrency(
        receipts,
        (r) => r.currency,
        (r) => r.amount_minor,
      )) {
        values.push(
          metricValue('MET-050', 'Customer receipts', 'minor_units', c.amount, {
            currency,
            dimensions: { series: 'receipts' },
          }),
        );
      }
      for (const [currency, c] of sumByCurrency(
        sales,
        (s) => s.currency,
        (s) => s.total_minor,
      )) {
        values.push(
          metricValue(
            'MET-050',
            'Recognised sales (fulfilled order lines)',
            'minor_units',
            c.amount,
            { currency, dimensions: { series: 'sales' } },
          ),
        );
      }
      return {
        scope: { from: iso(start), to: iso(end) },
        values,
        columns: [
          column('section', 'Section'),
          column('state', 'State'),
          column('currency', 'Currency'),
          column('detail', 'Provider, purpose or kind'),
          column('count', 'Count', 'count'),
          column('amountMinor', 'Amount (settlements: difference)', 'minor_units'),
        ],
        rows,
        disclosures: [
          'Receipts and sales are shown side by side and never combined; receipts are not revenue (SPK-PAY-011, rule G6).',
          'An unknown outcome is never resolved by age (SPK-PAY-007).',
          'Payment attempts by state are those submitted to a provider in the period. Attempts never submitted have no submission instant: they are counted over all time at the request instant (section payment_attempts_never_submitted), not as part of the period (MET-045).',
          'Settlement differences are listed per reconciliation and never netted against unrelated discrepancies (§5.5).',
        ],
      };
    },
  };
}
