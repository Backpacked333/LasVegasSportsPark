/**
 * The facility a schedule or facilities screen works in (SPK-SCHED-008, §4.3). Every scheduling and
 * maintenance list in the API is per facility, so these screens need one facility: the one chosen in
 * the header, the only one in the viewer's scope, or one the viewer picks here.
 *
 * Names, IANA time zones and status come from the facility directory, `GET /v1/facilities` (K-04;
 * any signed-in principal), and the choices are the facilities whose `inStaffScope` is true (the
 * API's answer for the principal's staff scope, §4.3). A record's own facility that the directory
 * does not list (archived) is read with `GET /v1/facilities/{id}`. Today's local date is computed
 * from the injected clock in the facility's zone. When the directory cannot be read, the scope from
 * `GET /v1/me` still offers the facilities, the screens say why the zone is missing, and times are
 * shown in UTC.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { facilityLabel } from '../../layout/FacilitySwitcher';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { localDateOf } from './time';

export type FacilitySummary = Schema<'FacilitySummary'>;
type FacilityStatus = FacilitySummary['status'];

export interface FacilityContext {
  id: string;
  name: string;
  /** The facility's IANA zone; 'UTC' when the viewer cannot read it (`zoneKnown` false). */
  timezone: string;
  zoneKnown: boolean;
  /** Today's local date at the facility (injected clock, facility zone), when the zone is known. */
  localDate: string | null;
  /** The directory status (active, closed, archived); null when the directory was not readable. */
  status: FacilityStatus | null;
}

export const FACILITY_STATUS_BADGE: Record<FacilityStatus, { tone: StatusTone; label: string }> = {
  active: { tone: 'success', label: 'Facility status: active' },
  closed: { tone: 'warning', label: 'Facility status: closed' },
  archived: { tone: 'neutral', label: 'Facility status: archived' },
};

/** The facility directory read every schedule and facilities screen shares (one cached read). */
export function useFacilityDirectory(enabled = true) {
  return useApiQuery({ path: '/facilities', enabled, staleTime: 5 * 60_000 });
}

function contextOf(
  summary: FacilitySummary | undefined,
  id: string,
  now: Date,
  fallbackNames: ReadonlyMap<string, string> = new Map(),
): FacilityContext {
  if (!summary) {
    return {
      id,
      name: facilityLabel(id, fallbackNames),
      timezone: 'UTC',
      zoneKnown: false,
      localDate: null,
      status: null,
    };
  }
  return {
    id,
    name: summary.name,
    timezone: summary.timezone,
    zoneKnown: true,
    localDate: localDateOf(now, summary.timezone),
    status: summary.status,
  };
}

export function useFacilityOptions() {
  const { session } = useApp();
  const now = useNow();
  const signedIn = session.status === 'signed_in';
  const me = useApiQuery({ path: '/me', enabled: signedIn });
  const isStaff = me.data?.principal.kind === 'staff';
  const directory = useFacilityDirectory(signedIn && isStaff);
  const listed = directory.data?.items ?? [];
  const byId = new Map(listed.map((f) => [f.id, f]));
  // The API's scope answer; without the directory, the principal's own facility ids.
  const ids = directory.data
    ? listed.filter((f) => f.inStaffScope === true).map((f) => f.id)
    : (me.data?.principal.facilityIds ?? []);
  const options = ids.map((id) => contextOf(byId.get(id), id, now));
  // Settled once the directory answered or failed; a later refetch (which clears the error while
  // it runs) never unsettles it, so a screen that mounts another reader cannot flip it back.
  const settled =
    me.data !== undefined &&
    (!isStaff || directory.data !== undefined || directory.errorUpdatedAt > 0);
  return { me, directory, options, settled };
}

/**
 * The context of a record's own facility (a draft, closure or task names its facility), with the
 * name and zone when the viewer can read them; otherwise a short reference and UTC. Null until the
 * facility information has loaded (or failed), so no screen starts in the wrong zone.
 */
export function useFacilityById(id: string | undefined): FacilityContext | null {
  const now = useNow();
  const { directory, settled } = useFacilityOptions();
  const listed = directory.data?.items.find((f) => f.id === id);
  // Not in the default listing (archived): read the one facility.
  const single = useApiQuery({
    path: '/facilities/{id}',
    request: { path: { id: id ?? '' } },
    enabled: !!id && directory.data !== undefined && listed === undefined,
    staleTime: 5 * 60_000,
  });
  // Wait for the zone: forms initialise local times from it and must not start in UTC by mistake.
  if (!id || !settled) return null;
  if (listed) return contextOf(listed, id, now);
  if (directory.data !== undefined && single.data === undefined && single.error === null) {
    return null;
  }
  return contextOf(single.data, id, now);
}

/** Why the zone is missing, with a way to read the directory again (SPK-UX-008 error state). */
function ZoneUnknown({
  facility,
  error,
  onRetry,
}: {
  facility: FacilityContext;
  error: ApiError | null;
  onRetry: () => void;
}) {
  return (
    <p className="caption" data-testid="zone-unknown">
      The time zone of {facility.name} is not available to you
      {error ? ` (the facility directory could not be read: ${error.code})` : ''}, so times are
      shown in UTC.{' '}
      {error ? (
        <Button variant="secondary" onClick={onRetry}>
          Load facilities again
        </Button>
      ) : null}
    </p>
  );
}

/** Renders `children` with the facility in scope, or asks the viewer to pick one. */
export function FacilityGate({
  purpose,
  children,
}: {
  /** e.g. "see the schedule". */
  purpose: string;
  children: (facility: FacilityContext) => ReactNode;
}) {
  const { facilityId, setFacilityId } = useApp();
  const { me, directory, options, settled } = useFacilityOptions();

  if (me.error) {
    return me.error.isPermissionRestriction || me.error.isNotFound ? (
      <StateView variant="unavailable" />
    ) : (
      <StateView variant="error" error={me.error} onRetry={() => void me.refetch()} />
    );
  }
  if (!settled) return <StateView variant="loading" label="your facilities" />;
  if (me.data?.principal.kind !== 'staff') return <StateView variant="unavailable" />;

  const selected =
    options.find((o) => o.id === facilityId) ?? (options.length === 1 ? options[0] : undefined);
  if (selected) {
    return (
      <>
        {!selected.zoneKnown ? (
          <ZoneUnknown
            facility={selected}
            error={directory.error}
            onRetry={() => void directory.refetch()}
          />
        ) : null}
        {selected.status && selected.status !== 'active' ? (
          <p data-testid="facility-status">
            <StatusBadge
              tone={FACILITY_STATUS_BADGE[selected.status].tone}
              label={FACILITY_STATUS_BADGE[selected.status].label}
            />
          </p>
        ) : null}
        {children(selected)}
      </>
    );
  }
  if (options.length === 0) {
    // SPK-UX-008: a failed directory read is an error with a retry, never "no facility".
    if (directory.error) {
      return (
        <StateView
          variant="error"
          error={directory.error}
          onRetry={() => void directory.refetch()}
        />
      );
    }
    return (
      <StateView
        variant="unavailable"
        title="No facility available"
        description="No facility is available to you. Ask an administrator to add a facility to your staff scope."
      />
    );
  }
  return (
    <section className="state" aria-labelledby="choose-facility">
      <h3 id="choose-facility">Choose a facility</h3>
      <p>Pick the facility to {purpose}.</p>
      <ul className="list" aria-label="Facilities">
        {options.map((o) => (
          <li key={o.id}>
            <div className="row-text">
              <span className="row-title">{o.name}</span>
              <span className="caption">
                {o.zoneKnown ? `Time zone ${o.timezone}` : 'Time zone not available'}
              </span>
            </div>
            {o.status ? (
              <StatusBadge
                tone={FACILITY_STATUS_BADGE[o.status].tone}
                label={FACILITY_STATUS_BADGE[o.status].label}
              />
            ) : null}
            <Button variant="secondary" onClick={() => setFacilityId(o.id)}>
              Use {o.name}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Times are facility local time (America/Los_Angeles)." */
export function ZoneCaption({ facility }: { facility: FacilityContext }) {
  return (
    <p className="caption">
      Times are facility local time ({facility.timezone}
      {facility.zoneKnown ? '' : ', zone not available'}).
    </p>
  );
}
