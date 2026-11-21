/**
 * What Today remembers on this device between reads (S 1a "Needs action"):
 *
 * - issues resolved here and leaving the list (after the 2 s ✓), until the next read of the
 *   Today feed no longer lists them, or the write is undone;
 * - snoozed issues (30 min; kept in this browser's preferences with their end, so a reload keeps
 *   them snoozed and they come back by themselves);
 * - issues flagged for the arrival desk ("Flag at arrival"), for the rest of the day;
 * - how many were resolved here today (added to the resolved count read from the API).
 *
 * None of it is a record: the API stays the source of truth, and an issue that is still open
 * comes back when its local reason ends.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../../providers/AppProviders';
import { SNOOZE_MS } from './today-model';

const SNOOZE_KEY = 'sportspark.today.snoozed';
const FLAG_KEY = 'sportspark.today.flagged';

type Stamps = Record<string, string>;

function readStamps(raw: string | null): Stamps {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      return Object.fromEntries(
        Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    }
  } catch {
    // A damaged entry is forgotten.
  }
  return {};
}

export interface TodayLocal {
  /** Issue ids leaving or gone from the list because they were resolved here. */
  resolved: ReadonlySet<string>;
  /** Resolutions made here (for "N resolved today"). */
  resolvedHere: number;
  resolve(id: string): void;
  unresolve(id: string): void;
  isSnoozed(id: string, now: Date): boolean;
  snooze(id: string, now: Date): void;
  unsnooze(id: string): void;
  isFlagged(id: string): boolean;
  flag(id: string, until: string): void;
  unflag(id: string): void;
}

const TodayLocalContext = createContext<TodayLocal | null>(null);

export function TodayLocalProvider({ children }: { children: ReactNode }) {
  const { preferences } = useApp();
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const [resolvedHere, setResolvedHere] = useState(0);
  const [snoozed, setSnoozed] = useState<Stamps>(() => readStamps(preferences.get(SNOOZE_KEY)));
  const [flagged, setFlagged] = useState<Stamps>(() => readStamps(preferences.get(FLAG_KEY)));

  const resolve = useCallback((id: string) => {
    setResolved((current) => new Set(current).add(id));
    setResolvedHere((n) => n + 1);
  }, []);
  const unresolve = useCallback((id: string) => {
    setResolved((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setResolvedHere((n) => Math.max(0, n - 1));
  }, []);

  const save = useCallback(
    (key: string, stamps: Stamps) =>
      preferences.set(key, Object.keys(stamps).length > 0 ? JSON.stringify(stamps) : null),
    [preferences],
  );

  const snooze = useCallback(
    (id: string, now: Date) =>
      setSnoozed((current) => {
        const next = { ...current, [id]: new Date(now.getTime() + SNOOZE_MS).toISOString() };
        save(SNOOZE_KEY, next);
        return next;
      }),
    [save],
  );
  const unsnooze = useCallback(
    (id: string) =>
      setSnoozed((current) => {
        const { [id]: _gone, ...next } = current;
        save(SNOOZE_KEY, next);
        return next;
      }),
    [save],
  );
  const flag = useCallback(
    (id: string, until: string) =>
      setFlagged((current) => {
        const next = { ...current, [id]: until };
        save(FLAG_KEY, next);
        return next;
      }),
    [save],
  );
  const unflag = useCallback(
    (id: string) =>
      setFlagged((current) => {
        const { [id]: _gone, ...next } = current;
        save(FLAG_KEY, next);
        return next;
      }),
    [save],
  );

  const value = useMemo<TodayLocal>(
    () => ({
      resolved,
      resolvedHere,
      resolve,
      unresolve,
      isSnoozed: (id, now) => {
        const until = snoozed[id];
        return until !== undefined && new Date(until).getTime() > now.getTime();
      },
      snooze,
      unsnooze,
      isFlagged: (id) => flagged[id] !== undefined,
      flag,
      unflag,
    }),
    [resolved, resolvedHere, resolve, unresolve, snoozed, snooze, unsnooze, flagged, flag, unflag],
  );
  return <TodayLocalContext.Provider value={value}>{children}</TodayLocalContext.Provider>;
}

export function useTodayLocal(): TodayLocal {
  const value = useContext(TodayLocalContext);
  if (!value) throw new Error('useTodayLocal must be used inside <TodayLocalProvider>');
  return value;
}
