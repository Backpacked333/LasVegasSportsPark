/**
 * The arrival desk's right column (staff S 2a, S 3d):
 *
 * - "Sessions now": today's sessions still to run at the facility with their observed fill
 *   (present of expected; `useSessionFill`, the attendance screen's reads). Observed attendance,
 *   never verified occupancy.
 * - "Still expected by 9:00": people expected in the sessions starting within the hour who are not
 *   recorded present yet, by name as the viewer's role may read it (`GET /v1/person-names`). Each
 *   row's menu: "Call parent" opens the family's household record; "Mark not coming" needs a staff
 *   attendance intent for sessions, which the API does not have: shown as proposed and disabled.
 * - "Waiting to sync": the desk's check-ins queued on this device while offline, in the order they
 *   will be sent, and any the API kept for review after sending, in red with the way to fix it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { nameOf, usePersonNames } from '../../../features/operations/context';
import {
  useCheckinsForReview,
  useQueuedCheckins,
} from '../../../features/operations/offline/deskCheckins';
import {
  sessionTitle,
  useTodaySessions,
  type FacilitySession,
} from '../../../features/operations/sessions';
import { useNow } from '../../../providers/AppProviders';
import { Icon } from '../../../ui/Icon';
import { sessionPlace, useSessionFill } from '../SessionsNow';
import { DeskAvatar } from './DeskAvatar';
import { deskClock, rememberedName } from './deskModel';

const SHOWN_SESSIONS = 4;
const SHOWN_EXPECTED = 3;
const HOUR_MS = 3_600_000;

export function DeskSessionsNow({
  facilityId,
  timezone,
  window,
}: {
  facilityId: string;
  timezone: string | null;
  window: { start: string; end: string } | null;
}) {
  const now = useNow(60_000);
  const sessions = useTodaySessions({ facilityId, window });
  const remaining = (sessions.data ?? [])
    .filter((s) => new Date(s.scheduledEnd).getTime() > now.getTime())
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
  const soon = remaining.filter(
    (s) => new Date(s.scheduledStart).getTime() <= now.getTime() + HOUR_MS,
  );
  return (
    <>
      <section className="desk-card desk-side-card" aria-labelledby="desk-sessions-title">
        <h2 id="desk-sessions-title">Sessions now</h2>
        {sessions.data === undefined ? (
          sessions.error ? (
            <p className="caption">
              Today&rsquo;s sessions could not load. Code {sessions.error.code}.
            </p>
          ) : (
            <ul className="desk-sessions" aria-busy="true" aria-label="Loading sessions">
              {[0, 1, 2].map((i) => (
                <li key={i} className="desk-skeleton-row" />
              ))}
            </ul>
          )
        ) : remaining.length === 0 ? (
          <p className="caption">No more sessions at this facility today.</p>
        ) : (
          <ul className="desk-sessions" aria-label="Sessions now and next">
            {remaining.slice(0, SHOWN_SESSIONS).map((s) => (
              <SessionFill key={s.sessionId} session={s} timezone={timezone} />
            ))}
          </ul>
        )}
      </section>
      {soon.length > 0 ? <StillExpected sessions={soon} timezone={timezone} /> : null}
    </>
  );
}

function SessionFill({ session, timezone }: { session: FacilitySession; timezone: string | null }) {
  const fill = useSessionFill(session);
  const place = sessionPlace(session);
  const zone = session.timezone ?? timezone;
  return (
    <li className="desk-session">
      <span className="desk-session-head">
        <b>{sessionTitle(session)}</b>
        <span className="desk-session-count">
          {fill.known ? (
            <>
              {fill.present}
              <span>/{fill.expected.size}</span>
              <span className="ops-sr"> present of expected</span>
            </>
          ) : fill.error ? (
            <span className="caption">Not available</span>
          ) : (
            <span className="caption">…</span>
          )}
        </span>
      </span>
      <span className="caption">
        {deskClock(session.scheduledStart, zone)}
        {place ? ` · ${place}` : ''}
      </span>
      <span className="desk-fill" aria-hidden="true">
        <i style={{ width: `${fill.pct}%` }} />
      </span>
    </li>
  );
}

/** People expected in the next hour's sessions and not recorded present yet. */
function StillExpected({
  sessions,
  timezone,
}: {
  sessions: FacilitySession[];
  timezone: string | null;
}) {
  const first = sessions[0] as FacilitySession;
  return (
    <section className="desk-card desk-side-card" aria-labelledby="desk-expected-title">
      <h2 id="desk-expected-title">
        Still expected by {deskClock(first.scheduledStart, first.timezone ?? timezone)}
      </h2>
      <ExpectedList sessions={sessions} />
    </section>
  );
}

function ExpectedList({ sessions }: { sessions: FacilitySession[] }) {
  // Each session's fill is read by its own probe (a fixed set of hooks per component), which
  // reports who is still waiting; the list is put together here.
  const [waiting, setWaiting] = useState<Record<string, string[] | null>>({});
  const shown = sessions.slice(0, 6);
  const report = useCallback((sessionId: string, ids: string[] | null) => {
    setWaiting((prev) => {
      const before = prev[sessionId];
      if (before !== undefined && (before?.join(',') ?? null) === (ids?.join(',') ?? null)) {
        return prev;
      }
      return { ...prev, [sessionId]: ids };
    });
  }, []);
  const rows = shown.flatMap((session) =>
    (waiting[session.sessionId] ?? []).map((personId) => ({ personId, session })),
  );
  const names = usePersonNames(rows.slice(0, SHOWN_EXPECTED).map((r) => r.personId));
  const loading = shown.some((s) => waiting[s.sessionId] === undefined);
  return (
    <>
      {shown.map((s) => (
        <FillProbe key={s.sessionId} session={s} report={report} />
      ))}
      {loading && rows.length === 0 ? (
        <ul className="desk-expected" aria-busy="true" aria-label="Loading expected people">
          {[0, 1, 2].map((i) => (
            <li key={i} className="desk-skeleton-row" />
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <p className="caption">Everyone expected in the next hour is here.</p>
      ) : (
        <ul className="desk-expected" aria-label="Still expected">
          {rows.slice(0, SHOWN_EXPECTED).map((r) => (
            <ExpectedRow
              key={`${r.session.sessionId}|${r.personId}`}
              personId={r.personId}
              name={nameOf(names, r.personId)}
              session={r.session}
            />
          ))}
        </ul>
      )}
      {rows.length > SHOWN_EXPECTED ? (
        <Link className="desk-more" to="/arrival/attendance">
          + {rows.length - SHOWN_EXPECTED} more
        </Link>
      ) : null}
    </>
  );
}

/** Reads one session's fill and reports who is still waiting (null when it cannot be read). */
function FillProbe({
  session,
  report,
}: {
  session: FacilitySession;
  report: (sessionId: string, waiting: string[] | null) => void;
}) {
  const fill = useSessionFill(session);
  const key = fill.known ? fill.waiting.join(',') : fill.error ? '!' : null;
  useEffect(() => {
    if (key === null) return;
    report(session.sessionId, key === '!' ? null : key ? key.split(',') : []);
  }, [key, report, session.sessionId]);
  return null;
}

function ExpectedRow({
  personId,
  name,
  session,
}: {
  personId: string;
  name: string;
  session: FacilitySession;
}) {
  const [open, setOpen] = useState(false);
  const menuId = `expected-menu-${personId}-${session.sessionId}`;
  return (
    <li className="desk-expected-row">
      <DeskAvatar personId={personId} name={name} size={30} />
      <span className="desk-expected-text">
        <b>{name}</b> · {session.offeringName}
      </span>
      <span className="desk-expected-state">Not here yet</span>
      <button
        type="button"
        className="desk-icon-button"
        aria-label={`More for ${name}`}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more_horiz" />
      </button>
      {open ? (
        <ul className="desk-menu" id={menuId} aria-label={`Actions for ${name}`}>
          <li>
            <button
              type="button"
              disabled
              aria-describedby={`${menuId}-proposed`}
              title="Staff can't record that someone isn't coming yet (proposed)."
            >
              Mark not coming{' '}
              <span className="desk-proposed" id={`${menuId}-proposed`}>
                ◷ Proposed
              </span>
            </button>
          </li>
          <li>
            <Link to={`/people/${personId}/household`}>Call parent</Link>
          </li>
        </ul>
      ) : null}
    </li>
  );
}

/** The desk check-ins waiting on this device (S 3d), and any kept for review after sending. */
export function WaitingToSync({ timezone }: { timezone: string | null }) {
  const queued = useQueuedCheckins();
  const review = useCheckinsForReview();
  const ids = [...queued, ...review.map((r) => r.queued)].map((q) =>
    q.item.kind === 'attendance' ? q.item.personId : '',
  );
  const unknown = ids.filter((id) => id && rememberedName(id) === null);
  const names = usePersonNames(unknown, unknown.length > 0);
  const label = (personId: string) => rememberedName(personId) ?? nameOf(names, personId);
  if (queued.length === 0 && review.length === 0) return null;
  return (
    <section className="desk-card desk-side-card" aria-labelledby="desk-sync-title">
      <h2 id="desk-sync-title">Waiting to sync</h2>
      <ol
        className="desk-sync-list"
        aria-label="Check-ins waiting to sync, in the order they are sent"
      >
        {queued.map((q) =>
          q.item.kind === 'attendance' ? (
            <li key={q.item.clientObservationId} className="desk-sync-row">
              <DeskAvatar personId={q.item.personId} name={label(q.item.personId)} size={30} />
              <span className="desk-sync-text">
                <b>{label(q.item.personId)}</b> · check-in
              </span>
              <span className="desk-sync-time">
                <Icon name="schedule" size={14} />
                {deskClock(q.queuedAt, timezone, true)}
              </span>
            </li>
          ) : null,
        )}
        {review.map((r) =>
          r.queued.item.kind === 'attendance' ? (
            <li
              key={r.queued.item.clientObservationId}
              className="desk-sync-row"
              data-tone="danger"
            >
              <DeskAvatar
                personId={r.queued.item.personId}
                name={label(r.queued.item.personId)}
                size={30}
              />
              <span className="desk-sync-text">
                <b>{label(r.queued.item.personId)}</b> · ✕ not checked in
                <span className="caption">{r.reason ?? r.code ?? 'Refused by the service.'}</span>
              </span>
              <Link to="/arrival/offline" className="desk-sync-fix">
                Fix
              </Link>
            </li>
          ) : null,
        )}
      </ol>
      <p className="caption">
        Sent in this order when back online. If one is refused (for example a form expired
        meanwhile), it shows here in red with a fix.
      </p>
    </section>
  );
}
