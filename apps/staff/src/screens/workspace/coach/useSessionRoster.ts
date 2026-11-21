/**
 * The children of the coach's session, as the tiles, the release and the injury report need them
 * (staff S 2d, S 3g, S 4d; SPK-ENTRY-001, SPK-ENTRY-005, ENT-01, SPK-UX-007):
 *
 * - `GET /v1/attendance` gives each person's current state and history, named (ENT-01), and the
 *   participants the session expects (`expected`, when the read carries it); otherwise confirmed
 *   enrollments and session bookings name who is expected, through `GET /v1/person-names`;
 * - the offering's name and the session's place (`GET /v1/offerings/{id}`,
 *   `GET /v1/offerings/{id}/sessions`), read as the coach may (child-safe view);
 * - flags: which children have care notes, by kind only (`GET /v1/attendance/care-flags`, nothing
 *   audited), and which miss a waiver the offering requires (`GET /v1/offerings/{id}/required-waivers`
 *   and `GET /v1/people/{id}/waivers`, at most `WAIVER_READS` children).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApiQuery } from '../../../api/useApiQuery';
import { attendanceQuery, type ActivityRef } from '../../../features/operations/activity';
import { usePersonNames } from '../../../features/operations/context';
import { useApi } from '../../../providers/AppProviders';
import { byName } from './tile-model';
import type { TileChild } from './useTileAttendance';

type PersonAttendance = Schema<'PersonAttendance'>;
type PersonWaivers = Schema<'PersonWaivers'>;

export const WAIVER_READS = 40;

export interface RosterChild extends TileChild {
  givenName: string | null;
  familyName: string | null;
  careKinds: ReadonlyArray<'allergy' | 'care_instruction'>;
  /** Titles of required waivers that are missing or lapsed. */
  missingForms: readonly string[];
}

export function useSessionRoster(activity: ActivityRef | null) {
  const api = useApi();
  const isSession = activity?.type === 'session';
  const offeringId = isSession ? activity.offeringId : null;
  const sessionId = isSession ? activity.sessionId : null;
  const attendance = useApiQuery({
    path: '/attendance',
    request: {
      query: activity ? attendanceQuery(activity) : { activityType: 'event', activityId: '' },
    },
    enabled: !!activity,
  });
  const fallback = !!activity && attendance.data !== undefined && attendance.data.expected === null;
  const enrollments = useApiQuery({
    path: '/enrollments',
    request: { query: { offeringId: offeringId ?? undefined, status: 'confirmed', limit: 200 } },
    enabled: isSession && fallback,
  });
  const bookings = useApiQuery({
    path: '/session-bookings',
    request: { query: { sessionId: sessionId ?? undefined, status: 'confirmed' } },
    enabled: isSession && fallback,
  });
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId ?? '' } },
    enabled: !!offeringId,
    staleTime: 10 * 60_000,
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId ?? '' } },
    enabled: !!offeringId,
    staleTime: 10 * 60_000,
  });

  const base = useMemo(() => {
    const byId = new Map<
      string,
      {
        record: PersonAttendance | null;
        given: string | null;
        family: string | null;
        name: string | null;
      }
    >();
    for (const p of attendance.data?.people ?? []) {
      byId.set(p.personId, {
        record: p,
        given: p.givenName,
        family: p.familyName,
        name: p.displayName,
      });
    }
    for (const e of attendance.data?.expected ?? []) {
      const known = byId.get(e.personId);
      byId.set(e.personId, {
        record: known?.record ?? null,
        given: known?.given ?? e.givenName,
        family: known?.family ?? e.familyName,
        name: known?.name ?? e.displayName,
      });
    }
    for (const e of enrollments.data?.items ?? []) {
      if (!byId.has(e.participantPersonId)) {
        byId.set(e.participantPersonId, { record: null, given: null, family: null, name: null });
      }
    }
    for (const b of bookings.data ?? []) {
      if (b && !byId.has(b.participantPersonId)) {
        byId.set(b.participantPersonId, { record: null, given: null, family: null, name: null });
      }
    }
    return byId;
  }, [attendance.data, enrollments.data, bookings.data]);

  const unnamed = useMemo(
    () => [...base.entries()].filter(([, v]) => !v.name).map(([id]) => id),
    [base],
  );
  const names = usePersonNames(unnamed);
  const ids = useMemo(() => [...base.keys()].sort(), [base]);

  const flags = useApiQuery({
    path: '/attendance/care-flags',
    request: {
      query: {
        activityType: 'session',
        activityId: sessionId ?? '',
        offeringId: offeringId ?? undefined,
        personIds: ids.slice(0, 60),
      },
    },
    enabled: isSession && ids.length > 0,
    staleTime: 60_000,
  });
  const required = useApiQuery({
    path: '/offerings/{id}/required-waivers',
    request: { path: { id: offeringId ?? '' } },
    enabled: !!offeringId,
    staleTime: 5 * 60_000,
  });
  const requiredKeys = useMemo(
    () => new Set((required.data?.waivers ?? []).map((w) => w.policyKey)),
    [required.data],
  );
  const waiverIds = requiredKeys.size > 0 ? ids.slice(0, WAIVER_READS) : [];
  const waivers = useQueries({
    queries: waiverIds.map((personId) => ({
      queryKey: ['api', '/people/{id}/waivers', { path: { id: personId } }],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await api.request('get', '/people/{id}/waivers', { path: { id: personId }, signal })).data,
      staleTime: 60_000,
    })),
  });

  const children: RosterChild[] = useMemo(() => {
    const kinds = new Map((flags.data?.items ?? []).map((i) => [i.personId, i.kinds]));
    const missing = new Map<string, string[]>();
    waiverIds.forEach((personId, i) => {
      const data = waivers[i]?.data as PersonWaivers | undefined;
      const titles = (data?.waivers ?? [])
        .filter((w) => requiredKeys.has(w.policyKey) && w.status !== 'current')
        .map((w) => w.title);
      if (titles.length > 0) missing.set(personId, titles);
    });
    const list = [...base.entries()].map(([personId, v]) => {
      const entry = names.get(personId);
      const fromNames = entry?.status === 'ok' ? entry.name : null;
      const name =
        v.name ?? ([v.given, v.family].filter(Boolean).join(' ') || fromNames || 'Participant');
      return {
        personId,
        name,
        givenName: v.given,
        familyName: v.family,
        record: v.record,
        careKinds: kinds.get(personId) ?? [],
        missingForms: missing.get(personId) ?? [],
      };
    });
    return byName(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- waivers is a fresh array each render
  }, [base, names, flags.data, requiredKeys, waivers.map((q) => q.dataUpdatedAt).join(',')]);

  const session = sessions.data?.find((s) => s.id === sessionId) ?? null;
  return {
    attendance,
    children,
    offeringName: offering.data?.name ?? null,
    location: session?.location?.label ?? null,
    flagsError: flags.error,
  };
}
