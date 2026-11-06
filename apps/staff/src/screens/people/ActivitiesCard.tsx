/**
 * SCR-S-20 person record, "Activities" card (SPK-SUPPORT-001, SPK-REG-003, SPK-ENTRY-005): the
 * person's enrollments as a participant, newest first, each with the attendance of its last 8
 * started sessions from `GET /v1/participants/{personId}/activities` (observed attendance as
 * recorded, never inferred; a session under review says so). Roles that may read enrollments but
 * not attendance (the API refuses the combined read) still see the enrollments
 * (`GET /v1/enrollments`), without attendance.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDate } from '../../features/registration-finance/format';
import { ENROLLMENT_STATUS, OFFERING_KIND } from '../../features/registration-finance/labels';
import { StatusBadge } from '../../ui/StatusBadge';
import './activities.css';

type Enrollment = Schema<'Enrollment'>;
type Activity = Schema<'ParticipantActivity'>;
type RecentSession = Activity['recentSessions'][number];

const KIND_SPORT: Partial<Record<string, string>> = {
  camp: 'var(--kind-program)',
  season: 'var(--kind-league)',
  term: 'var(--kind-program)',
  party: 'var(--kind-party)',
  rental: 'var(--kind-rental)',
};

const PAGE = 10;

/** Glyph and words of one session's attendance (SPK-UX-009: never colour alone). */
export function attendanceMark(s: RecentSession): { glyph: string; text: string; tone: string } {
  if (s.sessionStatus === 'canceled') return { glyph: '⊘', text: 'canceled', tone: 'neutral' };
  if (s.conflict) return { glyph: '?', text: 'under review', tone: 'warning' };
  switch (s.attendance) {
    case 'present':
      return { glyph: '✓', text: 'present', tone: 'success' };
    case 'late':
      return { glyph: 'L', text: 'late', tone: 'pending' };
    case 'left_early':
      return { glyph: 'E', text: 'left early', tone: 'pending' };
    case 'absent':
      return { glyph: '✕', text: 'absent', tone: 'danger' };
    default:
      return { glyph: '–', text: 'not recorded', tone: 'neutral' };
  }
}

function RecentAttendance({ activity }: { activity: Activity }) {
  const sessions = activity.recentSessions;
  if (sessions.length === 0) {
    return <span className="caption">No session has taken place yet.</span>;
  }
  const oldestFirst = [...sessions].reverse();
  const summary = activity.attendance;
  return (
    <span className="recent-attendance">
      <span
        className="attendance-marks"
        role="img"
        aria-label={`Last ${sessions.length} sessions, oldest first: ${oldestFirst
          .map((s) => `${formatDate(s.scheduledStart.slice(0, 10))} ${attendanceMark(s).text}`)
          .join(', ')}`}
      >
        {oldestFirst.map((s) => {
          const mark = attendanceMark(s);
          return (
            <span key={s.sessionId} className="attendance-mark" data-tone={mark.tone}>
              {mark.glyph}
            </span>
          );
        })}
      </span>
      {summary ? (
        <span className="caption">
          Attended {summary.attended} of {summary.held} held · {summary.recorded} recorded
        </span>
      ) : (
        <span className="caption">Attendance is not recorded here.</span>
      )}
    </span>
  );
}

function EnrollmentRow({ enrollment, children }: { enrollment: Enrollment; children?: ReactNode }) {
  const e = enrollment;
  return (
    <li>
      <span
        className="activity-strip"
        aria-hidden="true"
        style={{
          ['--sport' as string]: KIND_SPORT[e.offering?.kind ?? ''] ?? 'var(--kind-dropin)',
        }}
      />
      <div className="row-text">
        <span className="row-title">{e.offering?.name ?? 'An offering'}</span>
        {e.offering ? (
          <span className="caption">
            {OFFERING_KIND[e.offering.kind]} · {formatDate(e.offering.startsOn)} to{' '}
            {formatDate(e.offering.endsOn)}
          </span>
        ) : null}
        {children}
      </div>
      <StatusBadge {...ENROLLMENT_STATUS[e.status]} />
    </li>
  );
}

export function ActivitiesCard({ personId }: { personId: string }) {
  const activities = useApiQuery({
    path: '/participants/{personId}/activities',
    request: { path: { personId }, query: { limit: PAGE } },
  });
  // Without the combined read (attendance is entry's record), the enrollments alone.
  const fallback = activities.error !== null && activities.data === undefined;
  const enrollments = useApiQuery({
    path: '/enrollments',
    request: { query: { participantPersonId: personId, limit: PAGE } },
    enabled: fallback,
  });
  const source = fallback ? enrollments : activities;
  let body;
  if (!activities.data && !(fallback && enrollments.data)) {
    const error = fallback ? enrollments.error : null;
    body = (
      <p className="caption">
        {error
          ? presentationForError(error) === 'unavailable'
            ? 'Activities are not available to you.'
            : `Activities could not load (${error.code}).`
          : 'Loading activities…'}
      </p>
    );
  } else if (activities.data) {
    body =
      activities.data.items.length === 0 ? (
        <p className="caption">Not enrolled in any program or league.</p>
      ) : (
        <ul className="list" aria-label="Activities">
          {activities.data.items.map((a) => (
            <EnrollmentRow key={a.enrollment.id} enrollment={a.enrollment}>
              <RecentAttendance activity={a} />
            </EnrollmentRow>
          ))}
        </ul>
      );
  } else {
    const items = enrollments.data?.items ?? [];
    body =
      items.length === 0 ? (
        <p className="caption">Not enrolled in any program or league.</p>
      ) : (
        <ul className="list" aria-label="Activities">
          {items.map((e) => (
            <EnrollmentRow key={e.id} enrollment={e} />
          ))}
        </ul>
      );
  }
  return (
    <section className="card card-flush person-card" aria-labelledby="activities-title">
      <div className="card-head">
        <h4 id="activities-title">Activities</h4>
        {source.data?.nextCursor ? <span className="caption">Latest {PAGE}</span> : null}
      </div>
      {body}
    </section>
  );
}
