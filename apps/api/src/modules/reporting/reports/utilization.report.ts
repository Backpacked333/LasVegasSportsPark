import { Injectable } from '@nestjs/common';
import { errors, type MetricValue, type ReportRow } from '@sportspark/contracts';
import { attended as isAttended, currentHeads, effectiveState } from '../../entry';
import { intersect, type Interval } from '../calculators/intervals';
import {
  computeUtilization,
  type UtilizationClosure,
  type UtilizationDay,
  type UtilizationReservation,
  type UtilizationResource,
} from '../calculators/utilization.calculator';
import { column, type ReportContext, type ReportDefinition } from '../engine/report-definition';
import { addDays } from '../../scheduling';
import { ReportingActions } from '../reporting.actions';
import { REPORTING_SETTING_NAMES } from '../reporting.settings';
import { hours, localDays, localInstant, metricValue, ratio } from '../reporting.shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `resourceId:weight,resourceId:weight` → map; weights must be positive finite numbers. */
export function parseWeights(text: string | undefined): Map<string, number> {
  const weights = new Map<string, number>();
  if (!text) return weights;
  for (const part of text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [id, raw] = part.split(':');
    const weight = Number(raw);
    if (!id || !UUID.test(id) || !Number.isFinite(weight) || weight <= 0) {
      throw errors.validation('Each weight must be `resourceId:positiveNumber`.', { weight: part });
    }
    if (weights.has(id.toLowerCase())) {
      throw errors.validation('A space is weighted twice.', { resourceId: id });
    }
    weights.set(id.toLowerCase(), weight);
  }
  return weights;
}

/**
 * Closed periods of each space from its recorded status changes, in order (SPK-REPORT-003,
 * MET-064). A space is created active, so it is closed from a change to `closed` until the next
 * change to another status, or open-ended when no such change is recorded.
 */
export function closedPeriods(
  changes: ReadonlyArray<{ resourceId: string; status: string; at: number }>,
): Map<string, Interval[]> {
  const periods = new Map<string, Interval[]>();
  const closedSince = new Map<string, number>();
  const push = (resourceId: string, period: Interval) =>
    periods.set(resourceId, [...(periods.get(resourceId) ?? []), period]);
  for (const c of changes) {
    const since = closedSince.get(c.resourceId);
    if (c.status === 'closed') {
      if (since === undefined) closedSince.set(c.resourceId, c.at);
    } else if (since !== undefined) {
      push(c.resourceId, [since, c.at]);
      closedSince.delete(c.resourceId);
    }
  }
  for (const [resourceId, since] of closedSince) {
    push(resourceId, [since, Number.POSITIVE_INFINITY]);
  }
  return periods;
}

/**
 * Field utilization (SPK-REPORT-003): the scheduling, entry and catalog views of migration 1300
 * feed the pure calculator (calculators/utilization.calculator.ts), which measures everything on
 * conflict units so the same physical hour is never counted twice (U1).
 */
@Injectable()
export class UtilizationReport {
  readonly definition: ReportDefinition<'utilization'> = {
    key: 'utilization',
    title: 'Field utilization',
    requirementIds: ['SPK-REPORT-003', '§1.2'],
    viewAction: ReportingActions.viewUtilization,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'partial',
    pointInTimeNote:
      'Releases, closure applications and lifts, and space status changes after the as-of instant are ignored (their instants are recorded). The scheduling module does not stamp when a reservation was created, so reservations made after the as-of instant are included; the stored run is the reproducible record.',
    settings: [REPORTING_SETTING_NAMES.operatingDayStart],
    compute: async (ctx, params) => this.compute(ctx, params),
  };

  private async compute(
    ctx: ReportContext,
    params: {
      from: string;
      to: string;
      includeBuffers?: boolean;
      weighting?: 'conflict_units' | 'custom';
      weights?: string;
    },
  ) {
    const facility = ctx.facility!;
    const tz = facility.timezone;
    const days: UtilizationDay[] = localDays(
      tz,
      params.from,
      params.to,
      ctx.policy.maxPeriodDays,
      ctx.dayStart,
    );
    const spanStart = new Date(days[0]!.start);
    const spanEnd = new Date(days[days.length - 1]!.end);
    const includeBuffers = params.includeBuffers ?? true;
    const method = params.weighting ?? 'conflict_units';
    const customWeights = parseWeights(params.weights);
    if (method === 'custom' && customWeights.size === 0) {
      throw errors.validation('Custom weighting needs `weights` (resourceId:weight pairs).');
    }
    if (method === 'conflict_units' && customWeights.size > 0) {
      throw errors.validation('`weights` applies only to the custom weighting method.');
    }

    const unitRows = await ctx.db
      .selectFrom('reporting_conflict_units_v')
      .select(['conflict_unit_id', 'unit_name'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .orderBy('unit_name')
      .orderBy('conflict_unit_id')
      .execute();
    const mapping = await ctx.db
      .selectFrom('reporting_resource_units_v')
      .select([
        'resource_id',
        'resource_name',
        'resource_kind',
        'parent_resource_id',
        'conflict_unit_id',
      ])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .execute();
    const resourcesById = new Map<string, UtilizationResource & { unitIds: string[] }>();
    for (const m of mapping) {
      const r = resourcesById.get(m.resource_id) ?? {
        id: m.resource_id,
        name: m.resource_name,
        kind: m.resource_kind,
        parentId: m.parent_resource_id,
        unitIds: [],
      };
      r.unitIds.push(m.conflict_unit_id);
      resourcesById.set(m.resource_id, r);
    }
    const resources = [...resourcesById.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1,
    );
    for (const id of customWeights.keys()) {
      const r = resourcesById.get(id);
      if (!r)
        throw errors.validation('A weighted space is not a space of this facility.', {
          resourceId: id,
        });
      if (r.parentId !== null) {
        throw errors.validation(
          'Weights apply to whole spaces only: a subdivision is inside its whole space and would be counted twice (U3).',
          { resourceId: id },
        );
      }
    }

    // Operating windows (U6): the most specific space holding the unit that has windows, else the
    // facility's windows — the same precedence the scheduling module enforces (SPK-SCHED-001).
    const windows = await ctx.db
      .selectFrom('reporting_operating_hours_v')
      .select(['resource_id', 'weekday', 'opens_at', 'closes_at'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .execute();
    const windowsByResource = new Map<string | null, typeof windows>();
    for (const w of windows) {
      const list = windowsByResource.get(w.resource_id) ?? [];
      list.push(w);
      windowsByResource.set(w.resource_id, list);
    }
    const holders = new Map<string, Array<UtilizationResource & { unitIds: string[] }>>();
    for (const r of resources) {
      for (const unitId of r.unitIds) {
        const list = holders.get(unitId) ?? [];
        list.push(r);
        holders.set(unitId, list);
      }
    }
    for (const list of holders.values()) {
      list.sort((a, b) => a.unitIds.length - b.unitIds.length || (a.id < b.id ? -1 : 1));
    }
    const windowSource = (unitId: string): typeof windows | null => {
      for (const r of holders.get(unitId) ?? []) {
        const own = windowsByResource.get(r.id);
        if (own && own.length > 0) return own;
      }
      const facilityWindows = windowsByResource.get(null);
      return facilityWindows && facilityWindows.length > 0 ? facilityWindows : null;
    };
    const windowsFor = (
      unitId: string,
      day: UtilizationDay & { weekday?: number },
    ): Interval[] | null => {
      const source = windowSource(unitId);
      if (source === null) return null;
      // An operating day that starts after midnight (REPORTING_OPERATING_DAY_START) also holds the
      // next calendar date's hours before its start; the calculator clips windows to the day.
      const dates = ctx.dayStart === '00:00' ? [day.date] : [day.date, addDays(day.date, 1)];
      return dates.flatMap((date) => {
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        return source
          .filter((w) => w.weekday === weekday)
          .map(
            (w) =>
              [localInstant(tz, date, w.opens_at), localInstant(tz, date, w.closes_at)] as const,
          );
      });
    };

    // Closures applied by the as-of instant, cut at a lift known by then (U8, G3).
    const closureRows = await ctx.db
      .selectFrom('reporting_closures_v')
      .select(['resource_id', 'starts_at', 'ends_at', 'status', 'applied_at', 'lifted_at'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('status', 'in', ['active', 'lifted'])
      .where('applied_at', 'is not', null)
      .where('applied_at', '<=', ctx.asOf)
      .where('starts_at', '<', spanEnd)
      .where('ends_at', '>', spanStart)
      .execute();
    const allUnitIds = unitRows.map((u) => u.conflict_unit_id);
    const closures: UtilizationClosure[] = closureRows.map((c) => {
      const liftedBy =
        c.lifted_at !== null && new Date(c.lifted_at).getTime() <= ctx.asOf.getTime()
          ? new Date(c.lifted_at).getTime()
          : Number.POSITIVE_INFINITY;
      return {
        unitIds:
          c.resource_id === null ? allUnitIds : (resourcesById.get(c.resource_id)?.unitIds ?? []),
        start: new Date(c.starts_at).getTime(),
        end: Math.min(new Date(c.ends_at).getTime(), liftedBy),
      };
    });

    // MET-064 exclusion: scheduling refuses a space with status `closed`, so a unit is closed
    // while every space holding it is closed — a closed whole pitch whose halves are open still
    // books the halves. Its operating time is then closure time, not available time. The status
    // at an instant is the last change recorded by the as-of instant (migration 1302), so a later
    // change never rewrites an earlier period (G3).
    const statusChanges = await ctx.db
      .selectFrom('reporting_resource_status_changes_v')
      .select(['change_id', 'resource_id', 'status', 'changed_at'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('changed_at', '<=', ctx.asOf)
      .orderBy('changed_at')
      .orderBy('change_id')
      .execute();
    const closedOf = closedPeriods(
      statusChanges.map((c) => ({
        resourceId: c.resource_id,
        status: c.status,
        at: new Date(c.changed_at).getTime(),
      })),
    );
    for (const [unitId, list] of holders) {
      let closed: Interval[] | null = null;
      for (const r of list) {
        const own = closedOf.get(r.id) ?? [];
        closed = closed === null ? own : intersect(closed, own);
        if (closed.length === 0) break;
      }
      for (const [start, end] of closed ?? []) closures.push({ unitIds: [unitId], start, end });
    }

    const reservedRows = await ctx.db
      .selectFrom('reporting_reserved_units_v')
      .select([
        'conflict_unit_id',
        'event_id',
        'event_kind',
        'occupied_start',
        'occupied_end',
        'setup_minutes',
        'cleanup_minutes',
        'released_at',
      ])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', facility.id)
      .where('occupied_start', '<', spanEnd)
      .where('occupied_end', '>', spanStart)
      .execute();
    const reservations: UtilizationReservation[] = reservedRows.map((r) => {
      const releasedBy =
        r.released_at !== null && new Date(r.released_at).getTime() <= ctx.asOf.getTime()
          ? new Date(r.released_at).getTime()
          : Number.POSITIVE_INFINITY;
      return {
        unitId: r.conflict_unit_id,
        eventId: r.event_id,
        eventKind: r.event_kind,
        occupiedStart: new Date(r.occupied_start).getTime(),
        occupiedEnd: new Date(r.occupied_end).getTime(),
        setupMs: r.setup_minutes * 60_000,
        cleanupMs: r.cleanup_minutes * 60_000,
        countedEnd: releasedBy,
      };
    });

    const observedEventIds = await this.observedEvents(ctx, [
      ...new Set(reservations.map((r) => r.eventId)),
    ]);

    const result = computeUtilization({
      days,
      units: unitRows.map((u) => ({ id: u.conflict_unit_id, name: u.unit_name })),
      resources,
      windowsFor,
      closures,
      reservations,
      observedEventIds,
      includeBuffers,
      weighting:
        method === 'custom'
          ? { method: 'custom', weights: customWeights }
          : { method: 'conflict_units' },
    });

    const f = result.facility;
    const values: MetricValue[] = [
      metricValue('MET-064', 'Available unit-hours', 'hours', hours(f.availableMs)),
      metricValue('MET-065', 'Reserved unit-hours', 'hours', hours(f.reservedMs), {
        dimensions: { buffers: includeBuffers ? 'included' : 'excluded' },
      }),
      metricValue('MET-066', 'Buffer unit-hours', 'hours', hours(f.bufferMs)),
      metricValue('MET-067', 'Activity unit-hours', 'hours', hours(f.activityMs)),
      metricValue('MET-068', 'Closure unit-hours', 'hours', hours(f.closureMs)),
      metricValue(
        'MET-068',
        'Closure unit-hours outside operating hours',
        'hours',
        hours(f.closureOutsideHoursMs),
        {
          dimensions: { window: 'outside_hours' },
        },
      ),
      metricValue(
        'MET-069',
        'Observed-use unit-hours',
        'hours',
        result.observedCaptured ? hours(f.observedMs) : null,
        {
          unavailableReason: 'attendance was not captured for any reserved event (G13)',
        },
      ),
      metricValue('MET-070', 'Utilization rate', 'ratio', ratio(f.reservedMs, f.availableMs), {
        unavailableReason: 'no available hours in the range (G13)',
      }),
      metricValue(
        'MET-071',
        'Resource-equivalent utilization',
        'ratio',
        result.resourceEquivalent.rate === null
          ? null
          : Math.round(result.resourceEquivalent.rate * 10_000) / 10_000,
        {
          dimensions: { weighting: method },
          unavailableReason: 'no weighted whole space with available hours',
        },
      ),
      metricValue(
        'MET-072',
        'Unreserved available unit-hours',
        'hours',
        hours(Math.max(0, f.availableMs - f.reservedMs)),
      ),
      metricValue(
        'MET-065',
        'Reserved unit-hours outside operating hours',
        'hours',
        hours(f.reservedOutsideHoursMs),
        {
          dimensions: { window: 'outside_hours' },
        },
      ),
      metricValue(
        'MET-065',
        'Reserved unit-hours during closures',
        'hours',
        hours(f.reservedDuringClosureMs),
        {
          dimensions: { window: 'during_closure' },
        },
      ),
    ];
    for (const kind of Object.keys(f.byKindMs).sort()) {
      values.push(
        metricValue(
          'MET-073',
          `Reserved unit-hours: ${kind}`,
          'hours',
          hours(f.byKindMs[kind] ?? 0),
          {
            dimensions: { eventKind: kind },
          },
        ),
      );
    }

    const rows: ReportRow[] = result.resources.map((r) => ({
      resourceId: r.resourceId,
      resource: r.name,
      kind: r.kind,
      parentResourceId: r.parentId,
      conflictUnits: r.unitCount,
      availableUnitHours: hours(r.availableMs),
      reservedUnitHours: hours(r.reservedMs),
      bufferUnitHours: hours(r.bufferMs),
      activityUnitHours: hours(r.activityMs),
      closureUnitHours: hours(r.closureMs),
      closureOutsideHours: hours(r.closureOutsideHoursMs),
      reservedOutsideHours: hours(r.reservedOutsideHoursMs),
      reservedDuringClosure: hours(r.reservedDuringClosureMs),
      observedUnitHours: result.observedCaptured ? hours(r.observedMs) : null,
      reservedFieldHours: r.unitCount > 0 ? hours(r.reservedMs / r.unitCount) : null,
      availableFieldHours: r.unitCount > 0 ? hours(r.availableMs / r.unitCount) : null,
      utilizationRate: ratio(r.reservedMs, r.availableMs),
      weight: r.weight,
    }));

    const re = result.resourceEquivalent;
    const unconfigured = [...result.units.values()].reduce((sum, u) => sum + u.unconfiguredDays, 0);
    const disclosures = [
      'Basis: unit-hours. Every figure is measured per conflict unit; a space row sums its own units, and the facility total sums each unit once, so a whole pitch and its subdivisions are never added together (U1, U2).',
      `Reserved time ${includeBuffers ? 'includes' : 'excludes'} setup and cleanup buffers (U5); buffer and activity hours are shown separately.`,
      'Maintenance and block events are unavailability (closure hours), not reserved use (U4).',
      'Reserved time outside operating hours and during closures is reported separately, never clipped away silently (U6).',
      'Observed-use hours are an overlay on reserved hours from attendance observations and admitted check-ins, never a denominator (U7).',
      `Resource-equivalent weighting (${method}, U3): ${
        re.included.length > 0
          ? re.included.map((w) => `${w.name} = ${w.weight}`).join('; ')
          : 'no weighted space'
      }${re.excluded.length > 0 ? `; excluded: ${re.excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}` : ''}. Subdivisions are inside their whole space and are never weighted.`,
      ctx.policy.operatingDayStart === null
        ? `Operating day: the calendar day, local midnight to midnight in ${tz} (no REPORTING_OPERATING_DAY_START is configured; DEC-001).`
        : `Operating day: from ${ctx.dayStart} to ${ctx.dayStart} the next day, local time in ${tz} (REPORTING_OPERATING_DAY_START; DEC-001).`,
    ];
    const closedNames = resources
      .filter((r) =>
        (closedOf.get(r.id) ?? []).some(
          ([s, e]) => s < spanEnd.getTime() && e > spanStart.getTime(),
        ),
      )
      .map((r) => {
        const periods = (closedOf.get(r.id) ?? []).map(([s, e]) =>
          Number.isFinite(e)
            ? `${new Date(s).toISOString()} to ${new Date(e).toISOString()}`
            : `from ${new Date(s).toISOString()}`,
        );
        return `${r.name} (closed ${periods.join('; ')})`;
      });
    if (closedNames.length > 0) {
      disclosures.push(
        `Spaces with status closed in the range: ${closedNames.join(', ')}. A unit counts as closed (closure hours, not available hours) only while every space holding it is closed, from the status changes recorded by the as-of instant (MET-064).`,
      );
    }
    if (unconfigured > 0) {
      disclosures.push(
        `${unconfigured} unit-day(s) have no operating hours configured: they count as no available hours and their reserved time as outside operating hours.`,
      );
    }
    return {
      scope: { from: params.from, to: params.to },
      values,
      columns: [
        column('resourceId', 'Space', 'id'),
        column('resource', 'Space name'),
        column('kind', 'Kind'),
        column('parentResourceId', 'Whole space', 'id'),
        column('conflictUnits', 'Conflict units', 'count'),
        column('availableUnitHours', 'Available unit-hours', 'hours'),
        column('reservedUnitHours', 'Reserved unit-hours', 'hours'),
        column('bufferUnitHours', 'Buffer unit-hours', 'hours'),
        column('activityUnitHours', 'Activity unit-hours', 'hours'),
        column('closureUnitHours', 'Closure unit-hours', 'hours'),
        column('closureOutsideHours', 'Closure outside hours', 'hours'),
        column('reservedOutsideHours', 'Reserved outside hours', 'hours'),
        column('reservedDuringClosure', 'Reserved during closure', 'hours'),
        column('observedUnitHours', 'Observed-use unit-hours', 'hours'),
        column('reservedFieldHours', 'Reserved field-hours', 'hours'),
        column('availableFieldHours', 'Available field-hours', 'hours'),
        column('utilizationRate', 'Utilization rate', 'ratio'),
        column('weight', 'Weight (whole spaces)', 'count'),
      ],
      rows,
      disclosures,
    };
  }

  /** Events with an attended observation or an admitted check-in recorded by the as-of instant (U7). */
  private async observedEvents(ctx: ReportContext, eventIds: string[]): Promise<Set<string>> {
    const observed = new Set<string>();
    if (eventIds.length === 0) return observed;
    const observations = await ctx.db
      .selectFrom('reporting_attendance_v')
      .select([
        'observation_id',
        'person_id',
        'scheduling_event_id',
        'activity_id',
        'observed_state',
        'observed_at',
        'received_at',
        'corrects_observation_id',
      ])
      .where('organization_id', '=', ctx.organizationId)
      .where('scheduling_event_id', 'in', eventIds)
      .where('received_at', '<=', ctx.asOf)
      .execute();
    const groups = new Map<string, typeof observations>();
    for (const o of observations) {
      const key = `${o.scheduling_event_id}|${o.activity_id}|${o.person_id}`;
      const list = groups.get(key) ?? [];
      list.push(o);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      const state = effectiveState(
        currentHeads(
          list.map((o) => ({
            id: o.observation_id,
            correctsObservationId: o.corrects_observation_id,
            observedState: o.observed_state,
            observedAt: new Date(o.observed_at),
            receivedAt: new Date(o.received_at),
          })),
        ),
      );
      if (state !== null && isAttended(state)) observed.add(list[0]!.scheduling_event_id as string);
    }
    const checkins = await ctx.db
      .selectFrom('reporting_session_checkins_v')
      .select(['scheduling_event_id'])
      .where('organization_id', '=', ctx.organizationId)
      .where('scheduling_event_id', 'in', eventIds)
      .where('admitted_at', 'is not', null)
      .where('admitted_at', '<=', ctx.asOf)
      .execute();
    for (const c of checkins) if (c.scheduling_event_id) observed.add(c.scheduling_event_id);
    return observed;
  }
}
