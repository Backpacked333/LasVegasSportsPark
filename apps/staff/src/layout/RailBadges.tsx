/**
 * Rail badges (redesign handoff, staff shell): a count beside a rail item, with its tone. Two
 * sources feed them:
 *
 * - the API's attention counts (`GET /v1/me/attention`, read by `AreaNav`): what waits for the
 *   viewer in each area, as the owning module answers it;
 * - a screen or provider on this device, through `useRailBadge(area, badge)`: something only the
 *   device knows, e.g. the arrival desk's offline check-in queue ("2 check-ins waiting to sync").
 *   The badge shows while the calling component is mounted (or until it passes `null`), so a
 *   provider that lives in the shell keeps it on every page.
 *
 * A device badge replaces the API count for the same area (it is the more urgent fact); the
 * accessible text names the count and what it counts (the pill itself is `aria-hidden`).
 *
 * Usage (e.g. in the arrival offline queue provider):
 *
 *   useRailBadge('arrival', pending > 0
 *     ? { count: pending, tone: 'warning', label: `${pending} check-ins waiting to sync` }
 *     : null);
 */
import type { NavigationAreaId } from '@sportspark/api-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { StatusTone } from '../ui/StatusBadge';

export interface RailBadge {
  count: number;
  tone: StatusTone;
  /** What the count counts, read by screen readers: "2 check-ins waiting to sync". */
  label: string;
}

type SetBadge = (area: NavigationAreaId, owner: symbol, badge: RailBadge | null) => void;

// Two contexts: the setter is stable, so a component that feeds a badge never re-renders (or
// re-runs its effect) because some other badge changed.
const RailBadgeContext = createContext<ReadonlyMap<NavigationAreaId, RailBadge> | null>(null);
const RailBadgeSetter = createContext<SetBadge | null>(null);

export function RailBadgeProvider({ children }: { children: ReactNode }) {
  // One entry per area and owner; the newest owner of an area wins.
  const [entries, setEntries] = useState<
    ReadonlyArray<{ area: NavigationAreaId; owner: symbol; badge: RailBadge }>
  >([]);
  const set = useCallback((area: NavigationAreaId, owner: symbol, badge: RailBadge | null) => {
    setEntries((current) => {
      const mine = current.find((e) => e.area === area && e.owner === owner);
      if (
        mine &&
        badge &&
        mine.badge.count === badge.count &&
        mine.badge.tone === badge.tone &&
        mine.badge.label === badge.label
      ) {
        return current;
      }
      if (!mine && !badge) return current;
      const others = current.filter((e) => e !== mine);
      return badge ? [...others, { area, owner, badge }] : others;
    });
  }, []);
  const badges = useMemo(() => {
    const map = new Map<NavigationAreaId, RailBadge>();
    for (const e of entries) map.set(e.area, e.badge);
    return map;
  }, [entries]);
  return (
    <RailBadgeSetter.Provider value={set}>
      <RailBadgeContext.Provider value={badges}>{children}</RailBadgeContext.Provider>
    </RailBadgeSetter.Provider>
  );
}

/** The device badges, by area (empty outside the provider). */
export function useRailBadges(): ReadonlyMap<NavigationAreaId, RailBadge> {
  return useContext(RailBadgeContext) ?? EMPTY;
}

const EMPTY: ReadonlyMap<NavigationAreaId, RailBadge> = new Map();

/** Shows `badge` on the rail item of `area` while the caller is mounted; `null` clears it. */
export function useRailBadge(area: NavigationAreaId, badge: RailBadge | null): void {
  const set = useContext(RailBadgeSetter);
  const [owner] = useState(() => Symbol(area));
  const count = badge?.count ?? null;
  const tone = badge?.tone ?? null;
  const label = badge?.label ?? null;
  useEffect(() => {
    set?.(
      area,
      owner,
      count !== null && tone !== null && label !== null ? { count, tone, label } : null,
    );
  }, [set, area, owner, count, tone, label]);
  useEffect(() => {
    if (!set) return;
    return () => set(area, owner, null);
  }, [set, area, owner]);
}
