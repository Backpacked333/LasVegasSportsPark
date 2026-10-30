/**
 * Today's program sessions at a facility (SCR-S-28 lookup check-in, SCR-S-29 attendance picker,
 * SCR-S-30 release from a session; SPK-SCHED-008).
 *
 * `GET /v1/sessions` (CAT-01) lists the sessions overlapping a window of at most 31 days with the
 * facility's IANA time zone, paged by the API's cursor. The window is the facility-local day from
 * the Today feed; without it, the 24 hours around now. The listing is a staff read: a refusal is
 * rendered by the caller as not available.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { useNow } from '../../providers/AppProviders';
import type { ActivityRef } from './activity';

export type FacilitySession = Schema<'FacilitySession'>;

export const sessionKey = (s: FacilitySession) => s.sessionId;

export function sessionActivity(s: FacilitySession): ActivityRef {
  return { type: 'session', offeringId: s.offeringId, sessionId: s.sessionId };
}

export function sessionTitle(s: FacilitySession): string {
  return s.title ? `${s.offeringName}: ${s.title}` : `${s.offeringName}, session ${s.sequence}`;
}

/** The facility-local day, or the 24 hours from two hours ago when the Today feed has no window. */
export function useDayWindow(window: { start: string; end: string } | null): {
  start: string;
  end: string;
} {
  const now = useNow(60_000);
  const minute = Math.floor(now.getTime() / 60_000);
  return useMemo(() => {
    if (window) return window;
    const at = minute * 60_000;
    return {
      start: new Date(at - 2 * 3_600_000).toISOString(),
      end: new Date(at + 22 * 3_600_000).toISOString(),
    };
  }, [window, minute]);
}

export function useTodaySessions({
  facilityId,
  window,
  enabled = true,
}: {
  facilityId: string | null;
  window: { start: string; end: string } | null;
  enabled?: boolean;
}) {
  const day = useDayWindow(window);
  // GET /sessions needs from < to: an empty window reads the 24 hours from its start.
  const range =
    new Date(day.start) < new Date(day.end)
      ? day
      : {
          start: day.start,
          end: new Date(new Date(day.start).getTime() + 86_400_000).toISOString(),
        };
  return useApiPages({
    path: '/sessions',
    request: {
      query: {
        facilityId: facilityId ?? '',
        from: range.start,
        to: range.end,
        status: 'scheduled',
        limit: 100,
      },
    },
    keyOf: sessionKey,
    enabled: enabled && facilityId !== null,
  });
}
