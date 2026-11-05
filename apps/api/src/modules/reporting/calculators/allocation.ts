import { allocate, money, type EconomicsAllocationMethod } from '@sportspark/contracts';

/**
 * Sales allocation to field time (SPK-REPORT-004, metric dictionary rules E1 to E5, DEC-085).
 * No method is in force by default: the caller names one, and every figure carries it.
 *   - direct: an order line whose offering has exactly one scheduled event is allocated wholly to
 *     that event; any other line stays unallocated.
 *   - pro_rata: a line is spread over its offering's scheduled events by activity minutes.
 * An event's share is then spread over the spaces it reserved by activity unit-time. Every split
 * uses largest-remainder allocation (`allocate`), so minor units are neither lost nor invented.
 * Memberships, packages and anything the method cannot attribute stay unallocated, with a reason.
 */

export interface SaleLine {
  lineId: string;
  offeringId: string;
  offeringKind: string;
  totalMinor: number;
  currency: string;
  /** Facility-local date the order was fulfilled. */
  fulfilledOn: string;
}

export interface OfferingEvent {
  offeringId: string;
  eventId: string;
  /** Facility-local date of the event's scheduled start. */
  eventOn: string;
  activityMinutes: number;
  /** Spaces the event reserved, with the activity unit-time it holds on each. */
  spaces: ReadonlyArray<{ resourceId: string; activityUnitMs: number }>;
}

export type UnallocatedReason =
  | 'sale_type_not_field_time'
  | 'no_scheduled_events'
  | 'direct_needs_single_event'
  | 'event_without_space';

export interface AllocatedPortion {
  lineId: string;
  eventId: string;
  eventOn: string;
  resourceId: string;
  currency: string;
  amountMinor: number;
  activityUnitMs: number;
}

export interface UnallocatedPortion {
  lineId: string;
  currency: string;
  amountMinor: number;
  reason: UnallocatedReason;
  /** Date the portion is reported on: the fulfilment date (or the event date for a spaceless event). */
  reportedOn: string;
}

export interface AllocationResult {
  allocated: AllocatedPortion[];
  unallocated: UnallocatedPortion[];
}

/** Offering kinds that are never field time (E1 `unallocated`). */
export const NON_FIELD_TIME_KINDS: ReadonlySet<string> = new Set(['membership', 'package']);

export function allocateSales(
  lines: readonly SaleLine[],
  events: readonly OfferingEvent[],
  method: EconomicsAllocationMethod,
): AllocationResult {
  const eventsByOffering = new Map<string, OfferingEvent[]>();
  for (const e of events) {
    const list = eventsByOffering.get(e.offeringId) ?? [];
    list.push(e);
    eventsByOffering.set(e.offeringId, list);
  }
  for (const list of eventsByOffering.values()) {
    list.sort((a, b) =>
      a.eventOn < b.eventOn ? -1 : a.eventOn > b.eventOn ? 1 : a.eventId < b.eventId ? -1 : 1,
    );
  }

  const allocated: AllocatedPortion[] = [];
  const unallocated: UnallocatedPortion[] = [];
  const leave = (
    line: SaleLine,
    reason: UnallocatedReason,
    amountMinor = line.totalMinor,
    on = line.fulfilledOn,
  ) => {
    if (amountMinor !== 0) {
      unallocated.push({
        lineId: line.lineId,
        currency: line.currency,
        amountMinor,
        reason,
        reportedOn: on,
      });
    }
  };

  for (const line of lines) {
    if (NON_FIELD_TIME_KINDS.has(line.offeringKind)) {
      leave(line, 'sale_type_not_field_time');
      continue;
    }
    const offeringEvents = (eventsByOffering.get(line.offeringId) ?? []).filter(
      (e) => e.activityMinutes > 0,
    );
    if (offeringEvents.length === 0) {
      leave(line, 'no_scheduled_events');
      continue;
    }
    if (method === 'direct' && offeringEvents.length !== 1) {
      leave(line, 'direct_needs_single_event');
      continue;
    }
    const total = money(line.totalMinor, line.currency);
    const perEvent =
      offeringEvents.length === 1
        ? [total]
        : allocate(
            total,
            offeringEvents.map((e) => e.activityMinutes),
          );
    offeringEvents.forEach((event, i) => {
      const share = perEvent[i];
      if (!share || share.amountMinor === 0) return;
      const spaces = event.spaces.filter((s) => s.activityUnitMs > 0);
      if (spaces.length === 0) {
        leave(line, 'event_without_space', share.amountMinor, event.eventOn);
        return;
      }
      const perSpace =
        spaces.length === 1
          ? [share]
          : allocate(
              share,
              spaces.map((s) => s.activityUnitMs),
            );
      spaces.forEach((space, j) => {
        const portion = perSpace[j];
        if (!portion) return;
        allocated.push({
          lineId: line.lineId,
          eventId: event.eventId,
          eventOn: event.eventOn,
          resourceId: space.resourceId,
          currency: line.currency,
          amountMinor: portion.amountMinor,
          activityUnitMs: space.activityUnitMs,
        });
      });
    });
  }
  return { allocated, unallocated };
}

/** Minor units per hour, rounded half away from zero; null without hours (G13). */
export function perHour(amountMinor: number, ms: number): number | null {
  if (ms <= 0) return null;
  const raw = (amountMinor * 3_600_000) / ms;
  return raw < 0 ? -Math.round(Math.abs(raw)) : Math.round(raw);
}
