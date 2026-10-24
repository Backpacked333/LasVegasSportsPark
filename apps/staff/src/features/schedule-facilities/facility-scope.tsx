/**
 * The facility a schedule or facilities screen works in (SPK-SCHED-008, §4.3). Every scheduling and
 * maintenance list in the API is per facility, so these screens need one facility: the one chosen in
 * the header, the only one in the viewer's scope, or one the viewer picks here. The choices are the
 * principal's facility scope from `GET /v1/me` (empty = whole organization, then the facilities the
 * Today feed lists); names and IANA time zones come from `GET /v1/today` because the API has no
 * facility directory. When the zone is not available the screen says so and shows UTC.
 */
import type { ReactNode } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { facilityLabel } from '../../layout/FacilitySwitcher';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';

export interface FacilityContext {
  id: string;
  name: string;
  /** The facility's IANA zone; 'UTC' when the viewer cannot read it (`zoneKnown` false). */
  timezone: string;
  zoneKnown: boolean;
  /** Today's local date at the facility, as the API computed it, when known. */
  localDate: string | null;
}

export function useFacilityOptions() {
  const { session } = useApp();
  const signedIn = session.status === 'signed_in';
  const me = useApiQuery({ path: '/me', enabled: signedIn });
  const isStaff = me.data?.principal.kind === 'staff';
  const today = useApiQuery({
    path: '/today',
    enabled: signedIn && isStaff,
    staleTime: 5 * 60_000,
  });
  const listed = today.data?.facilities ?? [];
  const scoped = me.data?.principal.facilityIds ?? [];
  const ids = scoped.length > 0 ? scoped : listed.map((f) => f.facilityId);
  const names = new Map(listed.map((f) => [f.facilityId, f.name]));
  const options: FacilityContext[] = ids.map((id) => {
    const info = listed.find((f) => f.facilityId === id);
    return {
      id,
      name: facilityLabel(id, names),
      timezone: info?.timezone ?? 'UTC',
      zoneKnown: info !== undefined,
      localDate: info?.localDate ?? null,
    };
  });
  const settled =
    me.data !== undefined && (!isStaff || today.data !== undefined || today.error !== null);
  return { me, today, options, settled };
}

/**
 * The context of a record's own facility (a draft, closure or task names its facility), with the
 * name and zone when the viewer can read them; otherwise a short reference and UTC. Null until the
 * facility information has loaded (or failed), so no screen starts in the wrong zone.
 */
export function useFacilityById(id: string | undefined): FacilityContext | null {
  const { options, today, settled } = useFacilityOptions();
  // Wait for the zone: forms initialise local times from it and must not start in UTC by mistake.
  if (!id || !settled) return null;
  const known = options.find((o) => o.id === id);
  if (known) return known;
  const info = today.data?.facilities.find((f) => f.facilityId === id);
  return {
    id,
    name: info?.name ?? facilityLabel(id, new Map()),
    timezone: info?.timezone ?? 'UTC',
    zoneKnown: info !== undefined,
    localDate: info?.localDate ?? null,
  };
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
  const { me, options, settled } = useFacilityOptions();

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
          <p className="caption" data-testid="zone-unknown">
            The time zone of {selected.name} is not available to you, so times are shown in UTC.
          </p>
        ) : null}
        {children(selected)}
      </>
    );
  }
  if (options.length === 0) {
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
            <span className="row-title">{o.name}</span>
            <Button variant="secondary" onClick={() => setFacilityId(o.id)}>
              Use {o.name}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Times are shown in America/Los_Angeles (facility time)." */
export function ZoneCaption({ facility }: { facility: FacilityContext }) {
  return (
    <p className="caption">
      Times are facility local time ({facility.timezone}
      {facility.zoneKnown ? '' : ', zone not available'}).
    </p>
  );
}
