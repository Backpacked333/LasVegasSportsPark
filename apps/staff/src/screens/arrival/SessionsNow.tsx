/**
 * The desk's side rail on SCR-S-28 (SPK-ENTRY-005, SPK-ENTRY-007, SPK-ENTRY-008, SPK-SCHED-008):
 *
 * - "Sessions now": today's program sessions at the facility that have not ended
 *   (`GET /v1/sessions`, facility zone), each with its observed fill: people recorded present or
 *   late of the expected participants (confirmed enrollments and session bookings, plus anyone
 *   with an observation), from the same reads as the attendance screen. Observed attendance, never
 *   verified occupancy; a read the viewer may not make shows "not available", never a guess.
 *   Each row also names where the session is (the resources its scheduling event reserves, else the
 *   session's or the offering's location) and its configured capacity (CAT-01 session location).
 * - "Supervised release": the sessions ending next, each opening the release screen for that
 *   session (the collector is checked there, online, before anything is recorded).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { activitySearch, attendanceQuery } from '../../features/operations/activity';
import { formatClock } from '../../features/operations/format';
import {
  sessionActivity,
  sessionTitle,
  useTodaySessions,
  type FacilitySession,
} from '../../features/operations/sessions';
import { useApp, useNow } from '../../providers/AppProviders';
import { Icon } from '../../ui/Icon';
import { StateView } from '../../ui/StateView';

const SHOWN = 6;

/** Where a session takes place: reserved resources by name, else the location label. */
export function sessionPlace(session: FacilitySession): string | null {
  // Tolerates a service that predates CAT-01 session locations (no location on the row).
  const location = session.location as FacilitySession['location'] | undefined;
  if (!location) return null;
  const names = location.resources.map((r) => r.name).filter((n): n is string => n !== null);
  if (names.length > 0) return names.join(' + ');
  return location.label;
}

/** The configured capacity of a session: its first unit's limit, written as places. */
export function sessionCapacity(session: FacilitySession): string | null {
  const capacity = session.capacity as FacilitySession['capacity'] | undefined;
  const unit = capacity?.units[0];
  if (!unit) return null;
  return `${unit.limit} ${unit.limit === 1 ? 'place' : 'places'}`;
}

export function SessionsNow({
  facilityId,
  timezone,
  window,
}: {
  facilityId: string;
  timezone: string | null;
  window: { start: string; end: string } | null;
}) {
  const now = useNow(60_000);
  const { online } = useApp();
  const sessions = useTodaySessions({ facilityId, window });
  const remaining = (sessions.data ?? [])
    .filter((s) => new Date(s.scheduledEnd).getTime() > now.getTime())
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
  const endingNext = [...remaining]
    .sort((a, b) => a.scheduledEnd.localeCompare(b.scheduledEnd))
    .slice(0, 4);
  const unavailable =
    sessions.error && (sessions.error.isPermissionRestriction || sessions.error.isNotFound);

  const body = (content: (items: FacilitySession[]) => ReactNode, empty: string) =>
    sessions.data === undefined ? (
      sessions.error ? (
        unavailable ? (
          <p className="caption">Today&rsquo;s sessions are not available to you.</p>
        ) : (
          <StateView
            variant="error"
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
          />
        )
      ) : (
        <StateView variant="loading" label="today's sessions" />
      )
    ) : remaining.length === 0 ? (
      <p className="caption">{empty}</p>
    ) : (
      content(remaining)
    );

  return (
    <>
      <section className="card card-flush" aria-labelledby="sessions-now-title">
        <div className="card-head">
          <h3 id="sessions-now-title">Sessions now</h3>
          <span className="caption">Present / expected</span>
        </div>
        <div className="card-body">
          {body(
            (items) => (
              <ul className="ops-link-list" aria-label="Sessions now and next">
                {items.slice(0, SHOWN).map((s) => (
                  <SessionFillRow key={s.sessionId} session={s} timezone={timezone} now={now} />
                ))}
              </ul>
            ),
            'No more program sessions at this facility today.',
          )}
          {remaining.length > SHOWN ? (
            <Link to="/arrival/attendance" className="caption">
              All {remaining.length} sessions still to run today
            </Link>
          ) : null}
        </div>
        <div className="card-foot">Observed attendance, not verified occupancy.</div>
      </section>
      <section className="card card-flush" aria-labelledby="release-next-title">
        <div className="card-head">
          <h3 id="release-next-title">Supervised release</h3>
        </div>
        <div className="card-body">
          {body(
            () => (
              <ul className="ops-link-list" aria-label="Sessions ending next">
                {endingNext.map((s) => (
                  <li key={s.sessionId}>
                    <Link
                      className="ops-link-row release-next-row"
                      to={`/arrival/release?session=${encodeURIComponent(s.sessionId)}`}
                    >
                      <span className="ops-time">
                        {formatClock(s.scheduledEnd, s.timezone ?? timezone)}
                      </span>
                      <span className="row-text">
                        <span className="row-title">{sessionTitle(s)}</span>
                        <span className="caption">Ends · release children from this session</span>
                      </span>
                      <Icon name="chevron_right" />
                    </Link>
                  </li>
                ))}
              </ul>
            ),
            'No session ends later today.',
          )}
          <Link to="/arrival/release" className="caption">
            Release a child on site without a session
          </Link>
        </div>
        <div className="card-foot">
          Only an adult with current pickup authority can collect.{' '}
          {online ? 'Authority is checked online at release.' : 'Release needs a connection.'}
        </div>
      </section>
    </>
  );
}

function SessionFillRow({
  session,
  timezone,
  now,
}: {
  session: FacilitySession;
  timezone: string | null;
  now: Date;
}) {
  const activity = sessionActivity(session);
  const zone = session.timezone ?? timezone;
  // The same reads (and cache entries) as the attendance screen's panel.
  const attendance = useApiQuery({
    path: '/attendance',
    request: { query: attendanceQuery(activity) },
  });
  const enrollments = useApiQuery({
    path: '/enrollments',
    request: { query: { offeringId: session.offeringId, status: 'confirmed', limit: 200 } },
  });
  const bookings = useApiQuery({
    path: '/session-bookings',
    request: { query: { sessionId: session.sessionId, status: 'confirmed' } },
  });
  const expected = new Set<string>();
  for (const p of attendance.data?.people ?? []) expected.add(p.personId);
  for (const e of enrollments.data?.items ?? []) expected.add(e.participantPersonId);
  for (const b of bookings.data ?? []) if (b) expected.add(b.participantPersonId);
  const present = (attendance.data?.people ?? []).filter(
    (p) => p.effectiveState === 'present' || p.effectiveState === 'late',
  ).length;
  const more = Boolean(enrollments.data?.nextCursor);
  const known = attendance.data !== undefined;
  const started = new Date(session.scheduledStart).getTime() <= now.getTime();
  const pct = expected.size > 0 ? Math.min(100, Math.round((present / expected.size) * 100)) : 0;
  const place = sessionPlace(session);
  const capacity = sessionCapacity(session);
  return (
    <li>
      <Link
        className="ops-link-row fill-row"
        to={`/arrival/attendance${activitySearch(activity)}`}
        data-live={started}
      >
        <span className="ops-time">{formatClock(session.scheduledStart, zone)}</span>
        <span className="row-text">
          <span className="row-title">{sessionTitle(session)}</span>
          {known ? (
            <span className="fill-bar" aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
          ) : null}
          <span className="caption">
            {started ? 'In progress' : 'Starts'} · until {formatClock(session.scheduledEnd, zone)}
          </span>
          {place || capacity ? (
            <span className="caption session-place">
              {place ? (
                <>
                  <Icon name="location_on" size={14} />
                  {place}
                </>
              ) : null}
              {place && capacity ? ' · ' : null}
              {capacity}
            </span>
          ) : null}
        </span>
        <span className="fill-count">
          {known ? (
            <>
              {present} / {expected.size}
              {more ? '+' : ''}
              <span className="ops-sr"> present of expected</span>
            </>
          ) : attendance.error ? (
            <span className="caption">Not available</span>
          ) : (
            <span className="caption">…</span>
          )}
        </span>
      </Link>
    </li>
  );
}
