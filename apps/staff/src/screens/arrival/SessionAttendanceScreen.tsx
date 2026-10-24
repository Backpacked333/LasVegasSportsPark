/**
 * SCR-S-29 Session attendance and corrections (SPK-ENTRY-005, SPK-ENTRY-008, §4.7 invariant 9,
 * §4.15). The activity comes from the query string (opaque ids, from the scanner, a session link
 * or the workspace); without one, today's scheduled events of the facility are listed to choose
 * from (`GET /v1/events` over the facility-local day from the Today feed).
 *
 * Program sessions cannot be listed here: the API lists sessions only per offering
 * (`GET /v1/offerings/{id}/sessions`), and the expected-arrivals report names a session without
 * its offering, so a session is opened from the arrival scanner or a session link.
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import {
  activityFromSearch,
  activitySearch,
  type ActivityRef,
} from '../../features/operations/activity';
import { ARRIVAL_TABS, AreaTabs } from '../../features/operations/AreaTabs';
import { useOperatingFacility } from '../../features/operations/context';
import { ChooseFacility } from '../../features/operations/feedback';
import { formatRange, humanize } from '../../features/operations/format';
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import { useNow } from '../../providers/AppProviders';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { AttendancePanel } from './AttendancePanel';

export function SessionAttendanceScreen() {
  const [params] = useSearchParams();
  const activity = useMemo(() => activityFromSearch(params), [params]);
  const facility = useOperatingFacility();
  return (
    <section aria-labelledby="attendance-title">
      <h2 id="attendance-title">Session attendance</h2>
      <AreaTabs label="Arrival and attendance screens" tabs={ARRIVAL_TABS} />
      <OfflineQueueStatus />
      {activity ? (
        <>
          <p>
            <Link to="/arrival/attendance">Choose another activity</Link>
          </p>
          <ActivityAttendance
            activity={activity}
            facilityId={facility.facilityId}
            timezone={facility.timezone}
          />
        </>
      ) : !facility.facilityId ? (
        facility.loading ? (
          <StateView variant="loading" label="your facilities" />
        ) : (
          <ChooseFacility purpose="see today's activities" />
        )
      ) : (
        <ActivityPicker
          facilityId={facility.facilityId}
          timezone={facility.timezone}
          window={facility.window}
          ready={facility.feedSettled}
        />
      )}
    </section>
  );
}

function ActivityAttendance({
  activity,
  facilityId,
  timezone,
}: {
  activity: ActivityRef;
  facilityId: string | null;
  timezone: string | null;
}) {
  const event = useApiQuery({
    path: '/events/{id}',
    request: { path: { id: activity.type === 'event' ? activity.eventId : '' } },
    enabled: activity.type === 'event',
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: activity.type === 'session' ? activity.offeringId : '' } },
    enabled: activity.type === 'session',
  });
  const session =
    activity.type === 'session'
      ? sessions.data?.find((s) => s.id === activity.sessionId)
      : undefined;
  const title =
    activity.type === 'event'
      ? (event.data?.title ?? 'this activity')
      : (session?.title ?? 'this session');
  const zone = event.data?.timezone ?? timezone;
  const when = event.data
    ? formatRange(event.data.scheduledStart, event.data.scheduledEnd, zone)
    : session
      ? formatRange(session.scheduledStart, session.scheduledEnd, zone)
      : null;
  return (
    <>
      {when ? <p className="caption">{when}</p> : null}
      <AttendancePanel
        activity={activity}
        facilityId={event.data?.facilityId ?? facilityId}
        timezone={zone}
        title={`Attendance: ${title}`}
      />
    </>
  );
}

function ActivityPicker({
  facilityId,
  timezone,
  window,
  ready,
}: {
  facilityId: string;
  timezone: string | null;
  window: { start: string; end: string } | null;
  ready: boolean;
}) {
  const now = useNow(60_000);
  // Without the Today feed's facility window, fall back to the next 24 hours from now.
  const range = window ?? {
    start: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
    end: new Date(now.getTime() + 22 * 3_600_000).toISOString(),
  };
  const events = useApiQuery({
    path: '/events',
    request: {
      query: { facilityId, start: range.start, end: range.end, status: 'published', limit: 200 },
    },
    enabled: ready,
  });
  return (
    <div className="ops-section">
      <h3>Today’s activities</h3>
      <p className="caption">
        Program sessions open from the arrival scanner or a session link: the service lists sessions
        only per offering.
      </p>
      <QueryBoundary
        query={events}
        label="today's activities"
        isEmpty={(data) =>
          data.items.filter((e) => e.kind !== 'maintenance' && e.kind !== 'block').length === 0
        }
        empty={{
          title: 'No activity in progress',
          description: 'No published activity is scheduled at this facility today.',
        }}
      >
        {(data) => (
          <ul className="list" aria-label="Activities today">
            {data.items
              .filter((e) => e.kind !== 'maintenance' && e.kind !== 'block')
              .map((e) => (
                <li key={e.id}>
                  <div className="row-text">
                    <Link
                      to={`/arrival/attendance${activitySearch({ type: 'event', eventId: e.id })}`}
                    >
                      {e.title}
                    </Link>
                    <span className="caption">
                      {humanize(e.kind)} ·{' '}
                      {formatRange(e.scheduledStart, e.scheduledEnd, e.timezone ?? timezone)}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </QueryBoundary>
    </div>
  );
}
