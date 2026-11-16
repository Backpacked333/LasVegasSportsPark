/**
 * The facility's clock for records that do not state one (SPK-SCHED-008).
 *
 * Calendar and Home show times in the zone the API states next to them (family calendar items,
 * offerings, fixtures, bookings, facilities). Some records carry no facility: a quote's expiry, a
 * hold, an amount due, a receipt, a family member's access, an inbox notice, the pass. Rather than
 * fall straight back to the device's zone, those screens use the facility zone the app has already
 * been told by any answer it holds (`useKnownFacilityZone`): every `timezone` the cached answers
 * state. Only when all of them name the same zone (one facility, or several on one clock) is it
 * used; when they differ, or nothing stated one yet, the device's zone is used. The zone's
 * abbreviation is always printed beside the time, so the clock is never ambiguous.
 *
 * Nothing is requested for this: it reads the query cache (no new request, so the screens'
 * requests are unchanged), and follows it as answers arrive.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { displayZone, sharedZone, zoneOf, type DisplayZone } from './time';

/** How deep into an answer a `timezone` is looked for (`data.items[].offering.timezone`). */
const MAX_DEPTH = 5;
/** How many items of a list are read (a facility's zone repeats on every item). */
const MAX_ITEMS = 50;

const zonesByAnswer = new WeakMap<object, readonly string[]>();

/** Every `timezone` string in an answer, without repeats. */
export function statedZones(value: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_ITEMS)) statedZones(item, depth + 1, out);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'timezone' && typeof child === 'string' && child !== '') out.add(child);
    else if (child !== null && typeof child === 'object') statedZones(child, depth + 1, out);
  }
  return out;
}

function zonesOf(answer: unknown): readonly string[] {
  if (answer === null || typeof answer !== 'object') return [];
  const known = zonesByAnswer.get(answer);
  if (known) return known;
  const zones = [...statedZones(answer)];
  zonesByAnswer.set(answer, zones);
  return zones;
}

/** The one facility zone the cached answers agree on, or '' when none or they differ. */
export function knownFacilityZone(client: QueryClient): string {
  const zones = client
    .getQueryCache()
    .getAll()
    .flatMap((query) => zonesOf(query.state.data));
  return sharedZone(zones) ?? '';
}

/**
 * The facility zone the app already knows (see above), else the device's zone. `stated` is the
 * record's own zone when it has one, which always wins.
 */
export function useKnownFacilityZone(stated?: string | null): DisplayZone {
  const client = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(onChange),
    [client],
  );
  const snapshot = useCallback(() => knownFacilityZone(client), [client]);
  const known = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (stated) return zoneOf(stated, known);
  return known ? displayZone(known) : displayZone(null);
}
