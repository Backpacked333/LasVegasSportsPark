/**
 * The public schedule of a facility (SPK-SCHED-010, proposed amendment PA-06; capability
 * `public_schedule`): whether it is enabled, its public page and lobby display links, and the
 * commands to enable it, take it down or issue a new code. The links are built from the
 * organization's slug and a random public code; they carry no record id.
 *
 * What the public page shows is decided by the API, and this screen says it in the same words: a
 * private booking reads "Reserved" without the renter, a game shows team names only when its
 * competition is public, and a title a person typed is never shown. The wording for private
 * bookings and what a lobby shows wait for decision DEC-100.
 */
import type { Schema } from '@sportspark/api-client';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, SuccessNote, useRefetch } from '../../features/competition/feedback';
import {
  FacilityGate,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type View = Schema<'FacilityPublicView'>;

const VIEW_KEYS = keys('/facilities/{id}/public-schedule-view');

export function publicSchedulePaths(view: View): { page: string; lobby: string } | null {
  if (!view.publicCode) return null;
  return {
    page: `/public/${view.organizationSlug}/schedule/${view.publicCode}`,
    lobby: `/lobby/${view.organizationSlug}/${view.publicCode}`,
  };
}

function Switch({ view, facility }: { view: View; facility: FacilityContext }) {
  const enable = useApiCommand('post', '/facilities/{id}/public-schedule-view/enable', {
    invalidate: VIEW_KEYS,
  });
  const disable = useApiCommand('post', '/facilities/{id}/public-schedule-view/disable', {
    invalidate: VIEW_KEYS,
  });
  const reload = useRefetch(['/facilities/{id}/public-schedule-view']);
  const revision = view.revision > 0 ? { expectedRevision: view.revision } : {};
  const doEnable = (newCode: boolean) => {
    disable.reset();
    void enable
      .submit({ path: { id: facility.id }, body: { ...revision, ...(newCode ? { newCode } : {}) } })
      .catch(() => undefined);
  };
  const doDisable = () => {
    enable.reset();
    void disable
      .submit({ path: { id: facility.id }, body: { expectedRevision: view.revision } })
      .catch(() => undefined);
  };
  const paths = view.enabled ? publicSchedulePaths(view) : null;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <div className="form">
      <p>
        <StatusBadge
          tone={view.enabled ? 'success' : 'neutral'}
          label={view.enabled ? 'Public schedule enabled' : 'Public schedule not enabled'}
        />{' '}
        <span className="caption">
          {view.enabled
            ? `Anyone with the link reads the day schedule of ${facility.name} without sign-in.`
            : `The schedule of ${facility.name} is not readable without sign-in.`}
        </span>
      </p>
      <ul className="list" aria-label="What the public schedule shows">
        <li>Time, field and what occupies it, for one day.</li>
        <li>A rental or a party reads &quot;Reserved&quot;, without the renter&apos;s name.</li>
        <li>
          A game shows team names and score only when its competition is public; otherwise it reads
          &quot;League game&quot;.
        </li>
        <li>A title typed by a person is never shown; the kind of activity is shown instead.</li>
      </ul>
      <p className="caption">
        Proposed rules, pending decision DEC-100 (what is public, the wording for private bookings,
        what a lobby display shows).
      </p>
      {paths ? (
        <ul className="list" aria-label="Public schedule links">
          <li>
            <div className="row-text">
              <span className="row-title">Public page</span>
              <a href={paths.page}>{`${origin}${paths.page}`}</a>
            </div>
          </li>
          <li>
            <div className="row-text">
              <span className="row-title">Lobby display</span>
              <a href={paths.lobby}>{`${origin}${paths.lobby}`}</a>
              <span className="caption">
                Advances by itself, shows when it was last updated and keeps the last schedule it
                received while its connection is down.
              </span>
            </div>
          </li>
        </ul>
      ) : null}
      <div className="actions">
        {view.enabled ? (
          <>
            <CommandButton variant="secondary" busy={disable.isProcessing} onClick={doDisable}>
              Disable the public schedule
            </CommandButton>
            <CommandButton
              variant="secondary"
              busy={enable.isProcessing}
              onClick={() => doEnable(true)}
            >
              Issue a new link
            </CommandButton>
          </>
        ) : (
          <CommandButton busy={enable.isProcessing} onClick={() => doEnable(false)}>
            Enable the public schedule
          </CommandButton>
        )}
      </div>
      {enable.data ? <SuccessNote>Public schedule enabled</SuccessNote> : null}
      {disable.data ? <SuccessNote>Public schedule disabled</SuccessNote> : null}
      <CommandError
        error={enable.error ?? disable.error}
        onReload={() => {
          enable.reset();
          disable.reset();
          reload();
        }}
      />
    </div>
  );
}

function FacilityPublicSchedule({ facility }: { facility: FacilityContext }) {
  const view = useApiQuery({
    path: '/facilities/{id}/public-schedule-view',
    request: { path: { id: facility.id } },
  });
  return (
    <QueryBoundary
      query={view}
      label="the public schedule"
      empty={{ title: '', description: '' }}
      unavailableOffline={['enabling or disabling the public schedule']}
    >
      {(data) => <Switch view={data} facility={facility} />}
    </QueryBoundary>
  );
}

export function PublicScheduleSettingsScreen() {
  return (
    <section aria-labelledby="public-schedule-title" className="area-stack">
      <h2 id="public-schedule-title">Public and lobby schedule</h2>
      <CapabilityGate
        capability="public_schedule"
        subject="Public and lobby views"
        whenOff="notice"
        stillAvailable="A public schedule that is enabled can still be disabled."
      >
        <FacilityGate purpose="set up its public schedule">
          {(facility) => <FacilityPublicSchedule facility={facility} />}
        </FacilityGate>
      </CapabilityGate>
    </section>
  );
}
