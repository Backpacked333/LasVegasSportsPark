import { Injectable } from '@nestjs/common';
import type { MetricValue, ReportRow } from '@sportspark/contracts';
import { column, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import { REPORTING_SETTING_NAMES } from '../reporting.settings';
import { DAY_MS, iso, metricValue } from '../reporting.shared';

/** The payment attempt purpose of a point-of-sale card tender (finance migration 0607). */
const POS_SALE = 'pos_sale';

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

/** The scope a reconciliation balances: its provider, or the facility whose cash drawer it counts. */
function settlementScope(s: {
  kind: string;
  provider: string | null;
  facility_id: string | null;
}): string {
  return s.kind === 'cash_drawer'
    ? `cash_drawer:${s.facility_id ?? 'unknown'}`
    : `${s.kind}:${s.provider ?? 'unknown'}`;
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
      // R3-REPORTING-03 (MET-043, SPK-PAY-009): finance never writes an `expired` status; an
      // active credit lapses at its `expires_at` (finance shows it as expired and refuses to redeem
      // it, CREDIT_EXPIRED). A lapsed credit is no outstanding liability: it is reported separately.
      const activeCredits = await ctx.db
        .selectFrom('reporting_credits_v')
        .select(['remaining_minor', 'currency', 'expires_at'])
        .where('organization_id', '=', ctx.organizationId)
        .where('status', '=', 'active')
        .where('remaining_minor', '>', 0)
        .execute();
      const lapsed = (c: (typeof activeCredits)[number]) =>
        c.expires_at !== null && new Date(c.expires_at).getTime() <= ctx.asOf.getTime();
      const credits = activeCredits.filter((c) => !lapsed(c));
      const expiredCredits = activeCredits.filter(lapsed);

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
        values.push(
          metricValue('MET-043', 'Credits outstanding (count)', 'count', c.count, { currency }),
        );
      }
      if (credits.length === 0)
        values.push(metricValue('MET-043', 'Credits outstanding (count)', 'count', 0));
      for (const [currency, c] of sumByCurrency(
        expiredCredits,
        (i) => i.currency,
        (i) => i.remaining_minor,
      )) {
        values.push(
          metricValue('MET-043', 'Expired credits (unredeemed balance)', 'minor_units', c.amount, {
            currency,
            dimensions: { state: 'expired' },
          }),
        );
      }
      values.push(
        metricValue('MET-043', 'Expired credits (count)', 'count', expiredCredits.length, {
          dimensions: { state: 'expired' },
        }),
      );
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
          'Credits outstanding are active credits with a balance that have not expired by the as-of instant; an active credit past its expiry can no longer be redeemed and is reported separately as expired (MET-043, SPK-PAY-009).',
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
        .select(['status', 'currency', 'provider', 'purpose', 'amount_minor'])
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
        .selectFrom('reporting_refund_attempts_v as r')
        .innerJoin('reporting_payment_attempts_v as p', (j) =>
          j
            .onRef('p.organization_id', '=', 'r.organization_id')
            .onRef('p.payment_attempt_id', '=', 'r.payment_attempt_id'),
        )
        .select([
          'r.status',
          'r.reversed_at',
          'r.currency',
          'r.purpose',
          'r.amount_minor',
          'p.purpose as payment_purpose',
        ])
        .where('r.organization_id', '=', org)
        .where('r.submitted_at', '>=', start)
        .where('r.submitted_at', '<', end)
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
        .select([
          'settlement_id',
          'kind',
          'provider',
          'facility_id',
          'period_start',
          'period_end',
          'currency',
          'expected_minor',
          'reported_minor',
          'difference_minor',
          'status',
          'performed_at',
        ])
        .where('organization_id', '=', org)
        .where('performed_at', '>=', start)
        .where('performed_at', '<', end)
        .orderBy('performed_at')
        .orderBy('settlement_id')
        .execute();
      const receipts = await ctx.db
        .selectFrom('reporting_receipts_v')
        .select(['currency', 'amount_minor'])
        .where('organization_id', '=', org)
        .where('received_at', '>=', start)
        .where('received_at', '<', end)
        .execute();
      // R3-REPORTING-04 (SPK-PAY-011, MET-050): point-of-sale money creates no receipt (migration
      // 1305): settled tenders, late card captures and returns, each in its own series. A card
      // return is recorded when its refund is only reserved, so it carries the state of its refund
      // attempt as it stands now (migration 1307): an unknown refund stays unknown (SPK-PAY-007).
      const pos = await ctx.db
        .selectFrom('reporting_pos_money_v as m')
        .leftJoin('reporting_refund_attempts_v as ra', (j) =>
          j
            .onRef('ra.organization_id', '=', 'm.organization_id')
            .onRef('ra.refund_attempt_id', '=', 'm.refund_attempt_id'),
        )
        .select([
          'm.movement',
          'm.tender_kind',
          'm.currency',
          'm.amount_minor',
          'ra.status as refund_status',
          'ra.reversed_at as refund_reversed_at',
        ])
        .where('m.organization_id', '=', org)
        .where('m.occurred_at', '>=', start)
        .where('m.occurred_at', '<', end)
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
        // R4-PROVIDER-OUTCOMES-02: a refund the provider reversed after success returned nothing,
        // so it is its own state, never counted with the succeeded ones.
        (r) => [refundState(r.status, r.reversed_at), r.currency, r.purpose],
        (r) => r.amount_minor,
      );
      // R3-REPORTING-02 (§5.5, MET-049): one row per reconciliation with its own signed
      // difference; differences of different reconciliations are never summed into one figure.
      for (const s of settlements) {
        rows.push({
          section: 'settlements',
          state: s.status,
          currency: s.currency,
          detail: settlementScope(s),
          count: 1,
          amountMinor: Number(s.difference_minor),
          recordId: s.settlement_id,
          periodStart: iso(s.period_start),
          periodEnd: iso(s.period_end),
          expectedMinor: Number(s.expected_minor),
          reportedMinor: Number(s.reported_minor),
        });
      }

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
      for (const [currency, c] of sumByCurrency(
        payments.filter((p) => p.status === 'succeeded' && p.purpose === POS_SALE),
        (p) => p.currency,
        (p) => p.amount_minor,
      )) {
        values.push(
          metricValue(
            'MET-045',
            'Succeeded point-of-sale payment attempts (included above)',
            'minor_units',
            c.amount,
            { currency, dimensions: { state: 'succeeded', purpose: POS_SALE } },
          ),
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
        refunds.filter((r) => r.payment_purpose === POS_SALE),
        (r) => r.currency,
        (r) => r.amount_minor,
      )) {
        values.push(
          metricValue(
            'MET-047',
            'Refund attempts on point-of-sale payments (included above)',
            'minor_units',
            c.amount,
            { currency, dimensions: { paymentPurpose: POS_SALE } },
          ),
        );
      }
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
      // Unnetted totals per currency, kind and scope (a provider, or a facility's cash drawer): a
      // shortage and an overage never cancel out (§5.5).
      const scopes = new Map<
        string,
        { currency: string; kind: string; scope: string; short: number; over: number; n: number }
      >();
      for (const s of settlements) {
        const k = JSON.stringify([s.currency, s.kind, settlementScope(s)]);
        const g = scopes.get(k) ?? {
          currency: s.currency,
          kind: s.kind,
          scope: settlementScope(s),
          short: 0,
          over: 0,
          n: 0,
        };
        const difference = Number(s.difference_minor);
        if (difference < 0) g.short += -difference;
        if (difference > 0) g.over += difference;
        if (s.status === 'discrepancy') g.n += 1;
        scopes.set(k, g);
      }
      for (const [, g] of [...scopes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const options = {
          currency: g.currency,
          dimensions: { kind: g.kind, scope: g.scope },
        };
        values.push(
          metricValue('MET-049', 'Settlement shortages', 'minor_units', g.short, options),
          metricValue('MET-049', 'Settlement overages', 'minor_units', g.over, options),
          metricValue(
            'MET-049',
            'Settlement absolute discrepancy',
            'minor_units',
            g.short + g.over,
            options,
          ),
          metricValue('MET-049', 'Reconciliations with a discrepancy', 'count', g.n, {
            dimensions: options.dimensions,
            currency: g.currency,
          }),
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
      const posSeries = [
        {
          label: 'Point-of-sale card captures',
          series: 'pos_card',
          items: pos.filter(
            (m) =>
              m.movement === 'late_capture' ||
              (m.movement === 'tender' && m.tender_kind === 'card'),
          ),
        },
        {
          label: 'Point-of-sale drawer tenders (cash and external)',
          series: 'pos_drawer',
          items: pos.filter((m) => m.movement === 'tender' && m.tender_kind !== 'card'),
        },
        {
          label: 'Point-of-sale returns recorded',
          series: 'pos_returns',
          items: pos.filter((m) => m.movement === 'return'),
        },
      ];
      for (const { label, series, items } of posSeries) {
        for (const [currency, c] of sumByCurrency(
          items,
          (m) => m.currency,
          (m) => Number(m.amount_minor),
        )) {
          values.push(
            metricValue('MET-050', label, 'minor_units', c.amount, {
              currency,
              dimensions: { series },
            }),
          );
        }
      }
      // R3-REPORTING-04 (SPK-PAY-007, SPK-PAY-008): a returns figure is what was recorded, not
      // what was paid. A cash return is paid from the drawer and an external one recorded with its
      // evidence at the return; a card return is paid back only when its refund attempt succeeds,
      // so card returns are shown by the state of that attempt, never assumed paid.
      for (const [currency, c] of sumByCurrency(
        pos.filter((m) => m.movement === 'return' && m.tender_kind !== 'card'),
        (m) => m.currency,
        (m) => Number(m.amount_minor),
      )) {
        values.push(
          metricValue(
            'MET-050',
            'Point-of-sale cash and external returns, paid at the return (included above)',
            'minor_units',
            c.amount,
            { currency, dimensions: { series: 'pos_returns', tender: 'cash_external' } },
          ),
        );
      }
      const cardReturns = new Map<string, { currency: string; state: string; amount: number }>();
      for (const m of pos) {
        if (m.movement !== 'return' || m.tender_kind !== 'card') continue;
        const state = m.refund_status
          ? refundState(m.refund_status, m.refund_reversed_at)
          : 'unrecorded';
        const k = JSON.stringify([m.currency, state]);
        const g = cardReturns.get(k) ?? { currency: m.currency, state, amount: 0 };
        g.amount += Number(m.amount_minor);
        cardReturns.set(k, g);
      }
      for (const [, g] of [...cardReturns.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        values.push(
          metricValue(
            'MET-050',
            'Point-of-sale card returns by refund state (included above)',
            'minor_units',
            g.amount,
            {
              currency: g.currency,
              dimensions: { series: 'pos_returns', tender: 'card', refundState: g.state },
            },
          ),
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
          column('recordId', 'Reconciliation', 'id'),
          column('periodStart', 'Settlement period start', 'instant'),
          column('periodEnd', 'Settlement period end', 'instant'),
          column('expectedMinor', 'Expected', 'minor_units'),
          column('reportedMinor', 'Reported', 'minor_units'),
        ],
        rows,
        disclosures: [
          'Receipts and sales are shown side by side and never combined; receipts are not revenue (SPK-PAY-011, rule G6).',
          'Point-of-sale money creates no receipt, so it is reported in its own series beside customer receipts and never added to them: card captures (settled card tenders by when they settled, and captures reported after a failed tender by when they were posted), drawer tenders (cash and external) and returns recorded, by when they were recorded (MET-050). A recorded return is not necessarily paid: cash and external returns are paid at the return, while a card return is paid back only when its refund attempt succeeds, so card returns are shown by the current state of that attempt (requested, processing, unknown, succeeded, failed or canceled, or reversed when the provider reported a succeeded refund failed: nothing went back) and an unknown refund stays unknown (SPK-PAY-007). Point-of-sale card payments are payment attempts (purpose pos_sale) shown separately inside MET-045; refunds of them (card returns, and late card captures given back) are refund attempts shown separately inside MET-047. Point-of-sale product sales are not order lines and are not in the sales series.',
          'An unknown outcome is never resolved by age (SPK-PAY-007).',
          'Payment attempts by state are those submitted to a provider in the period. Attempts never submitted have no submission instant: they are counted over all time at the request instant (section payment_attempts_never_submitted), not as part of the period (MET-045).',
          'Settlement differences are listed one row per reconciliation, with its kind and scope (the provider, or the facility of a cash drawer), period, expected and reported amounts. Totals are unnetted per currency, kind and scope: shortages, overages and their absolute sum are separate figures, so a shortage never cancels an overage (§5.5).',
        ],
      };
    },
  };
}

/**
 * R4-PROVIDER-OUTCOMES-02 (§4.11, SPK-PAY-008): the state a refund is reported in. Finance keeps a
 * refund the provider reported failed after success `succeeded` and records `reversed_at`; no money
 * was returned, so it is reported as `reversed`.
 */
function refundState(status: string, reversedAt: Date | string | null): string {
  return status === 'succeeded' && reversedAt !== null ? 'reversed' : status;
}
