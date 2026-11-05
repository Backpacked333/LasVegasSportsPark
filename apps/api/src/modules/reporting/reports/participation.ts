import type { ReportContext } from '../engine/report-definition';

/**
 * Expected participants of the activities at a facility in an interval (MET-004), shared by the
 * expected-arrivals and attendance reports. Sessions expect their offering's confirmed
 * enrollments and the session's confirmed bookings; fixtures expect the active and substitute
 * roster members of both team entries effective at kickoff (SPK-COMP-005). RSVP never removes
 * anyone (SPK-CAP-003). Enrollment and booking states are taken as of the as-of instant from their
 * clock-stamped confirmation, cancellation, transfer and expiry instants.
 */
export interface ExpectedActivity {
  /** `session:<id>` or `event:<scheduling event id>` (the attendance activity identity). */
  key: string;
  activityType: 'session' | 'event';
  activityId: string;
  sourceType: 'session' | 'fixture';
  sourceId: string;
  offeringId: string | null;
  title: string;
  start: Date;
  end: Date;
  expected: Map<string, { kind: 'adult' | 'child'; basis: 'enrollment' | 'booking' | 'roster' }>;
}

export async function loadExpectedActivities(
  ctx: ReportContext,
  window: { start: number; end: number },
): Promise<ExpectedActivity[]> {
  const facility = ctx.facility;
  if (!facility) return [];
  const asOf = ctx.asOf;
  const startAt = new Date(window.start);
  const endAt = new Date(window.end);

  const sessions = await ctx.db
    .selectFrom('reporting_sessions_v as s')
    .innerJoin('reporting_offerings_v as o', (j) =>
      j
        .onRef('o.organization_id', '=', 's.organization_id')
        .onRef('o.offering_id', '=', 's.offering_id'),
    )
    .select([
      's.session_id',
      's.offering_id',
      's.sequence',
      's.scheduled_start',
      's.scheduled_end',
      's.status',
      'o.offering_name',
    ])
    .where('s.organization_id', '=', ctx.organizationId)
    .where('s.facility_id', '=', facility.id)
    .where('s.scheduled_start', '>=', startAt)
    .where('s.scheduled_start', '<', endAt)
    .where('s.status', '<>', 'canceled')
    .orderBy('s.scheduled_start')
    .orderBy('s.session_id')
    .execute();

  const fixtures = await ctx.db
    .selectFrom('reporting_fixtures_v')
    .select([
      'fixture_id',
      'scheduling_event_id',
      'scheduled_start',
      'scheduled_end',
      'home_entry_id',
      'away_entry_id',
      'status',
    ])
    .where('organization_id', '=', ctx.organizationId)
    .where('facility_id', '=', facility.id)
    .where('scheduled_start', '>=', startAt)
    .where('scheduled_start', '<', endAt)
    .where('status', 'in', ['scheduled', 'played'])
    .orderBy('scheduled_start')
    .orderBy('fixture_id')
    .execute();

  const activities: ExpectedActivity[] = [];
  const offeringIds = [...new Set(sessions.map((s) => s.offering_id))];
  const sessionIds = sessions.map((s) => s.session_id);

  const enrollments =
    offeringIds.length === 0
      ? []
      : await ctx.db
          .selectFrom('reporting_enrollments_v')
          .select([
            'offering_id',
            'canonical_person_id',
            'person_kind',
            'confirmed_at',
            'canceled_at',
            'transferred_at',
          ])
          .where('organization_id', '=', ctx.organizationId)
          .where('offering_id', 'in', offeringIds)
          .where('status', 'in', ['confirmed', 'completed', 'canceled', 'transferred'])
          .execute();
  const bookings =
    sessionIds.length === 0
      ? []
      : await ctx.db
          .selectFrom('reporting_session_bookings_v')
          .select([
            'session_id',
            'canonical_person_id',
            'person_kind',
            'confirmed_at',
            'canceled_at',
            'expired_at',
          ])
          .where('organization_id', '=', ctx.organizationId)
          .where('session_id', 'in', sessionIds)
          .execute();

  const heldAt = (confirmedAt: Date | null, endedAt: ReadonlyArray<Date | null>): boolean =>
    confirmedAt !== null &&
    new Date(confirmedAt).getTime() <= asOf.getTime() &&
    endedAt.every((t) => t === null || new Date(t).getTime() > asOf.getTime());

  for (const s of sessions) {
    const expected: ExpectedActivity['expected'] = new Map();
    for (const e of enrollments) {
      if (e.offering_id !== s.offering_id) continue;
      if (!heldAt(e.confirmed_at, [e.canceled_at, e.transferred_at])) continue;
      expected.set(e.canonical_person_id, { kind: e.person_kind, basis: 'enrollment' });
    }
    for (const b of bookings) {
      if (b.session_id !== s.session_id) continue;
      if (!heldAt(b.confirmed_at, [b.canceled_at, b.expired_at])) continue;
      if (!expected.has(b.canonical_person_id)) {
        expected.set(b.canonical_person_id, { kind: b.person_kind, basis: 'booking' });
      }
    }
    activities.push({
      key: `session:${s.session_id}`,
      activityType: 'session',
      activityId: s.session_id,
      sourceType: 'session',
      sourceId: s.session_id,
      offeringId: s.offering_id,
      title: `${s.offering_name} #${s.sequence}`,
      start: new Date(s.scheduled_start),
      end: new Date(s.scheduled_end),
      expected,
    });
  }

  const entryIds = [...new Set(fixtures.flatMap((f) => [f.home_entry_id, f.away_entry_id]))];
  const roster =
    entryIds.length === 0
      ? []
      : await ctx.db
          .selectFrom('reporting_roster_memberships_v')
          .select([
            'team_entry_id',
            'canonical_person_id',
            'person_kind',
            'status',
            'effective_from',
            'effective_to',
          ])
          .where('organization_id', '=', ctx.organizationId)
          .where('team_entry_id', 'in', entryIds)
          .where('status', 'in', ['active', 'substitute'])
          .execute();
  for (const f of fixtures) {
    if (!f.scheduled_start || !f.scheduled_end) continue;
    const kickoff = new Date(f.scheduled_start).getTime();
    const expected: ExpectedActivity['expected'] = new Map();
    for (const m of roster) {
      if (m.team_entry_id !== f.home_entry_id && m.team_entry_id !== f.away_entry_id) continue;
      const from = new Date(m.effective_from).getTime();
      const to = m.effective_to ? new Date(m.effective_to).getTime() : Number.POSITIVE_INFINITY;
      if (from > kickoff || to <= kickoff) continue;
      expected.set(m.canonical_person_id, { kind: m.person_kind, basis: 'roster' });
    }
    const activityId = f.scheduling_event_id ?? f.fixture_id;
    activities.push({
      key: f.scheduling_event_id ? `event:${f.scheduling_event_id}` : `fixture:${f.fixture_id}`,
      activityType: 'event',
      activityId,
      sourceType: 'fixture',
      sourceId: f.fixture_id,
      offeringId: null,
      title: 'Fixture',
      start: new Date(f.scheduled_start),
      end: new Date(f.scheduled_end),
      expected,
    });
  }
  return activities;
}
