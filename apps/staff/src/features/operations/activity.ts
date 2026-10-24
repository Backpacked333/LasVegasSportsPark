/**
 * The activity an entry record concerns: a catalog session (offering + session) or a scheduling
 * event (SPK-ENTRY-001, `ActivityRef` in the entry contract). Activities travel between screens as
 * opaque ids in the query string, never names or personal data (§4.14).
 */
import type { Schema } from '@sportspark/api-client';

export type ActivityRef = Schema<'ActivityRef'>;
export type ActivityDetail = Schema<'ActivityDetail'>;
type Assignment = Schema<'Assignment'>;

export function activityFromDetail(detail: ActivityDetail): ActivityRef | null {
  if (detail.type === 'session') {
    return detail.offeringId && detail.sessionId
      ? { type: 'session', offeringId: detail.offeringId, sessionId: detail.sessionId }
      : null;
  }
  return { type: 'event', eventId: detail.eventId ?? detail.id };
}

/**
 * The entry activity of an assignment: a session target, a scheduling event target, or the
 * scheduling event behind a fixture.
 */
export function activityFromAssignment(a: Assignment): ActivityRef | null {
  if (a.targetType === 'session') {
    return a.offeringId
      ? { type: 'session', offeringId: a.offeringId, sessionId: a.targetId }
      : null;
  }
  if (a.targetType === 'event') return { type: 'event', eventId: a.targetId };
  return a.schedulingEventId ? { type: 'event', eventId: a.schedulingEventId } : null;
}

export function activitySearch(ref: ActivityRef): string {
  const params = new URLSearchParams(
    ref.type === 'session'
      ? { type: 'session', offeringId: ref.offeringId, sessionId: ref.sessionId }
      : { type: 'event', eventId: ref.eventId },
  );
  return `?${params.toString()}`;
}

export function activityFromSearch(params: URLSearchParams): ActivityRef | null {
  const type = params.get('type');
  if (type === 'session') {
    const offeringId = params.get('offeringId');
    const sessionId = params.get('sessionId');
    return offeringId && sessionId ? { type: 'session', offeringId, sessionId } : null;
  }
  if (type === 'event') {
    const eventId = params.get('eventId');
    return eventId ? { type: 'event', eventId } : null;
  }
  return null;
}

/** `GET /v1/attendance` query for an activity. */
export function attendanceQuery(ref: ActivityRef) {
  return ref.type === 'session'
    ? { activityType: 'session' as const, activityId: ref.sessionId, offeringId: ref.offeringId }
    : { activityType: 'event' as const, activityId: ref.eventId };
}

export function activityKey(ref: ActivityRef): string {
  return ref.type === 'session'
    ? `session:${ref.offeringId}:${ref.sessionId}`
    : `event:${ref.eventId}`;
}

export function sameActivity(a: ActivityRef, b: ActivityRef): boolean {
  return activityKey(a) === activityKey(b);
}
