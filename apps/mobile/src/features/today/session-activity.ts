/**
 * Builds the SCR-C-04 card model for a program session or a session booking (SPK-UX-004) from what
 * the API exposes to a customer:
 *
 * - the family calendar item or the detail route's ids (participant, offering, session, times);
 * - `GET /v1/offerings/{id}` (public: name, location label) and `GET /v1/offerings/{id}/sessions`
 *   (public: the session's status, cancel reason and scheduling event);
 * - `GET /v1/enrollments/{id}`, its last operation and its placement request, to tell
 *   "Payment processing", "Awaiting placement" and "Confirmed" apart (journeys.md section 3);
 * - the newest schedule notice about the session's scheduling event, for old and new details and
 *   the facility's time zone (SPK-COMMS-005, SPK-SCHED-008);
 * - the facility the calendar item or offering names (`GET /v1/facilities/{id}`, K-04): its name
 *   for "Where" and its IANA zone, so times are on the facility clock even without a notice
 *   (the calendar item's own `timezone` comes first).
 *
 * Every read is answered by the API under its own authorization; a read the person may not make
 * simply leaves that part out (the API answers NOT_FOUND and nothing is inferred from it).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import type { ActivityCardModel } from './NextActivityCard';
import { latestChangeForEvent } from './notices';
import { useFacility, useInbox, useSignedIn } from './queries';
import { bookingStatus, calendarItemStatus, checkoutStateOf, enrollmentStatus } from './status';
import { zoneOf } from './time';

type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;

/** What identifies one session for one participant: a calendar item has exactly these fields. */
export type SessionRef = Pick<
  FamilyCalendarItem,
  | 'kind'
  | 'personId'
  | 'offeringId'
  | 'sessionId'
  | 'enrollmentId'
  | 'sessionBookingId'
  | 'title'
  | 'start'
  | 'end'
  | 'status'
> &
  Partial<Pick<FamilyCalendarItem, 'facilityId' | 'timezone'>>;

/** The detail route for a calendar item (opaque ids only, never names, §4.14); null without a session. */
export function sessionHref(
  ref: Pick<SessionRef, 'sessionId' | 'enrollmentId' | 'sessionBookingId'>,
): { pathname: '/sessions/[sessionId]'; params: Record<string, string> } | null {
  if (!ref.sessionId) return null;
  const params: Record<string, string> = { sessionId: ref.sessionId };
  if (ref.sessionBookingId) params.bookingId = ref.sessionBookingId;
  else if (ref.enrollmentId) params.enrollmentId = ref.enrollmentId;
  else return null;
  return { pathname: '/sessions/[sessionId]', params };
}

export interface SessionActivity {
  model: ActivityCardModel | null;
  /** The offering's sessions read (public), for screens that need its state. */
  sessionsRead: ReturnType<typeof useApiQuery<'/offerings/{id}/sessions'>>;
  offering: Schema<'Offering'> | undefined;
  session: Schema<'OfferingSession'> | undefined;
  enrollment: Schema<'Enrollment'> | undefined;
}

export function useSessionActivity(
  ref: SessionRef | null,
  participant: string,
  options: { sessionBooking?: Schema<'SessionBooking'> } = {},
): SessionActivity {
  const signedIn = useSignedIn();
  const inbox = useInbox();
  const offeringId = ref?.offeringId ?? '';
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    enabled: signedIn && !!ref,
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId } },
    enabled: signedIn && !!ref,
  });
  const enrollment = useApiQuery({
    path: '/enrollments/{id}',
    request: { path: { id: ref?.enrollmentId ?? '' } },
    enabled: signedIn && !!ref?.enrollmentId,
  });
  const e = enrollment.data;
  const operation = useApiQuery({
    path: '/operations/{id}',
    request: { path: { id: e?.lastOperationId ?? '' } },
    enabled: signedIn && e?.status === 'pending' && !!e.lastOperationId,
  });
  // The checkout's state from the linked basket and order (lastOperationId is null while a
  // checkout runs; reported API gap).
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: e?.basketId ?? '' } },
    enabled: signedIn && e?.status === 'pending' && !!e.basketId,
  });
  const order = useApiQuery({
    path: '/orders/{id}',
    request: { path: { id: basket.data?.orderRef ?? '' } },
    enabled: signedIn && e?.status === 'pending' && !!basket.data?.orderRef,
  });
  const placement = useApiQuery({
    path: '/placement-requests/{id}',
    request: { path: { id: e?.placementRequestId ?? '' } },
    enabled: signedIn && e?.status === 'confirmed' && !!e.placementRequestId,
  });
  const assignedEntryId =
    placement.data?.status === 'assigned' ? placement.data.assignedTeamEntryId : null;
  const team = useApiQuery({
    path: '/team-entries/{id}',
    request: { path: { id: assignedEntryId ?? '' } },
    enabled: signedIn && !!assignedEntryId,
  });
  const facility = useFacility(ref ? (ref.facilityId ?? offering.data?.facilityId ?? null) : null);

  if (!ref) {
    return {
      model: null,
      sessionsRead: sessions,
      offering: undefined,
      session: undefined,
      enrollment: e,
    };
  }

  const session = sessions.data?.find((s) => s.id === ref.sessionId);
  const latest = latestChangeForEvent(inbox.data?.items ?? [], session?.schedulingEventId);
  const after = latest?.change.after ?? null;
  const zone = zoneOf(
    after?.timezone,
    latest?.change.before?.timezone,
    ref.timezone,
    facility.data?.timezone,
    offering.data?.facility?.timezone,
  );
  const offeringName = offering.data?.name ?? ref.title;
  const facilityName = facility.data?.name ?? offering.data?.facility?.name ?? null;

  let status: StatusBadgeProps;
  if (session?.status === 'canceled') {
    status = { tone: 'danger', label: 'Canceled' };
  } else if (ref.kind === 'session_booking') {
    status = bookingStatus(options.sessionBooking?.status ?? ref.status);
  } else if (e) {
    status = enrollmentStatus(e, {
      offeringName,
      operation: operation.data ?? null,
      checkout: checkoutStateOf(
        basket.data,
        order.data,
        basket.error !== null || order.error !== null,
        // A read still to answer is "checking", never "payment outstanding" (SPK-PAY-007).
        (e.status === 'pending' && !!e.basketId && basket.data === undefined) ||
          (!!basket.data?.orderRef && order.data === undefined),
      ),
      placement: placement.data ?? null,
      teamName: team.data?.team.name ?? null,
    });
  } else {
    status = calendarItemStatus(ref);
  }

  const fieldNames = after?.resources.map((r) => r.name).join(', ');
  const place = fieldNames || offering.data?.locationLabel || null;
  const model: ActivityCardModel = {
    participant,
    title: offeringName,
    // "Main Park, Pitch 2": the facility, then the pitches a notice names or the offering's label.
    location: [facilityName, place].filter((p): p is string => !!p).join(', ') || null,
    start: session?.scheduledStart ?? (ref.start || null),
    end: session?.scheduledEnd ?? (ref.end || null),
    zone,
    status,
    change: latest?.change ?? null,
    // The API names no outstanding requirement for a session (see the API gaps in the README).
    requiredAction: null,
  };
  return { model, sessionsRead: sessions, offering: offering.data, session, enrollment: e };
}
