import { Injectable } from '@nestjs/common';
import type { MetricValue, ReportRow } from '@sportspark/contracts';
import { column, type ReportContext, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import { REPORTING_SETTING_NAMES } from '../reporting.settings';
import { localDays, metricValue } from '../reporting.shared';

interface LineTotals {
  source: 'registration' | 'point_of_sale';
  productLine: string;
  currency: string;
  lines: number;
  salesMinor: number;
  adjustmentsMinor: number;
}

/**
 * Sales by product line (park UI redesign "revenue by product line"; SPK-REPORT-004, SPK-PAY-011
 * "payment volume is not automatically revenue"). Product lines are what the facility sells:
 * registration offerings by offering kind (league, program, camp, rental, party, membership,
 * package…) from fulfilled order lines, and point-of-sale products by product kind (merchandise,
 * concession, service) from the lines in effect of paid sales. Figures are sales as charged (line
 * totals, approved taxes and fees included), per currency; they are not recognized revenue, and
 * point-of-sale returns are shown as adjustments beside the sales, never netted. Registration
 * refunds are not split by product line here (an order's refund is not tied to one line); the
 * payment reconciliation report states them.
 */
@Injectable()
export class SalesReport {
  readonly definition: ReportDefinition<'sales_by_product_line'> = {
    key: 'sales_by_product_line',
    title: 'Sales by product line',
    requirementIds: ['SPK-REPORT-004', 'SPK-PAY-011'],
    viewAction: ReportingActions.viewFinancialReports,
    exportAction: ReportingActions.exportFinancial,
    scope: 'facility',
    pointInTime: 'partial',
    pointInTimeNote:
      'Fulfillment and payment instants after the as-of instant are ignored; a later cancellation of a fulfilled order is current state, so the stored run is the reproducible record.',
    settings: [REPORTING_SETTING_NAMES.operatingDayStart],
    compute: async (ctx, params) => this.compute(ctx, params),
  };

  private async compute(ctx: ReportContext, params: { from: string; to: string }) {
    const facility = ctx.facility!;
    const tz = facility.timezone;
    const days = localDays(tz, params.from, params.to, ctx.policy.maxPeriodDays, ctx.dayStart);
    const spanStart = new Date(days[0]!.start);
    const spanEnd = new Date(Math.min(days[days.length - 1]!.end, ctx.asOf.getTime() + 1));
    const totals = new Map<string, LineTotals>();
    const entry = (source: LineTotals['source'], productLine: string, currency: string) => {
      const key = `${source}|${productLine}|${currency}`;
      let t = totals.get(key);
      if (!t) {
        t = { source, productLine, currency, lines: 0, salesMinor: 0, adjustmentsMinor: 0 };
        totals.set(key, t);
      }
      return t;
    };

    const orderLines = await ctx.db
      .selectFrom('reporting_order_lines_v')
      .select(['offering_kind', 'currency', 'total_minor'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('fulfillment_status', '=', 'fulfilled')
      .where('fulfilled_at', '>=', spanStart)
      .where('fulfilled_at', '<', spanEnd)
      .where('fulfilled_at', '<=', ctx.asOf)
      .execute();
    for (const l of orderLines) {
      const t = entry('registration', l.offering_kind, l.currency);
      t.lines += 1;
      t.salesMinor += Number(l.total_minor);
    }

    const posLines = await ctx.db
      .selectFrom('reporting_pos_sale_lines_v')
      .select(['product_kind', 'currency', 'line_total_minor'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('paid_at', '>=', spanStart)
      .where('paid_at', '<', spanEnd)
      .where('paid_at', '<=', ctx.asOf)
      .execute();
    for (const l of posLines) {
      const t = entry('point_of_sale', l.product_kind, l.currency);
      t.lines += 1;
      t.salesMinor += Number(l.line_total_minor);
    }
    const posReturns = await ctx.db
      .selectFrom('reporting_pos_return_lines_v')
      .select(['product_kind', 'currency', 'amount_minor'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('returned_at', '>=', spanStart)
      .where('returned_at', '<', spanEnd)
      .where('returned_at', '<=', ctx.asOf)
      .execute();
    for (const r of posReturns) {
      entry('point_of_sale', r.product_kind, r.currency).adjustmentsMinor += Number(r.amount_minor);
    }

    const ordered = [...totals.values()].sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) ||
        a.source.localeCompare(b.source) ||
        b.salesMinor - a.salesMinor ||
        a.productLine.localeCompare(b.productLine),
    );
    const salesByCurrency = new Map<string, number>();
    for (const t of ordered) {
      salesByCurrency.set(t.currency, (salesByCurrency.get(t.currency) ?? 0) + t.salesMinor);
    }
    const values: MetricValue[] = [];
    for (const t of ordered) {
      values.push(
        metricValue('MET-109', `Sales: ${t.productLine}`, 'minor_units', t.salesMinor, {
          currency: t.currency,
          dimensions: { source: t.source, productLine: t.productLine },
        }),
      );
      if (t.source === 'point_of_sale' && t.adjustmentsMinor !== 0) {
        values.push(
          metricValue('MET-110', `Returns: ${t.productLine}`, 'minor_units', t.adjustmentsMinor, {
            currency: t.currency,
            dimensions: { source: t.source, productLine: t.productLine },
          }),
        );
      }
    }
    const rows: ReportRow[] = ordered.map((t) => {
      const all = salesByCurrency.get(t.currency) ?? 0;
      return {
        source: t.source,
        productLine: t.productLine,
        currency: t.currency,
        lines: t.lines,
        salesMinor: t.salesMinor,
        returnsMinor: t.source === 'point_of_sale' ? t.adjustmentsMinor : null,
        shareOfSales: all > 0 ? Math.round((t.salesMinor / all) * 10_000) / 10_000 : null,
      };
    });
    return {
      scope: { from: params.from, to: params.to },
      values,
      columns: [
        column('source', 'Sold through'),
        column('productLine', 'Product line'),
        column('currency', 'Currency'),
        column('lines', 'Lines', 'count'),
        column('salesMinor', 'Sales (minor units)', 'minor_units'),
        column('returnsMinor', 'Point-of-sale returns (minor units)', 'minor_units'),
        column('shareOfSales', 'Share of sales in the currency', 'ratio'),
      ],
      rows,
      disclosures: [
        'Sales, not recognized revenue (SPK-PAY-011): registration order lines of fulfilled orders by the instant they were fulfilled, and point-of-sale lines of paid sales by the instant the sale was paid, at their line totals with approved taxes and fees included, as charged.',
        'Product lines are registration offering kinds and point-of-sale product kinds; amounts in different currencies are never added together.',
        'Point-of-sale returns are adjustments shown beside the sales, never netted. Registration refunds are not split by product line here: see the payment reconciliation report.',
        `Facility-local operating days in ${tz} (DEC-001 operating day start).`,
      ],
    };
  }
}
