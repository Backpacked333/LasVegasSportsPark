/**
 * SCR-S-03 program sessions at the facility in the calendar's window (SPK-SCHED-008, CAT-01
 * `GET /v1/sessions`): the offering, the session's sequence or title, its time in the facility zone
 * the API states with each session, and its state. Cursor pages ("Load more sessions"), so nothing
 * is silently cut off (SPK-UX-008). The read needs catalog.read_catalog at the facility; without it
 * this section says the sessions are not available, and the rest of the calendar is unaffected.
 *
 * A session holds space only through its scheduling event, which the calendar shows on its space.
 * The list says whether a session has one (CAT-05 `schedulingEventId`): a scheduled session
 * without one holds no space, and is marked so the scheduler can book it. Sessions stay listed
 * here, apart from the spaces, and are never used to mark a space busy or free.
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import type { FacilityContext } from '../../features/schedule-facilities/facility-scope';
import { SESSION_BADGE } from '../../features/schedule-facilities/labels';
import { formatRange } from '../../features/schedule-facilities/time';

type FacilitySession = Schema<'FacilitySession'>;

/** Sessions per page (`GET /v1/sessions` takes at most 200). */
const SESSION_PAGE = 100;

const sessionKey = (s: FacilitySession) => s.sessionId;

export function FacilitySessions({
  facility,
  range,
  showCanceled,
}: {
  facility: FacilityContext;
  range: { start: string; end: string };
  showCanceled: boolean;
}) {
  const sessions = useApiPages({
    path: '/sessions',
    request: {
      query: { facilityId: facility.id, from: range.start, to: range.end, limit: SESSION_PAGE },
    },
    keyOf: sessionKey,
  });
  // ACCESS_DENIED or NOT_FOUND: name what is unavailable, without implying anything about it.
  const unavailable =
    sessions.error !== null &&
    (sessions.error.isPermissionRestriction || sessions.error.isNotFound);
  return (
    <section aria-labelledby="facility-sessions-title" data-testid="facility-sessions">
      <h4 id="facility-sessions-title">Program sessions in this range</h4>
      {unavailable ? (
        <StateView
          variant="unavailable"
          description="Program sessions at this facility are not available to you. The spaces above still show every booked event you may see."
        />
      ) : (
        <QueryBoundary
          query={sessions}
          label="program sessions"
          isEmpty={(items) =>
            items.filter((s) => showCanceled || s.status !== 'canceled').length === 0
          }
          empty={{
            title: 'No program sessions in this range',
            description: 'Sessions of programs offered at this facility appear here.',
          }}
          unavailableOffline={['loading more sessions']}
        >
          {(items) => (
            <ul className="list" aria-label="Program sessions">
              {items
                .filter((s) => showCanceled || s.status !== 'canceled')
                .map((s) => {
                  const badge = SESSION_BADGE[s.status];
                  return (
                    <li key={s.sessionId} data-testid={`facility-session-${s.sessionId}`}>
                      <div className="row-text">
                        <span className="row-title">
                          {s.offeringName}: {s.title ?? `session ${s.sequence}`}
                        </span>
                        <span className="caption">
                          {formatRange(s.scheduledStart, s.scheduledEnd, s.timezone)}
                          {s.schedulingEventId
                            ? ' · space booked through its scheduling event'
                            : ''}
                        </span>
                      </div>
                      <StatusBadge tone={badge.tone} label={badge.label} />
                      {!s.schedulingEventId && s.status === 'scheduled' ? (
                        <StatusBadge tone="warning" label="No space booked" />
                      ) : null}
                      <Link to={`/programs/offerings/${s.offeringId}`}>
                        Offering setup for {s.offeringName}
                      </Link>
                    </li>
                  );
                })}
            </ul>
          )}
        </QueryBoundary>
      )}
      <LoadMore pages={sessions} label="sessions" />
    </section>
  );
}
