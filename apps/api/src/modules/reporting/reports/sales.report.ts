import { Injectable } from '@nestjs/common';
import type { MetricValue, ReportRow } from '@sportspark/contracts';
import { column, type ReportContext, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import { REPORTING_SETTING_NAMES } from '../reporting.settings';
import { localDays, metricValue } from '../reporting.shared';

type Source = 'registration' | 'point_of_sale' | 'point_of_sale_open_amount';

interface LineTotals {
  source: Source;
  productLine: string;
  /** SPK-PAY-016: the revenue category of an open-amount reason category; null otherwise. */
  revenueCategory: string | null;
  currency: string;
  lines: number;
  salesMinor: number;
  adjustmentsMinor: number;
}

/** The product kind finance gives an open-amount line (migration 0695); never a product line. */
const OPEN_AMOUNT_KIND = 'open_amount';

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
 *
 * SPK-PAY-016 (proposed amendment PA-08, DEC-102 pending): open-amount register lines are not
 * products. Each is listed apart as its own row (source `point_of_sale_open_amount`, views of
 * migration 1310) with its description, its reason category, the revenue category it books to
 * and whether a second approval was needed, so it can be reviewed; the metric values add them up
 * by reason category.
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
    const entry = (
      source: Source,
      productLine: string,
      currency: string,
      revenueCategory: string | null = null,
    ) => {
      const key = `${source}|${productLine}|${revenueCategory ?? ''}|${currency}`;
      let t = totals.get(key);
      if (!t) {
        t = {
          source,
          productLine,
          revenueCategory,
          currency,
          lines: 0,
          salesMinor: 0,
          adjustmentsMinor: 0,
        };
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
      .where('product_kind', '<>', OPEN_AMOUNT_KIND)
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
      .where('product_kind', '<>', OPEN_AMOUNT_KIND)
      .where('returned_at', '>=', spanStart)
      .where('returned_at', '<', spanEnd)
      .where('returned_at', '<=', ctx.asOf)
      .execute();
    for (const r of posReturns) {
      entry('point_of_sale', r.product_kind, r.currency).adjustmentsMinor += Number(r.amount_minor);
    }

    // SPK-PAY-016 (proposed): open-amount lines apart, under their reason and revenue category.
    const openLines = await ctx.db
      .selectFrom('reporting_pos_open_amount_lines_v')
      .select([
        'sale_line_id',
        'sale_number',
        'reason_category',
        'revenue_category',
        'description',
        'currency',
        'line_total_minor',
        'approved',
        'awaiting_approval',
      ])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('paid_at', '>=', spanStart)
      .where('paid_at', '<', spanEnd)
      .where('paid_at', '<=', ctx.asOf)
      .orderBy('paid_at')
      .orderBy('sale_line_id')
      .execute();
    for (const l of openLines) {
      const t = entry(
        'point_of_sale_open_amount',
        l.reason_category,
        l.currency,
        l.revenue_category,
      );
      t.lines += 1;
      t.salesMinor += Number(l.line_total_minor);
    }
    const openReturns = await ctx.db
      .selectFrom('reporting_pos_open_amount_return_lines_v')
      .select(['sale_line_id', 'reason_category', 'revenue_category', 'currency', 'amount_minor'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('returned_at', '>=', spanStart)
      .where('returned_at', '<', spanEnd)
      .where('returned_at', '<=', ctx.asOf)
      .execute();
    const returnedOfLine = new Map<string, number>();
    for (const r of openReturns) {
      entry(
        'point_of_sale_open_amount',
        r.reason_category,
        r.currency,
        r.revenue_category,
      ).adjustmentsMinor += Number(r.amount_minor);
      returnedOfLine.set(
        r.sale_line_id,
        (returnedOfLine.get(r.sale_line_id) ?? 0) + Number(r.amount_minor),
      );
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
          dimensions: {
            source: t.source,
            productLine: t.productLine,
            ...(t.revenueCategory ? { revenueCategory: t.revenueCategory } : {}),
          },
        }),
      );
      if (t.source !== 'registration' && t.adjustmentsMinor !== 0) {
        values.push(
          metricValue('MET-110', `Returns: ${t.productLine}`, 'minor_units', t.adjustmentsMinor, {
            currency: t.currency,
            dimensions: {
              source: t.source,
              productLine: t.productLine,
              ...(t.revenueCategory ? { revenueCategory: t.revenueCategory } : {}),
            },
          }),
        );
      }
    }
    const share = (salesMinor: number, currency: string) => {
      const all = salesByCurrency.get(currency) ?? 0;
      return all > 0 ? Math.round((salesMinor / all) * 10_000) / 10_000 : null;
    };
    const rows: ReportRow[] = ordered
      .filter((t) => t.source !== 'point_of_sale_open_amount')
      .map((t) => ({
        source: t.source,
        productLine: t.productLine,
        revenueCategory: null,
        description: null,
        saleNumber: null,
        secondApproval: null,
        currency: t.currency,
        lines: t.lines,
        salesMinor: t.salesMinor,
        returnsMinor: t.source === 'point_of_sale' ? t.adjustmentsMinor : null,
        shareOfSales: share(t.salesMinor, t.currency),
      }));
    // SPK-PAY-016 (proposed): each open-amount line is its own row, after the product lines, with
    // what was typed, the categories and whether a second approval was needed.
    for (const l of openLines) {
      rows.push({
        source: 'point_of_sale_open_amount',
        productLine: l.reason_category,
        revenueCategory: l.revenue_category,
        description: l.description,
        saleNumber: l.sale_number,
        // Three plain states (1311): a line that needed an approval when it was entered may no
        // longer need one once other lines of its enterer were removed (SPK-PAY-016).
        secondApproval: l.approved
          ? 'approved'
          : l.awaiting_approval
            ? 'awaiting approval'
            : 'not needed',
        currency: l.currency,
        lines: 1,
        salesMinor: Number(l.line_total_minor),
        returnsMinor: returnedOfLine.get(l.sale_line_id) ?? 0,
        shareOfSales: share(Number(l.line_total_minor), l.currency),
      });
    }
    return {
      scope: { from: params.from, to: params.to },
      values,
      columns: [
        column('source', 'Sold through'),
        column('productLine', 'Product line or open-amount reason category'),
        column('revenueCategory', 'Revenue category (open amounts)'),
        column('description', 'Description (open amounts)'),
        column('saleNumber', 'Sale (open amounts)'),
        column('secondApproval', 'Second approval (open amounts)'),
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
        'Open-amount register lines (proposed, SPK-PAY-016; DEC-102 pending) are not products: each is listed apart as its own row, with its description, its reason category, the revenue category it books to and whether a second approval was needed; MET-109 and MET-110 add them up by reason category under their own source.',
        'Point-of-sale returns are adjustments shown beside the sales, never netted. Registration refunds are not split by product line here: see the payment reconciliation report.',
        `Facility-local operating days in ${tz} (DEC-001 operating day start).`,
      ],
    };
  }
}
