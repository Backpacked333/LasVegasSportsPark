/**
 * Facilities a staff member may choose on the Reports and Administration screens (SCR-S-43 to
 * SCR-S-48): the organization's facility directory (`GET /v1/facilities`, K-04) with each
 * facility's name and IANA time zone (SPK-SCHED-008), limited to the facilities the API says are
 * in this principal's staff scope (`inStaffScope`). The principal's facility scope from `GET /v1/me`
 * says whether organization-wide reports apply (empty scope = the whole organization). A
 * facility's local date is derived from its time zone and the injected clock; nothing here decides
 * authorization, every read and command is still checked by the API.
 */
import type { ApiError } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useNow } from '../../providers/AppProviders';
import { localDateOf } from './format';

export interface FacilityChoice {
  id: string;
  label: string;
  timezone: string | null;
  localDate: string | null;
}

export function useFacilityChoices(): {
  choices: FacilityChoice[];
  /** The principal is scoped to listed facilities (organization-wide reports are refused). */
  scoped: boolean;
  loading: boolean;
  /**
   * SPK-UX-008: the choices could not be read (no facility listed because a read failed), so
   * consumers show the error, never an empty list.
   */
  error: ApiError | null;
  refetch: () => void;
} {
  const me = useApiQuery({ path: '/me' });
  const directory = useApiQuery({ path: '/facilities', staleTime: 5 * 60_000 });
  const now = useNow(60_000);
  return useMemo(() => {
    const scopedIds = me.data?.principal.facilityIds ?? [];
    const listed = (directory.data?.items ?? []).filter(
      (f) => f.inStaffScope !== false && (scopedIds.length === 0 || scopedIds.includes(f.id)),
    );
    return {
      choices: listed.map((f) => ({
        id: f.id,
        label: f.name,
        timezone: f.timezone,
        localDate: f.timezone ? safeLocalDate(now, f.timezone) : null,
      })),
      scoped: scopedIds.length > 0,
      loading: me.isLoading || directory.isLoading,
      error: listed.length === 0 ? (directory.error ?? me.error ?? null) : null,
      refetch: () => {
        void me.refetch();
        void directory.refetch();
      },
    };
  }, [me, directory, now]);
}

function safeLocalDate(at: Date, timeZone: string): string | null {
  try {
    return localDateOf(at, timeZone);
  } catch {
    return null;
  }
}
