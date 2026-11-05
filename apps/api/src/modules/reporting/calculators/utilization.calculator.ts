import { intersect, length, normalize, subtract, union, type Interval } from './intervals';

/**
 * Field utilization (SPK-REPORT-003, metric dictionary rules U1 to U9), as a pure function of
 * already-resolved instants. All time is measured on the conflict unit (the atomic physical area):
 * a whole-pitch reservation occupies every unit of the pitch, a subdivision reservation only its
 * own unit, so a physical hour is counted once per unit it occupies and a facility total is the
 * sum over units — never the sum over spaces, which would count a pitch and its halves twice (U1).
 * Reserved, available, observed and closed hours are separate quantities (U4).
 */

export interface UtilizationDay {
  date: string;
  start: number;
  end: number;
}

export interface UtilizationUnit {
  id: string;
  name: string;
}

export interface UtilizationResource {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
  unitIds: readonly string[];
}

export interface UtilizationReservation {
  unitId: string;
  eventId: string;
  eventKind: string;
  /** Occupied interval as reserved (scheduled interval plus buffers). */
  occupiedStart: number;
  occupiedEnd: number;
  setupMs: number;
  cleanupMs: number;
  /** End of the counted interval: the occupied end, or the release instant if released earlier (U8). */
  countedEnd: number;
}

export interface UtilizationClosure {
  /** Units covered (a whole-facility closure covers every unit). */
  unitIds: readonly string[];
  start: number;
  end: number;
}

export interface UtilizationInput {
  days: readonly UtilizationDay[];
  units: readonly UtilizationUnit[];
  resources: readonly UtilizationResource[];
  /** Operating windows of a unit on a day; null when no operating hours are configured (U6). */
  windowsFor(unitId: string, day: UtilizationDay): Interval[] | null;
  closures: readonly UtilizationClosure[];
  reservations: readonly UtilizationReservation[];
  /** Events with attendance evidence (U7 overlay). */
  observedEventIds: ReadonlySet<string>;
  includeBuffers: boolean;
  weighting:
    { method: 'conflict_units' } | { method: 'custom'; weights: ReadonlyMap<string, number> };
}

export interface UnitTotals {
  availableMs: number;
  reservedMs: number;
  reservedWithBuffersMs: number;
  bufferMs: number;
  activityMs: number;
  closureMs: number;
  closureOutsideHoursMs: number;
  reservedOutsideHoursMs: number;
  reservedDuringClosureMs: number;
  observedMs: number;
  operatingMs: number;
  byKindMs: Record<string, number>;
  unconfiguredDays: number;
}

export interface ResourceTotals extends UnitTotals {
  resourceId: string;
  name: string;
  kind: string;
  parentId: string | null;
  unitCount: number;
  weight: number | null;
}

export interface UtilizationResult {
  units: Map<string, UnitTotals>;
  resources: ResourceTotals[];
  facility: UnitTotals;
  observedCaptured: boolean;
  resourceEquivalent: {
    method: 'conflict_units' | 'custom';
    reservedWeighted: number;
    availableWeighted: number;
    rate: number | null;
    included: Array<{ resourceId: string; name: string; weight: number }>;
    excluded: Array<{ resourceId: string; name: string; reason: string }>;
  };
}

/** Event kinds that make space unavailable rather than used (U4). */
export const UNAVAILABILITY_KINDS: ReadonlySet<string> = new Set(['maintenance', 'block']);

function emptyTotals(): UnitTotals {
  return {
    availableMs: 0,
    reservedMs: 0,
    reservedWithBuffersMs: 0,
    bufferMs: 0,
    activityMs: 0,
    closureMs: 0,
    closureOutsideHoursMs: 0,
    reservedOutsideHoursMs: 0,
    reservedDuringClosureMs: 0,
    observedMs: 0,
    operatingMs: 0,
    byKindMs: {},
    unconfiguredDays: 0,
  };
}

function addInto(target: UnitTotals, source: UnitTotals): void {
  target.availableMs += source.availableMs;
  target.reservedMs += source.reservedMs;
  target.reservedWithBuffersMs += source.reservedWithBuffersMs;
  target.bufferMs += source.bufferMs;
  target.activityMs += source.activityMs;
  target.closureMs += source.closureMs;
  target.closureOutsideHoursMs += source.closureOutsideHoursMs;
  target.reservedOutsideHoursMs += source.reservedOutsideHoursMs;
  target.reservedDuringClosureMs += source.reservedDuringClosureMs;
  target.observedMs += source.observedMs;
  target.operatingMs += source.operatingMs;
  target.unconfiguredDays += source.unconfiguredDays;
  for (const [kind, ms] of Object.entries(source.byKindMs)) {
    target.byKindMs[kind] = (target.byKindMs[kind] ?? 0) + ms;
  }
}

function countedInterval(r: UtilizationReservation): Interval {
  return [r.occupiedStart, Math.min(r.occupiedEnd, r.countedEnd)];
}

/** Activity part of a reservation: the occupied interval without its setup and cleanup (U5). */
function activityInterval(r: UtilizationReservation): Interval {
  const start = r.occupiedStart + r.setupMs;
  const end = Math.min(r.occupiedEnd - r.cleanupMs, r.countedEnd);
  return [start, Math.max(start, end)];
}

export function computeUtilization(input: UtilizationInput): UtilizationResult {
  const byUnit = new Map<string, UtilizationReservation[]>();
  for (const r of input.reservations) {
    const list = byUnit.get(r.unitId) ?? [];
    list.push(r);
    byUnit.set(r.unitId, list);
  }
  const closuresByUnit = new Map<string, Interval[]>();
  for (const c of input.closures) {
    for (const unitId of c.unitIds) {
      const list = closuresByUnit.get(unitId) ?? [];
      list.push([c.start, c.end]);
      closuresByUnit.set(unitId, list);
    }
  }

  const units = new Map<string, UnitTotals>();
  let observedCaptured = false;
  for (const unit of input.units) {
    const totals = emptyTotals();
    const reservations = byUnit.get(unit.id) ?? [];
    const used = reservations.filter((r) => !UNAVAILABILITY_KINDS.has(r.eventKind));
    const unavailable = reservations.filter((r) => UNAVAILABILITY_KINDS.has(r.eventKind));
    const closureSet = union(closuresByUnit.get(unit.id) ?? [], unavailable.map(countedInterval));
    const reservedFull = normalize(used.map(countedInterval));
    const activity = normalize(used.map(activityInterval));
    const observed = normalize(
      used
        .filter((r) => input.observedEventIds.has(r.eventId))
        .map((r) => (input.includeBuffers ? countedInterval(r) : activityInterval(r))),
    );
    if (used.some((r) => input.observedEventIds.has(r.eventId))) observedCaptured = true;
    for (const day of input.days) {
      const dayWindow: Interval[] = [[day.start, day.end]];
      const configured = input.windowsFor(unit.id, day);
      if (configured === null) totals.unconfiguredDays += 1;
      const windows = intersect(configured ?? [], dayWindow);
      const closures = intersect(closureSet, dayWindow);
      const open = subtract(windows, closures);
      const reservedDay = intersect(reservedFull, dayWindow);
      const activityDay = intersect(activity, dayWindow);
      const counted = input.includeBuffers ? reservedDay : activityDay;

      totals.operatingMs += length(windows);
      totals.availableMs += length(open);
      totals.closureMs += length(intersect(closures, windows));
      totals.closureOutsideHoursMs += length(subtract(closures, windows));
      totals.reservedWithBuffersMs += length(intersect(reservedDay, open));
      totals.activityMs += length(intersect(activityDay, open));
      totals.bufferMs += length(intersect(subtract(reservedDay, activityDay), open));
      totals.reservedMs += length(intersect(counted, open));
      totals.reservedOutsideHoursMs += length(subtract(counted, windows));
      totals.reservedDuringClosureMs += length(intersect(counted, closures));
      totals.observedMs += length(intersect(intersect(observed, dayWindow), open));
      const kinds = new Set(used.map((r) => r.eventKind));
      for (const kind of kinds) {
        const ofKind = normalize(
          used
            .filter((r) => r.eventKind === kind)
            .map((r) => (input.includeBuffers ? countedInterval(r) : activityInterval(r))),
        );
        const ms = length(intersect(intersect(ofKind, dayWindow), open));
        if (ms > 0) totals.byKindMs[kind] = (totals.byKindMs[kind] ?? 0) + ms;
      }
    }
    units.set(unit.id, totals);
  }

  const facility = emptyTotals();
  for (const totals of units.values()) addInto(facility, totals);

  const weights = input.weighting;
  const resources: ResourceTotals[] = input.resources.map((resource) => {
    const totals = emptyTotals();
    for (const unitId of resource.unitIds) {
      const unitTotals = units.get(unitId);
      if (unitTotals) addInto(totals, unitTotals);
    }
    let weight: number | null = null;
    if (resource.parentId === null) {
      weight =
        weights.method === 'conflict_units'
          ? resource.unitIds.length
          : (weights.weights.get(resource.id) ?? null);
    }
    return {
      ...totals,
      resourceId: resource.id,
      name: resource.name,
      kind: resource.kind,
      parentId: resource.parentId,
      unitCount: resource.unitIds.length,
      weight,
    };
  });

  // Resource-equivalent utilization over whole spaces only (U3): a subdivision's time is already
  // inside its whole space, so weighting it as well would count the same physical time twice.
  let reservedWeighted = 0;
  let availableWeighted = 0;
  const included: UtilizationResult['resourceEquivalent']['included'] = [];
  const excluded: UtilizationResult['resourceEquivalent']['excluded'] = [];
  for (const r of resources) {
    if (r.parentId !== null) continue;
    if (r.weight === null || r.unitCount === 0) {
      excluded.push({
        resourceId: r.resourceId,
        name: r.name,
        reason: r.unitCount === 0 ? 'no conflict units' : 'no weight under the chosen method',
      });
      continue;
    }
    included.push({ resourceId: r.resourceId, name: r.name, weight: r.weight });
    reservedWeighted += (r.reservedMs / r.unitCount) * r.weight;
    availableWeighted += (r.availableMs / r.unitCount) * r.weight;
  }

  return {
    units,
    resources,
    facility,
    observedCaptured,
    resourceEquivalent: {
      method: weights.method,
      reservedWeighted,
      availableWeighted,
      rate: availableWeighted > 0 ? reservedWeighted / availableWeighted : null,
      included,
      excluded,
    },
  };
}
