import { Injectable } from '@nestjs/common';
import { allocate, errors, money, type MetricValue, type ReportRow } from '@sportspark/contracts';
import { sql } from 'kysely';
import {
  allocateSales,
  perHour,
  type OfferingEvent,
  type SaleLine,
} from '../calculators/allocation';
import { column, type ReportContext, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import { REPORTING_SETTING_NAMES } from '../reporting.settings';
import {
  HOUR_MS,
  hours,
  operatingDateOf,
  localDays,
  metricValue,
  ratio,
} from '../reporting.shared';

interface CostRow {
  resource_id: string | null;
  amount_minor: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
}

/** Agreed cost input in force for a space on a local date (a space's own input wins, E4). */
export function costInputFor(
  inputs: readonly CostRow[],
  resourceId: string,
  date: string,
  currency: string,
): CostRow | null {
  const covers = (c: CostRow) =>
    c.currency === currency &&
    c.effective_from <= date &&
    (c.effective_to === null || date < c.effective_to);
  return (
    inputs.find((c) => c.resource_id === resourceId && covers(c)) ??
    inputs.find((c) => c.resource_id === null && covers(c)) ??
    null
  );
}

const roundHalfAway = (v: number) => (v < 0 ? -Math.round(Math.abs(v)) : Math.round(v));

/**
 * Economics (SPK-REPORT-004, metric dictionary rules E1 to E5): allocated sales per activity hour,
 * shown only under the allocation method the request names (no default exists, DEC-085), with the
 * method's coverage disclosed; contribution margin only from agreed cost inputs recorded under
 * `reporting.manage_cost_inputs`, refused otherwise — never inferred from collections.
 */
@Injectable()
export class EconomicsReport {
  readonly definition: ReportDefinition<'economics'> = {
    key: 'economics',
    title: 'Field economics',
    requirementIds: ['SPK-REPORT-004'],
    viewAction: ReportingActions.viewFinancialReports,
    exportAction: ReportingActions.exportFinancial,
    scope: 'facility',
    pointInTime: 'partial',
    pointInTimeNote:
      'Orders fulfilled after the as-of instant and reservations released by then are excluded, and cost inputs are those in force at the as-of instant (recorded by then and not yet withdrawn); session schedules are taken as they stand now. The stored run is the reproducible record.',
    settings: [REPORTING_SETTING_NAMES.operatingDayStart],
    compute: async (ctx, params) => this.compute(ctx, params),
  };

  private async compute(
    ctx: ReportContext,
    params: {
      from: string;
      to: string;
      allocationMethod: 'direct' | 'pro_rata';
      includeMargin?: boolean;
    },
  ) {
    const facility = ctx.facility!;
    const tz = facility.timezone;
    const days = localDays(tz, params.from, params.to, ctx.policy.maxPeriodDays, ctx.dayStart);
    const spanStart = new Date(days[0]!.start);
    const spanEnd = new Date(days[days.length - 1]!.end);
    const method = params.allocationMethod;
    const inPeriod = (date: string) => date >= params.from && date <= params.to;

    // Offerings with sessions in the period, plus lines fulfilled in the period.
    const periodSessions = await ctx.db
      .selectFrom('reporting_sessions_v')
      .select(['offering_id'])
      .distinct()
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('scheduled_start', '>=', spanStart)
      .where('scheduled_start', '<', spanEnd)
      .where('status', '<>', 'canceled')
      .execute();
    const offeringIds = periodSessions.map((s) => s.offering_id);
    const lineRows = await ctx.db
      .selectFrom('reporting_order_lines_v')
      .select([
        'order_line_id',
        'order_id',
        'offering_id',
        'offering_kind',
        'total_minor',
        'currency',
        'fulfilled_at',
      ])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('fulfillment_status', '=', 'fulfilled')
      .where('fulfilled_at', '<=', ctx.asOf)
      .where((eb) =>
        eb.or([
          eb.and([eb('fulfilled_at', '>=', spanStart), eb('fulfilled_at', '<', spanEnd)]),
          ...(offeringIds.length > 0 ? [eb('offering_id', 'in', offeringIds)] : []),
        ]),
      )
      .orderBy('order_line_id')
      .execute();
    const lines: SaleLine[] = lineRows.map((l) => ({
      lineId: l.order_line_id,
      offeringId: l.offering_id,
      offeringKind: l.offering_kind,
      totalMinor: l.total_minor,
      currency: l.currency,
      fulfilledOn: operatingDateOf(tz, l.fulfilled_at as Date, ctx.dayStart),
    }));

    // Every live session event of those offerings (pro-rata spreads over the whole offering).
    const lineOfferings = [...new Set(lines.map((l) => l.offeringId))];
    const sessionEvents =
      lineOfferings.length === 0
        ? []
        : await ctx.db
            .selectFrom('reporting_sessions_v as s')
            .innerJoin('reporting_events_v as e', (j) =>
              j
                .onRef('e.organization_id', '=', 's.organization_id')
                .onRef('e.event_id', '=', 's.scheduling_event_id'),
            )
            .select(['s.offering_id', 'e.event_id', 'e.scheduled_start', 'e.scheduled_end'])
            .where('s.organization_id', '=', ctx.organizationId)
            .where('s.offering_id', 'in', lineOfferings)
            .where('s.status', '<>', 'canceled')
            .where('e.status', '=', 'published')
            .execute();
    const eventIds = [...new Set(sessionEvents.map((e) => e.event_id))];
    const units =
      eventIds.length === 0
        ? []
        : await ctx.db
            .selectFrom('reporting_reserved_units_v')
            .select(['event_id', 'resource_id', 'conflict_unit_id', 'released_at'])
            .where('organization_id', '=', ctx.organizationId)
            .where('event_id', 'in', eventIds)
            .execute();
    const spaceUnits = new Map<string, Set<string>>();
    for (const u of units) {
      if (u.released_at !== null && new Date(u.released_at) <= ctx.asOf) continue;
      const key = `${u.event_id}|${u.resource_id}`;
      const set = spaceUnits.get(key) ?? new Set<string>();
      set.add(u.conflict_unit_id);
      spaceUnits.set(key, set);
    }
    const events: OfferingEvent[] = sessionEvents.map((e) => {
      const durationMs =
        new Date(e.scheduled_end).getTime() - new Date(e.scheduled_start).getTime();
      const spaces = [...spaceUnits.entries()]
        .filter(([key]) => key.startsWith(`${e.event_id}|`))
        .map(([key, set]) => ({
          resourceId: key.split('|')[1]!,
          activityUnitMs: set.size * durationMs,
        }))
        .sort((a, b) => (a.resourceId < b.resourceId ? -1 : 1));
      return {
        offeringId: e.offering_id,
        eventId: e.event_id,
        eventOn: operatingDateOf(tz, e.scheduled_start, ctx.dayStart),
        activityMinutes: Math.round(durationMs / 60_000),
        spaces,
      };
    });

    const allocation = allocateSales(lines, events, method);
    const allocated = allocation.allocated.filter((p) => inPeriod(p.eventOn));
    const unallocated = allocation.unallocated.filter((p) => inPeriod(p.reportedOn));

    const resourceNames = new Map(
      (
        await ctx.db
          .selectFrom('reporting_resource_units_v')
          .select(['resource_id', 'resource_name'])
          .distinct()
          .where('organization_id', '=', ctx.organizationId)
          .where('facility_id', '=', facility.id)
          .execute()
      ).map((r) => [r.resource_id, r.resource_name]),
    );

    // Per space and currency: allocated sales and the activity time of the events that carry them.
    interface SpaceTotals {
      resourceId: string;
      currency: string;
      allocatedMinor: number;
      events: Map<string, { eventOn: string; activityUnitMs: number }>;
    }
    const spaces = new Map<string, SpaceTotals>();
    for (const p of allocated) {
      const key = `${p.resourceId}|${p.currency}`;
      const s = spaces.get(key) ?? {
        resourceId: p.resourceId,
        currency: p.currency,
        allocatedMinor: 0,
        events: new Map(),
      };
      s.allocatedMinor += p.amountMinor;
      s.events.set(p.eventId, { eventOn: p.eventOn, activityUnitMs: p.activityUnitMs });
      spaces.set(key, s);
    }

    let costs: CostRow[] = [];
    if (params.includeMargin) {
      // The inputs in force at the as-of instant (G3, SPK-REPORT-007): a correction withdraws an
      // input and records another, so an earlier run still reproduces from the inputs of its time.
      // Active inputs never overlap, so neither do the inputs in force at one instant.
      costs = await ctx.db
        .selectFrom('cost_inputs')
        .select([
          'resource_id',
          'amount_minor',
          'currency',
          sql<string>`effective_from::text`.as('effective_from'),
          sql<string | null>`effective_to::text`.as('effective_to'),
        ])
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('basis', '=', 'per_activity_hour')
        .where('recorded_at', '<=', ctx.asOf)
        .where((eb) => eb.or([eb('withdrawn_at', 'is', null), eb('withdrawn_at', '>', ctx.asOf)]))
        .orderBy('recorded_at')
        .orderBy('id')
        .execute();
      const missing: Array<{ resourceId: string; date: string; currency: string }> = [];
      for (const s of spaces.values()) {
        for (const e of s.events.values()) {
          if (!costInputFor(costs, s.resourceId, e.eventOn, s.currency)) {
            missing.push({ resourceId: s.resourceId, date: e.eventOn, currency: s.currency });
          }
        }
      }
      if (missing.length > 0 || costs.length === 0) {
        throw errors.validation(
          'Contribution margin requires agreed cost inputs for every space and event day; it is never inferred from collections (SPK-REPORT-004).',
          { code: 'cost_inputs_required', missing },
        );
      }
    }

    const rows: ReportRow[] = [];
    const totalsByCurrency = new Map<
      string,
      { allocated: number; unallocated: number; ms: number; cost: number }
    >();
    const totals = (c: string) => {
      const t = totalsByCurrency.get(c) ?? { allocated: 0, unallocated: 0, ms: 0, cost: 0 };
      totalsByCurrency.set(c, t);
      return t;
    };
    for (const s of [...spaces.values()].sort((a, b) =>
      a.resourceId < b.resourceId
        ? -1
        : a.resourceId > b.resourceId
          ? 1
          : a.currency < b.currency
            ? -1
            : 1,
    )) {
      const ms = [...s.events.values()].reduce((sum, e) => sum + e.activityUnitMs, 0);
      let cost: number | null = null;
      if (params.includeMargin) {
        cost = 0;
        for (const e of s.events.values()) {
          const input = costInputFor(costs, s.resourceId, e.eventOn, s.currency)!;
          cost += roundHalfAway((input.amount_minor * e.activityUnitMs) / HOUR_MS);
        }
      }
      const t = totals(s.currency);
      t.allocated += s.allocatedMinor;
      t.ms += ms;
      t.cost += cost ?? 0;
      rows.push({
        section: 'space',
        resourceId: s.resourceId,
        resource: resourceNames.get(s.resourceId) ?? null,
        currency: s.currency,
        reason: null,
        amountMinor: s.allocatedMinor,
        activityHours: hours(ms),
        perActivityHourMinor: perHour(s.allocatedMinor, ms),
        events: s.events.size,
        costMinor: cost,
        contributionMinor: cost === null ? null : s.allocatedMinor - cost,
        contributionPerActivityHourMinor:
          cost === null ? null : perHour(s.allocatedMinor - cost, ms),
      });
    }
    const unallocatedGroups = new Map<string, number>();
    for (const u of unallocated) {
      const key = `${u.currency}|${u.reason}`;
      unallocatedGroups.set(key, (unallocatedGroups.get(key) ?? 0) + u.amountMinor);
      totals(u.currency).unallocated += u.amountMinor;
    }
    for (const [key, amount] of [...unallocatedGroups.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const [currency, reason] = key.split('|');
      rows.push({
        section: 'unallocated',
        resourceId: null,
        resource: null,
        currency: currency ?? null,
        reason: reason ?? null,
        amountMinor: amount,
        activityHours: null,
        perActivityHourMinor: null,
        events: null,
        costMinor: null,
        contributionMinor: null,
        contributionPerActivityHourMinor: null,
      });
    }

    // Refunds of the included sales are adjustments shown beside them, never netted (E2). A refund
    // is of a payment, which pays a whole order: each is split over its order's lines by their
    // totals (largest remainder), and only the shares of the lines reported here count — another
    // facility's line is neither this facility's adjustment nor visible in its scope (G2).
    const orderIds = [...new Set(lineRows.map((l) => l.order_id))];
    const includedLineIds = new Set(lineRows.map((l) => l.order_line_id));
    const refunds =
      orderIds.length === 0
        ? []
        : await ctx.db
            .selectFrom('reporting_refund_attempts_v')
            .select(['refund_attempt_id', 'order_id', 'currency', 'amount_minor'])
            .where('organization_id', '=', ctx.organizationId)
            .where('order_id', 'in', orderIds)
            .where('status', '=', 'succeeded')
            .where('resolved_at', '>=', spanStart)
            .where('resolved_at', '<', spanEnd)
            .where('resolved_at', '<=', ctx.asOf)
            .orderBy('refund_attempt_id')
            .execute();
    const linesOfOrder = new Map<string, Array<{ id: string; totalMinor: number }>>();
    if (refunds.length > 0) {
      const orderLines = await ctx.db
        .selectFrom('reporting_order_lines_v')
        .select(['order_line_id', 'order_id', 'total_minor'])
        .where('organization_id', '=', ctx.organizationId)
        .where('order_id', 'in', [...new Set(refunds.map((r) => r.order_id as string))])
        .orderBy('order_line_id')
        .execute();
      for (const l of orderLines) {
        const list = linesOfOrder.get(l.order_id) ?? [];
        list.push({ id: l.order_line_id, totalMinor: Number(l.total_minor) });
        linesOfOrder.set(l.order_id, list);
      }
    }
    const refundsByCurrency = new Map<string, number>();
    for (const r of refunds) {
      const orderLines = linesOfOrder.get(r.order_id as string) ?? [];
      if (orderLines.reduce((sum, l) => sum + l.totalMinor, 0) <= 0) continue;
      const shares = allocate(
        money(Number(r.amount_minor), r.currency),
        orderLines.map((l) => l.totalMinor),
      );
      const here = orderLines.reduce(
        (sum, l, i) => (includedLineIds.has(l.id) ? sum + shares[i]!.amountMinor : sum),
        0,
      );
      refundsByCurrency.set(r.currency, (refundsByCurrency.get(r.currency) ?? 0) + here);
    }

    const values: MetricValue[] = [];
    for (const [currency, t] of [...totalsByCurrency.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const dims = { allocationMethod: method };
      values.push(
        metricValue(
          'MET-074',
          'Allocated sales per activity hour',
          'minor_units',
          perHour(t.allocated, t.ms),
          {
            currency,
            dimensions: dims,
            unavailableReason: 'no allocated activity hours in the period',
          },
        ),
      );
      values.push(
        metricValue('MET-074', 'Allocated sales', 'minor_units', t.allocated, {
          currency,
          dimensions: dims,
        }),
      );
      values.push(
        metricValue(
          'MET-067',
          'Activity unit-hours carrying allocated sales',
          'hours',
          hours(t.ms),
          { currency, dimensions: dims },
        ),
      );
      values.push(
        metricValue('MET-075', 'Unallocated sales', 'minor_units', t.unallocated, {
          currency,
          dimensions: dims,
        }),
      );
      values.push(
        metricValue(
          'MET-076',
          'Allocation coverage',
          'ratio',
          ratio(t.allocated, t.allocated + t.unallocated),
          {
            currency,
            dimensions: dims,
            unavailableReason: 'no sales in the period',
          },
        ),
      );
      values.push(
        metricValue(
          'MET-077',
          'Contribution margin per activity hour',
          'minor_units',
          params.includeMargin ? perHour(t.allocated - t.cost, t.ms) : null,
          {
            currency,
            dimensions: dims,
            unavailableReason: params.includeMargin
              ? 'no allocated activity hours in the period'
              : 'not requested (includeMargin); margin needs agreed cost inputs',
          },
        ),
      );
      const refunded = refundsByCurrency.get(currency);
      if (refunded !== undefined) {
        values.push(
          metricValue(
            'MET-074',
            'Refunds of these sales (adjustment, not netted)',
            'minor_units',
            refunded,
            {
              currency,
              dimensions: { adjustment: 'refund' },
            },
          ),
        );
      }
    }
    if (totalsByCurrency.size === 0) {
      values.push(
        metricValue('MET-074', 'Allocated sales per activity hour', 'minor_units', null, {
          dimensions: { allocationMethod: method },
          unavailableReason: 'no fulfilled sales attributable to the period',
        }),
      );
    }

    return {
      scope: { from: params.from, to: params.to },
      values,
      columns: [
        column('section', 'Section'),
        column('resourceId', 'Space', 'id'),
        column('resource', 'Space name'),
        column('currency', 'Currency'),
        column('reason', 'Reason unallocated'),
        column('amountMinor', 'Sales', 'minor_units'),
        column('activityHours', 'Activity unit-hours', 'hours'),
        column('perActivityHourMinor', 'Sales per activity hour', 'minor_units'),
        column('events', 'Events', 'count'),
        column('costMinor', 'Agreed cost', 'minor_units'),
        column('contributionMinor', 'Contribution', 'minor_units'),
        column('contributionPerActivityHourMinor', 'Contribution per activity hour', 'minor_units'),
      ],
      rows,
      disclosures: [
        `Allocation method: ${method} (named by the request; no method is in force by default, DEC-085). ${
          method === 'direct'
            ? 'A line is allocated only when its offering has exactly one scheduled event.'
            : "A line is spread over its offering's scheduled events by activity minutes."
        } Each event's share is spread over its spaces by activity unit-time; every split uses largest-remainder allocation.`,
        'Sales are order lines of fulfilled orders (SPK-PAY-011); receipts, credits, fees and disputes are not sales (rule G6). Refunds are shown as adjustments and never netted; a refund is split over its order’s lines by their totals (largest remainder) and only the share of the lines reported here is shown.',
        'Allocated sales are reported in the period of their event; unallocated sales in the period of their fulfilment. Coverage shows what share of the period’s sales the per-hour figure represents (E3).',
        params.includeMargin
          ? 'Contribution margin uses the agreed cost inputs in force on each event day (a space’s own input before the facility’s).'
          : 'Contribution margin was not requested; it is only ever computed from agreed cost inputs (SPK-REPORT-004).',
      ],
    };
  }
}
