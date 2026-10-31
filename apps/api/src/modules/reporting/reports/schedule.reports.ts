import { Injectable } from '@nestjs/common';
import type { ReportRow } from '@sportspark/contracts';
import { currentHeads, effectiveState, attended as isAttended } from '../../entry';
import { column, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import { REPORTING_SETTING_NAMES } from '../reporting.settings';
import {
  localDay,
  localDays,
  localTimeLabel,
  metricValue,
  ratio,
  timeBand,
  iso,
} from '../reporting.shared';
import { loadExpectedActivities } from './participation';

const UNAVAILABILITY = new Set(['maintenance', 'block']);
const DAY_SETTINGS = [REPORTING_SETTING_NAMES.operatingDayStart] as const;

/**
 * R01 daily schedule, R02 expected arrivals and R03 attendance (SPK-REPORT-002), read through the
 * scheduling, catalog, enrollment, competition and entry views of migration 1300.
 */
@Injectable()
export class ScheduleReports {
  readonly dailySchedule: ReportDefinition<'daily_schedule'> = {
    key: 'daily_schedule',
    title: 'Daily schedule',
    requirementIds: ['SPK-REPORT-002', 'SPK-UX-006'],
    viewAction: ReportingActions.viewOperationsReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'partial',
    pointInTimeNote:
      'Cancellations after the as-of instant are ignored (their instant is recorded); publication and moves are taken as they stand now. The stored run is the reproducible record.',
    settings: DAY_SETTINGS,
    compute: async (ctx, params) => {
      const facility = ctx.facility!;
      const day = localDay(facility.timezone, params.date, ctx.dayStart);
      const rows = await ctx.db
        .selectFrom('reporting_events_v')
        .select([
          'event_id',
          'kind',
          'title',
          'format',
          'status',
          'scheduled_start',
          'scheduled_end',
          'source_type',
          'published_revision',
          'canceled_at',
          'resource_count',
        ])
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('scheduled_start', '>=', new Date(day.start))
        .where('scheduled_start', '<', new Date(day.end))
        .orderBy('scheduled_start')
        .orderBy('event_id')
        .execute();
      let published = 0;
      let draft = 0;
      let canceled = 0;
      let republished = 0;
      let unavailable = 0;
      const out: ReportRow[] = [];
      for (const e of rows) {
        const canceledByAsOf =
          e.status === 'canceled' && e.canceled_at !== null && new Date(e.canceled_at) <= ctx.asOf;
        const status =
          e.status === 'canceled' && !canceledByAsOf
            ? e.published_revision !== null
              ? 'published'
              : 'draft'
            : e.status;
        const changed = status === 'published' && (e.published_revision ?? 0) > 1;
        const isUnavailability = UNAVAILABILITY.has(e.kind);
        if (isUnavailability && status !== 'canceled') unavailable += 1;
        else if (status === 'published') {
          published += 1;
          if (changed) republished += 1;
        } else if (status === 'draft') draft += 1;
        else if (status === 'canceled' && e.published_revision !== null) canceled += 1;
        out.push({
          eventId: e.event_id,
          kind: e.kind,
          title: e.title,
          format: e.format,
          status,
          start: iso(e.scheduled_start),
          end: iso(e.scheduled_end),
          localStart: localTimeLabel(facility.timezone, e.scheduled_start),
          startBand: timeBand(facility.timezone, e.scheduled_start, ctx.policy.timeBandMinutes),
          sourceType: e.source_type,
          spaces: e.resource_count,
          changedAfterPublication:
            changed || (status === 'canceled' && e.published_revision !== null),
          unavailability: isUnavailability,
        });
      }
      return {
        scope: { from: params.date, to: params.date },
        values: [
          metricValue('MET-001', 'Scheduled activities', 'count', published),
          metricValue(
            'MET-002',
            'Changed or canceled after publication',
            'count',
            republished + canceled,
          ),
          metricValue(
            'MET-002',
            'Changed or canceled share',
            'ratio',
            ratio(republished + canceled, published + canceled),
            { unavailableReason: 'no published activity in the day' },
          ),
          metricValue('MET-003', 'Unpublished activities', 'count', draft),
          metricValue(
            'MET-001',
            'Unavailability events (maintenance, block)',
            'count',
            unavailable,
            {
              dimensions: { rule: 'U4' },
            },
          ),
        ],
        columns: [
          column('eventId', 'Event', 'id'),
          column('kind', 'Kind'),
          column('title', 'Title'),
          column('format', 'Format'),
          column('status', 'Status as of'),
          column('start', 'Scheduled start', 'instant'),
          column('end', 'Scheduled end', 'instant'),
          column('localStart', 'Local start'),
          column('startBand', 'Start-time band'),
          column('sourceType', 'Source type'),
          column('spaces', 'Spaces', 'count'),
          column('changedAfterPublication', 'Changed after publication', 'boolean'),
          column('unavailability', 'Unavailability (U4)', 'boolean'),
        ],
        rows: out,
        disclosures: [
          `Operating day: ${params.date} from ${ctx.dayStart} to ${ctx.dayStart} the next day, local time in ${facility.timezone} (${ctx.policy.operatingDayStart === null ? 'the calendar day: no operating day start is configured' : 'REPORTING_OPERATING_DAY_START'}; DEC-001).`,
          'Maintenance and block events are unavailability, not scheduled activities (rule U4).',
        ],
      };
    },
  };

  readonly expectedArrivals: ReportDefinition<'expected_arrivals'> = {
    key: 'expected_arrivals',
    title: 'Expected arrivals',
    requirementIds: ['SPK-REPORT-002', 'SPK-ENTRY-004', 'SPK-ENTRY-007'],
    viewAction: ReportingActions.viewOperationsReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'partial',
    pointInTimeNote:
      'Enrollment and booking confirmations, cancellations, transfers and expiries are applied as of the as-of instant; roster memberships are taken as they stand now.',
    settings: DAY_SETTINGS,
    compute: async (ctx, params) => {
      const facility = ctx.facility!;
      const day = localDay(facility.timezone, params.date, ctx.dayStart);
      const activities = await loadExpectedActivities(ctx, day);
      let expected = 0;
      let children = 0;
      let supervised = 0;
      const rows: ReportRow[] = activities.map((a) => {
        const all = [...a.expected.values()];
        const kids = all.filter((p) => p.kind === 'child').length;
        expected += all.length;
        children += kids;
        if (a.sourceType === 'session') supervised += kids;
        return {
          activityType: a.sourceType,
          activityId: a.activityId,
          // REP-01 (SCR-S-28): a catalog session is addressed by its offering and session.
          offeringId: a.offeringId,
          sessionId: a.sourceType === 'session' ? a.sourceId : null,
          title: a.title,
          start: iso(a.start),
          localStart: localTimeLabel(facility.timezone, a.start),
          expected: all.length,
          adults: all.length - kids,
          children: kids,
          byEnrollment: all.filter((p) => p.basis === 'enrollment').length,
          byBooking: all.filter((p) => p.basis === 'booking').length,
          byRoster: all.filter((p) => p.basis === 'roster').length,
          supervisedReleasesExpected: a.sourceType === 'session' ? kids : 0,
        };
      });
      return {
        scope: { from: params.date, to: params.date },
        values: [
          metricValue('MET-004', 'Expected arrivals', 'count', expected),
          metricValue('MET-004', 'Expected child participants', 'count', children, {
            dimensions: { participant: 'child' },
          }),
          metricValue('MET-006', 'Supervised releases expected', 'count', supervised),
        ],
        columns: [
          column('activityType', 'Activity type'),
          column('activityId', 'Activity', 'id'),
          column('offeringId', 'Offering', 'id'),
          column('sessionId', 'Session', 'id'),
          column('title', 'Title'),
          column('start', 'Scheduled start', 'instant'),
          column('localStart', 'Local start'),
          column('expected', 'Expected', 'count'),
          column('adults', 'Adults', 'count'),
          column('children', 'Children', 'count'),
          column('byEnrollment', 'By enrollment', 'count'),
          column('byBooking', 'By session booking', 'count'),
          column('byRoster', 'By roster', 'count'),
          column('supervisedReleasesExpected', 'Supervised releases expected', 'count'),
        ],
        rows,
        disclosures: [
          'Counts only: no participant is named (child data minimization, §4.14, rule G9).',
          'Activities without a participant list (rentals, parties, blocks) are not listed.',
          'Arrival issues per participant (MET-005) are evaluated live at check-in by the entry module and are not part of this report.',
          'Every child participant of a session is released through supervised release (entry policy; DEC-075 pending).',
        ],
      };
    },
  };

  readonly attendance: ReportDefinition<'attendance'> = {
    key: 'attendance',
    title: 'Attendance',
    requirementIds: ['SPK-REPORT-002', 'SPK-ENTRY-001', 'SPK-ENTRY-005', 'SPK-REPORT-007'],
    viewAction: ReportingActions.viewOperationsReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'partial',
    pointInTimeNote:
      'Attendance observations are append-only and stamped with their receipt instant: a correction received after the as-of instant does not change the figures (SPK-ENTRY-005, SPK-REPORT-007). Expected participants follow the expected-arrivals rules.',
    settings: DAY_SETTINGS,
    compute: async (ctx, params) => {
      const facility = ctx.facility!;
      const days = localDays(
        facility.timezone,
        params.from,
        params.to,
        ctx.policy.maxPeriodDays,
        ctx.dayStart,
      );
      const window = { start: days[0]!.start, end: days[days.length - 1]!.end };
      const expectedActivities = await loadExpectedActivities(ctx, window);

      // Every scheduling event of the range is an attendance activity, with or without a list.
      const events = await ctx.db
        .selectFrom('reporting_events_v')
        .select(['event_id', 'title', 'scheduled_start', 'kind'])
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('scheduled_start', '>=', new Date(window.start))
        .where('scheduled_start', '<', new Date(window.end))
        .where('status', '<>', 'draft')
        .execute();
      const activities = new Map(expectedActivities.map((a) => [a.key, a]));
      const titles = new Map<string, { title: string; start: Date; type: 'session' | 'event' }>();
      for (const a of expectedActivities)
        titles.set(a.key, { title: a.title, start: a.start, type: a.activityType });
      for (const e of events) {
        const key = `event:${e.event_id}`;
        if (!titles.has(key))
          titles.set(key, { title: e.title, start: new Date(e.scheduled_start), type: 'event' });
      }
      const sessionIds = [...titles.keys()]
        .filter((k) => k.startsWith('session:'))
        .map((k) => k.slice(8));
      const eventIds = [...titles.keys()]
        .filter((k) => k.startsWith('event:'))
        .map((k) => k.slice(6));
      const activityIds = [...sessionIds, ...eventIds];

      const observations =
        activityIds.length === 0
          ? []
          : await ctx.db
              .selectFrom('reporting_attendance_v')
              .select([
                'observation_id',
                'person_id',
                'activity_type',
                'activity_id',
                'observed_state',
                'observed_at',
                'received_at',
                'source',
                'corrects_observation_id',
              ])
              .where('organization_id', '=', ctx.organizationId)
              .where('facility_id', '=', facility.id)
              .where('activity_id', 'in', activityIds)
              .where('received_at', '<=', ctx.asOf)
              .execute();

      const persons =
        observations.length === 0
          ? new Map<string, string>()
          : new Map(
              (
                await ctx.db
                  .selectFrom('reporting_persons_v')
                  .select(['person_id', 'canonical_person_id'])
                  .where('organization_id', '=', ctx.organizationId)
                  .where('person_id', 'in', [...new Set(observations.map((o) => o.person_id))])
                  .execute()
              ).map((p) => [p.person_id, p.canonical_person_id]),
            );

      const byActivity = new Map<string, typeof observations>();
      for (const o of observations) {
        const key = `${o.activity_type}:${o.activity_id}`;
        const list = byActivity.get(key) ?? [];
        list.push(o);
        byActivity.set(key, list);
      }

      const totals = {
        expected: 0,
        expectedAttended: 0,
        attended: 0,
        absent: 0,
        conflicts: 0,
        corrections: 0,
        offline: 0,
        walkIns: 0,
        effective: 0,
      };
      const rows: ReportRow[] = [];
      const keys = [...titles.keys()].sort((a, b) => {
        const ta = titles.get(a)!.start.getTime();
        const tb = titles.get(b)!.start.getTime();
        return ta - tb || (a < b ? -1 : 1);
      });
      for (const key of keys) {
        const info = titles.get(key)!;
        const list = byActivity.get(key) ?? [];
        const expected = activities.get(key)?.expected ?? new Map();
        const byPerson = new Map<string, typeof list>();
        for (const o of list) {
          const person = persons.get(o.person_id) ?? o.person_id;
          const items = byPerson.get(person) ?? [];
          items.push(o);
          byPerson.set(person, items);
        }
        let attended = 0;
        let expectedAttended = 0;
        let absent = 0;
        let conflicts = 0;
        let walkIns = 0;
        for (const [person, items] of byPerson) {
          const heads = currentHeads(
            items.map((o) => ({
              id: o.observation_id,
              correctsObservationId: o.corrects_observation_id,
              observedState: o.observed_state,
              observedAt: new Date(o.observed_at),
              receivedAt: new Date(o.received_at),
            })),
          );
          const state = effectiveState(heads);
          if (state === null) {
            if (heads.length > 0) conflicts += 1;
            continue;
          }
          if (isAttended(state)) {
            attended += 1;
            if (expected.has(person)) expectedAttended += 1;
            else walkIns += 1;
          } else {
            absent += 1;
          }
        }
        const corrections = list.filter((o) => o.corrects_observation_id !== null).length;
        const offline = list.filter((o) => o.source === 'offline_sync').length;
        if (list.length === 0 && expected.size === 0) continue;
        totals.expected += expected.size;
        totals.expectedAttended += expectedAttended;
        totals.attended += attended;
        totals.absent += absent;
        totals.conflicts += conflicts;
        totals.corrections += corrections;
        totals.offline += offline;
        totals.walkIns += walkIns;
        totals.effective += attended + absent;
        rows.push({
          activityType: info.type,
          activityId: key.slice(key.indexOf(':') + 1),
          title: info.title,
          start: iso(info.start),
          expected: expected.size,
          attended,
          expectedAttended,
          absent,
          walkIns,
          pendingReview: conflicts,
          corrections,
          offlineObservations: offline,
          attendanceRate: ratio(expectedAttended, expected.size),
        });
      }

      const visits = await ctx.db
        .selectFrom('reporting_visits_v')
        .select(['party_size', 'voided_at', 'visitor_category'])
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('arrived_at', '>=', new Date(window.start))
        .where('arrived_at', '<', new Date(window.end))
        .where('received_at', '<=', ctx.asOf)
        .execute();
      const arrivals = visits
        .filter((v) => v.voided_at === null || new Date(v.voided_at) > ctx.asOf)
        .reduce((sum, v) => sum + v.party_size, 0);
      const checkins = await ctx.db
        .selectFrom('reporting_session_checkins_v')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('admitted_at', '>=', new Date(window.start))
        .where('admitted_at', '<', new Date(window.end))
        .where('admitted_at', '<=', ctx.asOf)
        .executeTakeFirst();

      return {
        scope: { from: params.from, to: params.to },
        values: [
          metricValue('MET-007', 'Attended', 'count', totals.attended),
          metricValue('MET-007', 'Walk-in attended (not expected)', 'count', totals.walkIns),
          metricValue('MET-007', 'Observed absent', 'count', totals.absent),
          metricValue(
            'MET-008',
            'Attendance rate',
            'ratio',
            ratio(totals.expectedAttended, totals.expected),
            {
              unavailableReason: 'no expected participant in the range',
            },
          ),
          metricValue('MET-009', 'Facility arrivals (people)', 'count', arrivals),
          metricValue('MET-009', 'Session check-ins admitted', 'count', Number(checkins?.n ?? 0)),
          metricValue('MET-011', 'Attendance corrections', 'count', totals.corrections),
          metricValue('MET-012', 'Offline observations', 'count', totals.offline),
          metricValue(
            'MET-012',
            'Conflicting observations pending review',
            'count',
            totals.conflicts,
          ),
        ],
        columns: [
          column('activityType', 'Activity type'),
          column('activityId', 'Activity', 'id'),
          column('title', 'Title'),
          column('start', 'Scheduled start', 'instant'),
          column('expected', 'Expected', 'count'),
          column('attended', 'Attended', 'count'),
          column('expectedAttended', 'Expected and attended', 'count'),
          column('absent', 'Absent', 'count'),
          column('walkIns', 'Walk-ins', 'count'),
          column('pendingReview', 'Conflicts pending review', 'count'),
          column('corrections', 'Corrections', 'count'),
          column('offlineObservations', 'Offline observations', 'count'),
          column('attendanceRate', 'Attendance rate', 'ratio'),
        ],
        rows,
        disclosures: [
          'Attended means present, late or left early after corrections; conflicting current observations are held for review and counted in neither attended nor absent (§4.15).',
          'Facility arrivals and session check-ins are separate counts, never summed and never called occupancy (SPK-ENTRY-008).',
          'Counts only: no participant is named (rule G9).',
        ],
      };
    },
  };
}
