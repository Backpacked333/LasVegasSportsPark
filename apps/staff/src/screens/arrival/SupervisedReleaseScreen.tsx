/**
 * SCR-S-30 Supervised release (SPK-ENTRY-007, SPK-COND-004, §4.15, SPK-AT-016, DEC-005,
 * DEC-034, DEC-075). The front desk chooses where the child is collected from:
 *
 * - one of today's sessions at the facility (`GET /v1/sessions`, facility time zone): children
 *   from its attendance, the collector identified with the read-only collector check before
 *   anything is recorded (`POST /v1/releases/collector-checks`), then the release;
 * - children on site without a session: the collector identified by the desk pass scan.
 *
 * The desk may arrive with `?session=<id>` (an opaque session id) to start from that session.
 *
 * Either way the API verifies current pickup authority online when the release is recorded.
 * Whether supervised release applies to a program is DEC-075 (pending): the API treats every child
 * participant of a session as released through this flow.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ARRIVAL_TABS, AreaTabs } from '../../features/operations/AreaTabs';
import { useOperatingFacility } from '../../features/operations/context';
import { ChooseFacility } from '../../features/operations/feedback';
import { SelectField } from '../../features/operations/fields';
import { formatRange } from '../../features/operations/format';
import {
  OfflineQueueChip,
  OfflineQueueStatus,
} from '../../features/operations/offline/OfflineQueueStatus';
import {
  sessionActivity,
  sessionTitle,
  useTodaySessions,
} from '../../features/operations/sessions';
import { LoadMore } from '../../ui/LoadMore';
import { PageHeader } from '../../ui/Page';
import { StateView } from '../../ui/StateView';
import './arrival.css';
import { ReleasePanel } from './ReleasePanel';

const ON_SITE = 'on-site';

export function SupervisedReleaseScreen() {
  const facility = useOperatingFacility();
  return (
    <section aria-labelledby="release-title" className="ops-screen">
      <PageHeader
        eyebrow="Operate · Arrival and attendance · pickup"
        title="Supervised release"
        titleId="release-title"
        actions={<OfflineQueueChip />}
      />
      <AreaTabs label="Arrival and attendance screens" tabs={ARRIVAL_TABS} />
      <OfflineQueueStatus />
      {!facility.facilityId ? (
        facility.loading ? (
          <StateView variant="loading" label="your facilities" />
        ) : (
          <ChooseFacility purpose="release children to an authorised adult" />
        )
      ) : (
        <DeskRelease
          facilityId={facility.facilityId}
          timezone={facility.timezone}
          window={facility.window}
        />
      )}
    </section>
  );
}

function DeskRelease({
  facilityId,
  timezone,
  window,
}: {
  facilityId: string;
  timezone: string | null;
  window: { start: string; end: string } | null;
}) {
  // `?session=<id>` (from the arrival desk's "Supervised release" rail) preselects that session;
  // an id that is not among today's sessions falls back to children on site.
  const [params] = useSearchParams();
  const [from, setFrom] = useState(params.get('session') ?? ON_SITE);
  const sessions = useTodaySessions({ facilityId, window });
  const session = (sessions.data ?? []).find((s) => s.sessionId === from);
  const sessionsUnavailable =
    sessions.error && (sessions.error.isPermissionRestriction || sessions.error.isNotFound);
  return (
    <>
      <div className="ops-section">
        <SelectField
          label="Release from"
          value={from}
          onChange={setFrom}
          options={[
            { value: ON_SITE, label: 'Children on site (no session)' },
            ...(sessions.data ?? []).map((s) => ({
              value: s.sessionId,
              label: `${sessionTitle(s)}, ${formatRange(s.scheduledStart, s.scheduledEnd, s.timezone ?? timezone)}`,
            })),
          ]}
          hint={
            sessionsUnavailable
              ? "Today's sessions are not available to you; children on site can still be released."
              : sessions.data === undefined
                ? sessions.error
                  ? "Today's sessions could not be loaded."
                  : "Loading today's sessions…"
                : 'Choosing the session lets you check the collector before anything is recorded.'
          }
        />
        {sessions.error && !sessionsUnavailable ? (
          <StateView
            variant="error"
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
          />
        ) : null}
        <LoadMore pages={sessions} label="sessions" />
      </div>
      {session ? (
        <ReleasePanel
          key={session.sessionId}
          facilityId={facilityId}
          timezone={session.timezone ?? timezone}
          activity={sessionActivity(session)}
        />
      ) : from !== ON_SITE && sessions.data === undefined && !sessions.error ? (
        // A session asked for by the link: wait for today's sessions rather than reading the
        // on-site children first.
        <StateView variant="loading" label="today's sessions" />
      ) : (
        <ReleasePanel key={ON_SITE} facilityId={facilityId} timezone={timezone} />
      )}
    </>
  );
}
