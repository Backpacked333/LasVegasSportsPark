/**
 * The readiness checks of one start in the next hour (S 1a strip, S 3a drawer), composed from the
 * per-check reads the API already has; no new read was added (BUILD_PLAN Phase 4, "prefer
 * composing existing reads"):
 *
 * - a league game (`sourceType` fixture): `GET /v1/fixtures/{id}/readiness` (officials, field,
 *   rosters, forms) with the referee's name from `GET /v1/events/{id}/detail`;
 * - a class session (`sourceType` offering): the coach from the event detail, places from the
 *   detail's attendee count and the session's capacity (`GET /v1/sessions`), and waivers from the
 *   offering's required waivers (`GET /v1/offerings/{id}/required-waivers`), the session's
 *   expected participants (`GET /v1/attendance`) and each one's waivers
 *   (`GET /v1/people/{id}/waivers`, at most `WAIVER_READS` people);
 * - a rental or party booked through the booking flow (`sourceType` enrollment.booking):
 *   `GET /v1/bookings/{id}` (payment outstanding, guests) and, for a rental,
 *   `GET /v1/bookings/{id}/roster` (joined members and waivers outstanding);
 * - the field: the space's restrictions from `GET /v1/facilities/{id}/operating-status` and, for a
 *   pitch or its half, the field crew's preparation of the day (`GET /v1/field-preparations`,
 *   Phase 8 "Field crew · Fields"): "Field ready" only once the crew marked the pitch ready; not
 *   ready is a warning, and a danger from 15 minutes before the start. A viewer who may not read
 *   the preparations keeps the restriction-only check.
 *
 * A check the viewer may not read, or that did not answer, is "unknown" (◷), never ready
 * (SPK-READY-002). Status is glyph + words; the tone only repeats it.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useApi, useNow } from '../../providers/AppProviders';
import type { StatusTone } from '../../ui/StatusBadge';
import { preparationForEvent, type FieldPreparationState } from './field-readiness';
import { shortName, type ResourceStatus, type ScheduledEvent } from './today-model';

export type CheckKey =
  | 'referee'
  | 'coach'
  | 'field'
  | 'rosters'
  | 'forms'
  | 'waivers'
  | 'places'
  | 'paid'
  | 'roster'
  | 'host';
export type FixKind = 'referee' | 'waivers' | 'field' | 'forms' | 'rosters' | 'payment';

export interface StartCheck {
  key: CheckKey;
  tone: StatusTone;
  label: string;
  /** The drawer's short heading for the check ("Referee", "Forms", "Field"). */
  heading: string;
  /** The drawer's short value ("None", "All signed", "Ready"). */
  value: string;
  /** What a click on the failed check opens. */
  fix?: FixKind;
}

export interface MissingWaiver {
  personId: string;
  name: string;
}

export interface StartChecks {
  checks: StartCheck[];
  loading: boolean;
  /** Children of a session without a current required waiver (for the issue and the drawer). */
  missingWaivers: MissingWaiver[];
  /** The fixture's referee requirement, when the API names it (for candidates). */
  requirementId: string | null;
  /** The offered-then-declined or uncovered official assignment, for its replacements read. */
  sessionId: string | null;
  offeringId: string | null;
  bookingId: string | null;
  fixtureId: string | null;
}

/** People of a session whose waivers are read for the strip (bounded: §4.5 bounded reads). */
export const WAIVER_READS = 30;

export type EventDetail = Schema<'EventDetail'>;
type FixtureReadiness = Schema<'FixtureReadiness'>;
type FacilitySession = Schema<'FacilitySession'>;

const failed = (tone: StatusTone) => tone === 'danger' || tone === 'warning';

export function isFailed(check: StartCheck): boolean {
  return failed(check.tone);
}

export function hasBlocking(checks: readonly StartCheck[]): boolean {
  return checks.some((c) => c.tone === 'danger');
}

function readinessTone(status: FixtureReadiness['status'] | undefined): StatusTone {
  if (status === 'ready') return 'success';
  if (status === 'warning') return 'warning';
  if (status === 'blocked') return 'danger';
  return 'pending';
}

function check(readiness: FixtureReadiness | undefined, name: string) {
  return readiness?.checks.find((c) => c.name === name || c.name.endsWith(`.${name}`));
}

/** Game checks from the fixture's readiness and the event detail's accepted official. */
export function gameChecks(
  readiness: FixtureReadiness | undefined,
  detail: EventDetail | undefined,
  field: ResourceFieldState,
): StartCheck[] {
  const out: StartCheck[] = [];
  const officials = check(readiness, 'required_officials') ?? check(readiness, 'officials');
  const official = detail?.staff.assignments.find(
    (a) => a.kind === 'official' && (a.status === 'accepted' || a.status === 'completed'),
  );
  if (!readiness) {
    out.push({
      key: 'referee',
      tone: 'pending',
      label: 'Referee unknown',
      heading: 'Referee',
      value: 'Unknown',
    });
  } else if (officials && officials.status === 'blocked') {
    out.push({
      key: 'referee',
      tone: 'danger',
      label: 'No referee',
      heading: 'Referee',
      value: 'None',
      fix: 'referee',
    });
  } else if (officials && officials.status !== 'ready') {
    out.push({
      key: 'referee',
      tone: readinessTone(officials.status),
      label: 'Referee not confirmed',
      heading: 'Referee',
      value: 'Not confirmed',
      fix: 'referee',
    });
  } else {
    const name = shortName(official?.displayName);
    out.push({
      key: 'referee',
      tone: 'success',
      label: name ? `Referee: ${name}` : 'Referee confirmed',
      heading: 'Referee',
      value: name || 'Confirmed',
    });
  }
  out.push(fieldCheck(field, check(readiness, 'field')?.status));
  const rosters = check(readiness, 'rosters');
  const sides = readiness?.sides ?? [];
  const sizes = sides.map((s) => s.rosterSize).join(' / ');
  if (rosters) {
    const tone = readinessTone(rosters.status);
    out.push({
      key: 'rosters',
      tone,
      label:
        tone === 'success'
          ? `Rosters ${sizes}`
          : tone === 'danger'
            ? 'Short of players'
            : `Rosters ${sizes}`,
      heading: 'Rosters',
      value: sizes || (tone === 'success' ? 'Ready' : 'Short'),
      ...(tone === 'success' ? {} : { fix: 'rosters' as const }),
    });
  }
  const forms = check(readiness, 'forms');
  if (forms) {
    const tone = readinessTone(forms.status);
    out.push({
      key: 'forms',
      tone,
      label:
        tone === 'success'
          ? 'Forms signed'
          : `${forms.issueCount} ${forms.issueCount === 1 ? 'form' : 'forms'} missing`,
      heading: 'Forms',
      value: tone === 'success' ? 'All signed' : `${forms.issueCount} missing`,
      ...(tone === 'success' ? {} : { fix: 'forms' as const }),
    });
  }
  return out;
}

export interface ResourceFieldState {
  /** Restrictions on the event's spaces now ('closed' or 'limited'), with their reason. */
  restrictions: Array<{ kind: 'closed' | 'limited'; reason: string }>;
  known: boolean;
  /** The crew's preparation of the pitch the event uses (null: not a pitch, or not readable). */
  preparation?: FieldPreparationState | null;
}

export function fieldStateOf(
  event: Pick<ScheduledEvent, 'resourceIds'>,
  resources: readonly ResourceStatus[] | undefined,
): ResourceFieldState {
  if (!resources) return { restrictions: [], known: false };
  const mine = resources.filter((r) => event.resourceIds.includes(r.resourceId));
  return {
    known: true,
    restrictions: mine.flatMap((r) =>
      r.restrictions.map((x) => ({ kind: x.kind, reason: x.reason })),
    ),
  };
}

function fieldCheck(field: ResourceFieldState, readiness?: FixtureReadiness['status']): StartCheck {
  const closed = field.restrictions.find((r) => r.kind === 'closed');
  const limited = field.restrictions.find((r) => r.kind === 'limited');
  if (closed || readiness === 'blocked') {
    return {
      key: 'field',
      tone: 'danger',
      label: 'Field closed',
      heading: 'Field',
      value: closed ? `Closed: ${closed.reason}` : 'Closed',
      fix: 'field',
    };
  }
  if (limited || readiness === 'warning') {
    return {
      key: 'field',
      tone: 'warning',
      label: 'Field restricted',
      heading: 'Field',
      value: limited ? limited.reason : 'Restricted',
      fix: 'field',
    };
  }
  const prep = field.preparation;
  if (prep && !prep.progress.ready) {
    return {
      key: 'field',
      tone: prep.urgent ? 'danger' : 'warning',
      label: 'Field not ready',
      heading: 'Field',
      value: `Not ready · ${prep.progress.done} of ${prep.progress.total} checks`,
      fix: 'field',
    };
  }
  if (!field.known && !readiness) {
    return {
      key: 'field',
      tone: 'pending',
      label: 'Field unknown',
      heading: 'Field',
      value: 'Unknown',
    };
  }
  return {
    key: 'field',
    tone: 'success',
    label: 'Field ready',
    heading: 'Field',
    value: prep ? 'Lined, nets up' : 'Ready',
  };
}

function capacityOf(session: FacilitySession | undefined): number | null {
  const unit = session?.capacity.units.find(
    (u) => u.unit === 'seats' || u.unit === 'session_seats' || u.unit === 'camp_group_places',
  );
  return unit ? unit.limit : null;
}

/** Session checks: coach, waivers, places. */
export function sessionChecks(
  detail: EventDetail | undefined,
  session: FacilitySession | undefined,
  waivers: { required: boolean; missing: MissingWaiver[]; loading: boolean; known: boolean },
  coachUncovered: boolean,
): StartCheck[] {
  const out: StartCheck[] = [];
  const coach = detail?.staff.assignments.find(
    (a) => a.kind === 'coach' && (a.status === 'accepted' || a.status === 'completed'),
  );
  if (coachUncovered) {
    out.push({
      key: 'coach',
      tone: 'danger',
      label: 'No coach',
      heading: 'Coach',
      value: 'None',
      fix: 'referee',
    });
  } else if (coach) {
    const name = shortName(coach.displayName);
    out.push({
      key: 'coach',
      tone: 'success',
      label: name ? `Coach: ${name}` : 'Coach confirmed',
      heading: 'Coach',
      value: name || 'Confirmed',
    });
  } else if (detail && (detail.committedPeople.find((c) => c.role === 'coach')?.count ?? 0) > 0) {
    out.push({
      key: 'coach',
      tone: 'success',
      label: 'Coach booked',
      heading: 'Coach',
      value: 'Booked',
    });
  }
  if (waivers.required) {
    const n = waivers.missing.length;
    if (!waivers.known) {
      out.push({
        key: 'waivers',
        tone: 'pending',
        label: waivers.loading ? 'Checking waivers' : 'Waivers unknown',
        heading: 'Forms',
        value: 'Unknown',
      });
    } else if (n > 0) {
      out.push({
        key: 'waivers',
        tone: 'warning',
        label: `${n} ${n === 1 ? 'waiver' : 'waivers'} missing`,
        heading: 'Forms',
        value: `${n} missing`,
        fix: 'waivers',
      });
    } else {
      out.push({
        key: 'waivers',
        tone: 'success',
        label: 'Waivers signed',
        heading: 'Forms',
        value: 'All signed',
      });
    }
  }
  const capacity = capacityOf(session);
  if (detail) {
    const total = detail.attendees.total;
    out.push({
      key: 'places',
      tone: capacity !== null && total > capacity ? 'warning' : 'success',
      label: capacity !== null ? `${total} / ${capacity} places` : `${total} expected`,
      heading: 'Places',
      value: capacity !== null ? `${total} / ${capacity}` : String(total),
    });
  }
  return out;
}

/** Rental and party checks from the booking (and a rental's roster). */
export function bookingChecks(
  event: Pick<ScheduledEvent, 'kind'>,
  booking: Schema<'Booking'> | undefined,
  roster: Schema<'BookingRoster'> | undefined,
  hostName: string | null,
): StartCheck[] {
  const out: StartCheck[] = [];
  if (!booking) return out;
  const owes = booking.outstanding.includes('payment');
  out.push(
    owes
      ? {
          key: 'paid',
          tone: 'warning',
          label: 'Payment due',
          heading: 'Payment',
          value: 'Due',
          fix: 'payment',
        }
      : { key: 'paid', tone: 'success', label: 'Paid in full', heading: 'Payment', value: 'Paid' },
  );
  if (event.kind === 'party' && hostName) {
    out.push({
      key: 'host',
      tone: 'success',
      label: `Host: ${shortName(hostName)}`,
      heading: 'Host',
      value: shortName(hostName),
    });
  }
  if (roster && roster.waiver.state === 'evaluated') {
    const joined = roster.counts.joined;
    const of = booking.guestCount ?? joined + roster.counts.invited;
    out.push({
      key: 'roster',
      tone: 'success',
      label: `Roster ${joined} / ${of}`,
      heading: 'Roster',
      value: `${joined} / ${of}`,
    });
    if (roster.counts.waiverOutstanding > 0) {
      const n = roster.counts.waiverOutstanding;
      out.push({
        key: 'waivers',
        tone: 'warning',
        label: `${n} ${n === 1 ? 'waiver' : 'waivers'} missing`,
        heading: 'Forms',
        value: `${n} missing`,
        fix: 'waivers',
      });
    }
  }
  return out;
}

/** "League · 7v7", "Program", "Rental · 2 h", "Party · 24 guests". */
export function kindLine(event: ScheduledEvent, booking?: Schema<'Booking'>): string {
  const hours =
    (new Date(event.scheduledEnd).getTime() - new Date(event.scheduledStart).getTime()) / 3_600_000;
  const duration = Number.isInteger(hours) ? `${hours} h` : `${Math.round(hours * 60)} min`;
  switch (event.kind) {
    case 'game':
      return event.format ? `League · ${event.format}` : 'League';
    case 'practice':
      return 'Practice';
    case 'session':
      return 'Program';
    case 'rental':
      return `Rental · ${duration}`;
    case 'party':
      return booking?.guestCount ? `Party · ${booking.guestCount} guests` : 'Party';
    case 'pickup':
      return 'Drop-in';
    default:
      return event.kind;
  }
}

/** All checks of one start, reading what its kind needs. */
export function useStartChecks(
  event: ScheduledEvent,
  context: {
    resources: readonly ResourceStatus[] | undefined;
    sessions: readonly FacilitySession[] | undefined;
    /** An uncovered coach or referee item exists for this event (from the Today feed). */
    uncoveredRoles: ReadonlySet<string>;
    hostName?: string | null;
  },
): StartChecks {
  const api = useApi();
  const isGame = event.sourceType === 'fixture' && !!event.sourceId;
  const isSession = event.kind === 'session' && event.sourceType === 'offering' && !!event.sourceId;
  const isBooking = event.sourceType === 'enrollment.booking' && !!event.sourceId;
  const detail = useApiQuery({
    path: '/events/{id}/detail',
    request: { path: { id: event.id } },
    enabled: isGame || isSession,
  });
  const readiness = useApiQuery({
    path: '/fixtures/{id}/readiness',
    request: { path: { id: event.sourceId ?? '' } },
    enabled: isGame,
  });
  const session = context.sessions?.find((s) => s.schedulingEventId === event.id);
  const offeringId = isSession ? event.sourceId : null;
  const required = useApiQuery({
    path: '/offerings/{id}/required-waivers',
    request: { path: { id: offeringId ?? '' } },
    enabled: !!offeringId,
    staleTime: 5 * 60_000,
  });
  const requiredKeys = useMemo(
    () => new Set((required.data?.waivers ?? []).map((w) => w.policyKey)),
    [required.data],
  );
  const expected = useApiQuery({
    path: '/attendance',
    request: {
      query: {
        activityType: 'session',
        activityId: session?.sessionId ?? '',
        offeringId: offeringId ?? undefined,
      },
    },
    enabled: !!session && requiredKeys.size > 0,
  });
  const people = (expected.data?.expected ?? []).slice(0, WAIVER_READS);
  const waiverReads = useQueries({
    queries: people.map((p) => ({
      queryKey: ['api', '/people/{id}/waivers', { path: { id: p.personId } }],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await api.request('get', '/people/{id}/waivers', { path: { id: p.personId }, signal }))
          .data,
      staleTime: 60_000,
    })),
  });
  const booking = useApiQuery({
    path: '/bookings/{id}',
    request: { path: { id: event.sourceId ?? '' } },
    enabled: isBooking,
  });
  const roster = useApiQuery({
    path: '/bookings/{id}/roster',
    request: { path: { id: event.sourceId ?? '' } },
    enabled: isBooking && event.kind === 'rental',
  });

  const now = useNow(60_000);
  // The day's pitch preparations (one shared read for every start of the facility).
  const preparations = useApiQuery({
    path: '/field-preparations',
    request: { query: { facilityId: event.facilityId } },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const field = {
    ...fieldStateOf(event, context.resources),
    preparation: preparationForEvent(event, context.resources, preparations.data, now),
  };
  const waiversDone = waiverReads.every((q) => q.isSuccess);
  const missingWaivers: MissingWaiver[] = waiversDone
    ? people
        .filter((p, i) => {
          const data = waiverReads[i]?.data as Schema<'PersonWaivers'> | undefined;
          return (data?.waivers ?? []).some(
            (w) => requiredKeys.has(w.policyKey) && w.status !== 'current',
          );
        })
        .map((p) => ({
          personId: p.personId,
          name:
            p.displayName ??
            ([p.givenName, p.familyName].filter(Boolean).join(' ') || 'Participant'),
        }))
    : [];

  let checks: StartCheck[];
  if (isGame) {
    checks = gameChecks(readiness.data, detail.data, field);
  } else if (isSession) {
    checks = sessionChecks(
      detail.data,
      session,
      {
        required: requiredKeys.size > 0,
        missing: missingWaivers,
        loading: expected.isPending || !waiversDone,
        known: expected.isSuccess && waiversDone,
      },
      context.uncoveredRoles.has('coach'),
    );
    checks = [
      checks.find((c) => c.key === 'coach'),
      fieldCheck(field),
      ...checks.filter((c) => c.key !== 'coach'),
    ].filter((c): c is StartCheck => !!c && !(c.key === 'field' && c.tone === 'success'));
  } else if (isBooking) {
    checks = [...bookingChecks(event, booking.data, roster.data, context.hostName ?? null)];
    const f = fieldCheck(field);
    if (f.tone !== 'success') checks.unshift(f);
  } else {
    const f = fieldCheck(field);
    checks = f.tone === 'success' ? [] : [f];
  }
  const loading =
    (isGame && readiness.isPending) ||
    ((isGame || isSession) && detail.isPending) ||
    (isBooking && booking.isPending);
  const requirementId =
    readiness.data?.issues.find((i) => i.source.type === 'assignment_requirement')?.source.id ??
    null;
  return {
    checks,
    loading,
    missingWaivers,
    requirementId,
    sessionId: session?.sessionId ?? null,
    offeringId,
    bookingId: isBooking ? event.sourceId : null,
    fixtureId: isGame ? event.sourceId : null,
  };
}
