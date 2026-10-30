/**
 * SCR-S-30 Supervised release (SPK-ENTRY-007, SPK-COND-004, §4.15, SPK-AT-016, DEC-005,
 * DEC-034, DEC-075). The front desk chooses where the child is collected from:
 *
 * - one of today's sessions at the facility (`GET /v1/sessions`, facility time zone): children
 *   from its attendance, the collector identified with the read-only collector check before
 *   anything is recorded (`POST /v1/releases/collector-checks`), then the release;
 * - children on site without a session: the collector identified by the desk pass scan.
 *
 * Either way the API verifies current pickup authority online when the release is recorded.
 * Whether supervised release applies to a program is DEC-075 (pending): the API treats every child
 * participant of a session as released through this flow.
 */
import { useState } from 'react';
import { ARRIVAL_TABS, AreaTabs } from '../../features/operations/AreaTabs';
import { useOperatingFacility } from '../../features/operations/context';
import { ChooseFacility } from '../../features/operations/feedback';
import { SelectField } from '../../features/operations/fields';
import { formatRange } from '../../features/operations/format';
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import {
  sessionActivity,
  sessionTitle,
  useTodaySessions,
} from '../../features/operations/sessions';
import { LoadMore } from '../../ui/LoadMore';
import { StateView } from '../../ui/StateView';
import { ReleasePanel } from './ReleasePanel';

const ON_SITE = 'on-site';

export function SupervisedReleaseScreen() {
  const facility = useOperatingFacility();
  return (
    <section aria-labelledby="release-title">
      <h2 id="release-title">Supervised release</h2>
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
  const [from, setFrom] = useState(ON_SITE);
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
      ) : (
        <ReleasePanel key={ON_SITE} facilityId={facilityId} timezone={timezone} />
      )}
    </>
  );
}
