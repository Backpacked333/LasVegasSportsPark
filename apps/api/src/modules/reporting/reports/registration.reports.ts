import { Injectable } from '@nestjs/common';
import type { ReportRow } from '@sportspark/contracts';
import { addDays } from '../../scheduling';
import { column, type ReportContext, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import {
  ageBandLabel,
  localDays,
  metricValue,
  ratio,
  timeBand,
  weekdayName,
  toLocalWeekday,
} from '../reporting.shared';

const LIVE_NOTE =
  'Evaluated live from the owning module at the request instant; a past as-of instant cannot be reconstructed. The stored report run is the reproducible record.';

interface OfferingInfo {
  offeringId: string;
  name: string;
  programName: string;
  format: string;
  ageBand: string;
  kind: string;
}

async function offeringsAt(ctx: ReportContext): Promise<Map<string, OfferingInfo>> {
  const rows = await ctx.db
    .selectFrom('reporting_offerings_v')
    .select([
      'offering_id',
      'offering_name',
      'program_name',
      'format',
      'program_format',
      'program_age_band',
      'offering_kind',
    ])
    .where('organization_id', '=', ctx.organizationId)
    .where('facility_id', '=', ctx.facility!.id)
    .execute();
  return new Map(
    rows.map((r) => [
      r.offering_id,
      {
        offeringId: r.offering_id,
        name: r.offering_name,
        programName: r.program_name ?? 'unspecified',
        format: r.format ?? r.program_format ?? 'unspecified',
        ageBand: ageBandLabel(r.program_age_band),
        kind: r.offering_kind,
      },
    ]),
  );
}

const inRange = (t: Date | null, start: number, end: number, asOf: Date): boolean => {
  if (t === null) return false;
  const v = new Date(t).getTime();
  return v >= start && v < end && v <= asOf.getTime();
};

/**
 * R06 waitlist demand, R07 registration funnel, R08 enrollment and roster completeness
 * (SPK-REPORT-002) and demand (SPK-REPORT-006), read through the catalog, enrollment and
 * competition views of migration 1300.
 */
@Injectable()
export class RegistrationReports {
  readonly waitlistDemand: ReportDefinition<'waitlist_demand'> = {
    key: 'waitlist_demand',
    title: 'Waitlist demand',
    requirementIds: ['SPK-REPORT-002', 'SPK-REG-008'],
    viewAction: ReportingActions.viewDemandReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'none',
    pointInTimeNote: LIVE_NOTE,
    compute: async (ctx, params) => {
      const facility = ctx.facility!;
      const days = localDays(facility.timezone, params.from, params.to, ctx.policy.maxPeriodDays);
      const start = days[0]!.start;
      const end = days[days.length - 1]!.end;
      const offerings = await offeringsAt(ctx);
      const ids = [...offerings.keys()];
      const entries =
        ids.length === 0
          ? []
          : await ctx.db
              .selectFrom('reporting_waitlist_entries_v')
              .select(['offering_id', 'status'])
              .where('organization_id', '=', ctx.organizationId)
              .where('offering_id', 'in', ids)
              .where('status', 'in', ['waiting', 'offered'])
              .execute();
      const offers =
        ids.length === 0
          ? []
          : await ctx.db
              .selectFrom('reporting_waitlist_offers_v')
              .select([
                'offering_id',
                'status',
                'expires_at',
                'accepted_at',
                'declined_at',
                'expired_at',
              ])
              .where('organization_id', '=', ctx.organizationId)
              .where('offering_id', 'in', ids)
              .execute();
      const totals = { waiting: 0, offered: 0, outstanding: 0, accepted: 0, terminal: 0 };
      const rows: ReportRow[] = [];
      for (const o of [...offerings.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const e = entries.filter((x) => x.offering_id === o.offeringId);
        const f = offers.filter((x) => x.offering_id === o.offeringId);
        const waiting = e.filter((x) => x.status === 'waiting').length;
        const offered = e.filter((x) => x.status === 'offered').length;
        const outstanding = f.filter(
          (x) => x.status === 'offered' && new Date(x.expires_at).getTime() > ctx.asOf.getTime(),
        ).length;
        const accepted = f.filter((x) => inRange(x.accepted_at, start, end, ctx.asOf)).length;
        const declined = f.filter((x) => inRange(x.declined_at, start, end, ctx.asOf)).length;
        const expired = f.filter((x) => inRange(x.expired_at, start, end, ctx.asOf)).length;
        if (waiting + offered + outstanding + accepted + declined + expired === 0) continue;
        totals.waiting += waiting;
        totals.offered += offered;
        totals.outstanding += outstanding;
        totals.accepted += accepted;
        totals.terminal += accepted + declined + expired;
        rows.push({
          offeringId: o.offeringId,
          offering: o.name,
          program: o.programName,
          waiting,
          holdingOffer: offered,
          offersOutstanding: outstanding,
          acceptedInRange: accepted,
          declinedInRange: declined,
          expiredInRange: expired,
          acceptanceRate: ratio(accepted, accepted + declined + expired),
        });
      }
      return {
        scope: { from: params.from, to: params.to },
        values: [
          metricValue('MET-021', 'Waitlist depth', 'count', totals.waiting + totals.offered),
          metricValue('MET-022', 'Offers outstanding', 'count', totals.outstanding),
          metricValue(
            'MET-023',
            'Offer acceptance rate',
            'ratio',
            ratio(totals.accepted, totals.terminal),
            {
              unavailableReason: 'no offer concluded in the range',
            },
          ),
        ],
        columns: [
          column('offeringId', 'Offering', 'id'),
          column('offering', 'Offering name'),
          column('program', 'Program'),
          column('waiting', 'Waiting', 'count'),
          column('holdingOffer', 'Holding an offer', 'count'),
          column('offersOutstanding', 'Offers outstanding', 'count'),
          column('acceptedInRange', 'Accepted in range', 'count'),
          column('declinedInRange', 'Declined in range', 'count'),
          column('expiredInRange', 'Expired in range', 'count'),
          column('acceptanceRate', 'Acceptance rate', 'ratio'),
        ],
        rows,
        disclosures: ['Waitlist position and priority are not reported per person (rule G9).'],
      };
    },
  };

  readonly registrationFunnel: ReportDefinition<'registration_funnel'> = {
    key: 'registration_funnel',
    title: 'Registration funnel',
    requirementIds: ['SPK-REPORT-002', '§4.6'],
    viewAction: ReportingActions.viewDemandReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'partial',
    pointInTimeNote:
      'Each stage is counted by the instant the record reached it (submission, decision, acquisition, commitment, release, expiry, confirmation), so later events do not change earlier figures; an application decided after the as-of instant is counted as awaiting its decision.',
    compute: async (ctx, params) => {
      const facility = ctx.facility!;
      const days = localDays(facility.timezone, params.from, params.to, ctx.policy.maxPeriodDays);
      const start = days[0]!.start;
      const end = days[days.length - 1]!.end;
      const offerings = await offeringsAt(ctx);
      const ids = [...offerings.keys()];
      if (ids.length === 0) {
        return emptyFunnel(params);
      }
      const applications = await ctx.db
        .selectFrom('reporting_applications_v')
        .select([
          'application_id',
          'offering_id',
          'status',
          'submitted_at',
          'decided_at',
          'withdrawn_at',
        ])
        .where('organization_id', '=', ctx.organizationId)
        .where('offering_id', 'in', ids)
        .execute();
      const holds = await ctx.db
        .selectFrom('reporting_holds_v')
        .select(['offering_id', 'acquired_at', 'committed_at', 'released_at', 'expired_at'])
        .where('organization_id', '=', ctx.organizationId)
        .where('offering_id', 'in', ids)
        .execute();
      const enrollments = await ctx.db
        .selectFrom('reporting_enrollments_v')
        .select(['offering_id', 'confirmed_at', 'source_application_id'])
        .where('organization_id', '=', ctx.organizationId)
        .where('offering_id', 'in', ids)
        .execute();
      const confirmedByApplication = new Set(
        enrollments
          .filter(
            (e) =>
              e.source_application_id && e.confirmed_at && new Date(e.confirmed_at) <= ctx.asOf,
          )
          .map((e) => e.source_application_id as string),
      );
      const t = {
        submitted: 0,
        accepted: 0,
        declined: 0,
        withdrawn: 0,
        awaiting: 0,
        converted: 0,
        acquired: 0,
        committed: 0,
        released: 0,
        expired: 0,
        confirmed: 0,
      };
      const rows: ReportRow[] = [];
      for (const o of [...offerings.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const apps = applications.filter((a) => a.offering_id === o.offeringId);
        const submittedApps = apps.filter((a) => inRange(a.submitted_at, start, end, ctx.asOf));
        const decidedBy = (a: (typeof apps)[number], status: string) =>
          a.status === status && inRange(a.decided_at, start, end, ctx.asOf);
        const row = {
          submitted: submittedApps.length,
          accepted: apps.filter((a) => decidedBy(a, 'accepted')).length,
          declined: apps.filter((a) => decidedBy(a, 'declined')).length,
          withdrawn: apps.filter((a) => inRange(a.withdrawn_at, start, end, ctx.asOf)).length,
          awaiting: apps.filter(
            (a) =>
              a.submitted_at !== null &&
              new Date(a.submitted_at) <= ctx.asOf &&
              (a.decided_at === null || new Date(a.decided_at) > ctx.asOf) &&
              (a.withdrawn_at === null || new Date(a.withdrawn_at) > ctx.asOf),
          ).length,
          converted: submittedApps.filter((a) => confirmedByApplication.has(a.application_id))
            .length,
          acquired: 0,
          committed: 0,
          released: 0,
          expired: 0,
          confirmed: enrollments.filter(
            (e) => e.offering_id === o.offeringId && inRange(e.confirmed_at, start, end, ctx.asOf),
          ).length,
        };
        for (const h of holds) {
          if (h.offering_id !== o.offeringId) continue;
          if (inRange(h.acquired_at, start, end, ctx.asOf)) row.acquired += 1;
          if (inRange(h.committed_at, start, end, ctx.asOf)) row.committed += 1;
          if (inRange(h.released_at, start, end, ctx.asOf)) row.released += 1;
          if (inRange(h.expired_at, start, end, ctx.asOf)) row.expired += 1;
        }
        const total = Object.values(row).reduce((a, b) => a + b, 0);
        if (total === 0) continue;
        for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += row[k];
        rows.push({
          offeringId: o.offeringId,
          offering: o.name,
          applicationsSubmitted: row.submitted,
          applicationsAccepted: row.accepted,
          applicationsDeclined: row.declined,
          applicationsWithdrawn: row.withdrawn,
          awaitingDecision: row.awaiting,
          holdsAcquired: row.acquired,
          holdsCommitted: row.committed,
          holdsReleased: row.released,
          holdsExpired: row.expired,
          enrollmentsConfirmed: row.confirmed,
          conversionRate: ratio(row.converted, row.submitted),
        });
      }
      const holdTerminal = t.committed + t.released + t.expired;
      return {
        scope: { from: params.from, to: params.to },
        values: [
          metricValue('MET-025', 'Applications submitted', 'count', t.submitted, {
            dimensions: { stage: 'submitted' },
          }),
          metricValue('MET-025', 'Applications accepted', 'count', t.accepted, {
            dimensions: { stage: 'accepted' },
          }),
          metricValue('MET-025', 'Awaiting decision', 'count', t.awaiting, {
            dimensions: { stage: 'awaiting_review' },
          }),
          metricValue('MET-025', 'Holds acquired', 'count', t.acquired, {
            dimensions: { stage: 'hold_active' },
          }),
          metricValue('MET-025', 'Enrollments confirmed', 'count', t.confirmed, {
            dimensions: { stage: 'confirmed' },
          }),
          metricValue(
            'MET-026',
            'Funnel conversion rate',
            'ratio',
            ratio(t.converted, t.submitted),
            {
              unavailableReason: 'no application submitted in the range',
            },
          ),
          metricValue('MET-028', 'Holds committed', 'count', t.committed, {
            dimensions: { outcome: 'committed' },
          }),
          metricValue('MET-028', 'Holds released', 'count', t.released, {
            dimensions: { outcome: 'released' },
          }),
          metricValue('MET-028', 'Holds expired', 'count', t.expired, {
            dimensions: { outcome: 'expired' },
          }),
          metricValue(
            'MET-028',
            'Hold commitment share',
            'ratio',
            ratio(t.committed, holdTerminal),
            {
              unavailableReason: 'no hold concluded in the range',
            },
          ),
        ],
        columns: [
          column('offeringId', 'Offering', 'id'),
          column('offering', 'Offering name'),
          column('applicationsSubmitted', 'Applications submitted', 'count'),
          column('applicationsAccepted', 'Accepted', 'count'),
          column('applicationsDeclined', 'Declined', 'count'),
          column('applicationsWithdrawn', 'Withdrawn', 'count'),
          column('awaitingDecision', 'Awaiting decision', 'count'),
          column('holdsAcquired', 'Holds acquired', 'count'),
          column('holdsCommitted', 'Holds committed', 'count'),
          column('holdsReleased', 'Holds released', 'count'),
          column('holdsExpired', 'Holds expired', 'count'),
          column('enrollmentsConfirmed', 'Enrollments confirmed', 'count'),
          column('conversionRate', 'Conversion rate', 'ratio'),
        ],
        rows,
        disclosures: [
          `Stages are counted by local date in ${facility.timezone}; draft applications are not part of the funnel.`,
        ],
      };
    },
  };

  readonly enrollmentCompleteness: ReportDefinition<'enrollment_completeness'> = {
    key: 'enrollment_completeness',
    title: 'Enrollment and roster completeness',
    requirementIds: ['SPK-REPORT-002', 'SPK-REG-005', 'SPK-COMP-004', 'SPK-CAT-001'],
    viewAction: ReportingActions.viewDemandReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'none',
    pointInTimeNote: LIVE_NOTE,
    compute: async (ctx) => {
      const facility = ctx.facility!;
      const offerings = await offeringsAt(ctx);
      const ids = [...offerings.keys()];
      const rows: ReportRow[] = [];
      const pools =
        ids.length === 0
          ? []
          : await ctx.db
              .selectFrom('reporting_capacity_pools_v')
              .selectAll()
              .where('organization_id', '=', ctx.organizationId)
              .where('offering_id', 'in', ids)
              .where('status', '=', 'active')
              .orderBy('pool_id')
              .execute();
      let committedUnits = 0;
      let capacityUnits = 0;
      for (const p of pools) {
        committedUnits += p.committed + p.held;
        capacityUnits += p.capacity;
        rows.push({
          section: 'capacity_pool',
          id: p.pool_id,
          offeringId: p.offering_id,
          name: offerings.get(p.offering_id ?? '')?.name ?? null,
          unit: p.unit,
          capacity: p.capacity,
          committed: p.committed,
          held: p.held,
          fill: ratio(p.committed + p.held, p.capacity),
          rosterSize: null,
          rosterMin: null,
          complete: null,
          enrollmentsMissingForms: null,
        });
      }

      const entries = await ctx.db
        .selectFrom('reporting_team_entries_v')
        .select(['team_entry_id', 'division_id', 'roster_min'])
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('status', '=', 'approved')
        .where('season_status', 'in', ['open', 'active'])
        .orderBy('team_entry_id')
        .execute();
      const roster =
        entries.length === 0
          ? []
          : await ctx.db
              .selectFrom('reporting_roster_memberships_v')
              .select(['team_entry_id', 'canonical_person_id', 'effective_from', 'effective_to'])
              .where('organization_id', '=', ctx.organizationId)
              .where(
                'team_entry_id',
                'in',
                entries.map((e) => e.team_entry_id),
              )
              .where('status', 'in', ['active', 'substitute'])
              .execute();
      let completeEntries = 0;
      for (const e of entries) {
        const size = new Set(
          roster
            .filter(
              (m) =>
                m.team_entry_id === e.team_entry_id &&
                new Date(m.effective_from) <= ctx.asOf &&
                (m.effective_to === null || new Date(m.effective_to) > ctx.asOf),
            )
            .map((m) => m.canonical_person_id),
        ).size;
        const complete = e.roster_min === null ? null : size >= e.roster_min;
        if (complete) completeEntries += 1;
        rows.push({
          section: 'team_entry',
          id: e.team_entry_id,
          offeringId: null,
          name: null,
          unit: null,
          capacity: null,
          committed: null,
          held: null,
          fill: null,
          rosterSize: size,
          rosterMin: e.roster_min,
          complete,
          enrollmentsMissingForms: null,
        });
      }

      const forms =
        ids.length === 0
          ? []
          : await ctx.db
              .selectFrom('reporting_required_forms_v')
              .select(['offering_id', 'policy_version_id'])
              .where('organization_id', '=', ctx.organizationId)
              .where('offering_id', 'in', ids)
              .execute();
      const formOfferings = [...new Set(forms.map((f) => f.offering_id))];
      let confirmedWithForms = 0;
      let missing = 0;
      if (formOfferings.length > 0) {
        const enrolled = await ctx.db
          .selectFrom('reporting_enrollments_v')
          .select(['enrollment_id', 'offering_id', 'participant_person_id'])
          .where('organization_id', '=', ctx.organizationId)
          .where('offering_id', 'in', formOfferings)
          .where('status', '=', 'confirmed')
          .execute();
        const acks =
          enrolled.length === 0
            ? []
            : await ctx.db
                .selectFrom('reporting_acknowledgments_v')
                .select(['subject_person_id', 'policy_version_id'])
                .where('organization_id', '=', ctx.organizationId)
                .where('status', '=', 'active')
                .where('subject_person_id', 'in', [
                  ...new Set(enrolled.map((e) => e.participant_person_id)),
                ])
                .execute();
        const signed = new Set(acks.map((a) => `${a.subject_person_id}|${a.policy_version_id}`));
        for (const offeringId of formOfferings.sort()) {
          const required = forms
            .filter((f) => f.offering_id === offeringId)
            .map((f) => f.policy_version_id);
          const ofOffering = enrolled.filter((e) => e.offering_id === offeringId);
          const missingHere = ofOffering.filter((e) =>
            required.some((pv) => !signed.has(`${e.participant_person_id}|${pv}`)),
          ).length;
          confirmedWithForms += ofOffering.length;
          missing += missingHere;
          rows.push({
            section: 'required_forms',
            id: offeringId,
            offeringId,
            name: offerings.get(offeringId)?.name ?? null,
            unit: null,
            capacity: null,
            committed: ofOffering.length,
            held: null,
            fill: null,
            rosterSize: null,
            rosterMin: null,
            complete: missingHere === 0,
            enrollmentsMissingForms: missingHere,
          });
        }
      }
      return {
        scope: { from: null, to: null },
        values: [
          metricValue('MET-033', 'Enrollment fill', 'ratio', ratio(committedUnits, capacityUnits), {
            unavailableReason: 'no active capacity pool at the facility',
          }),
          metricValue('MET-034', 'Team entries with a complete roster', 'count', completeEntries),
          metricValue('MET-034', 'Approved team entries', 'count', entries.length),
          metricValue('MET-037', 'Confirmed enrollments missing a required form', 'count', missing),
          metricValue(
            'MET-037',
            'Missing-form share',
            'ratio',
            ratio(missing, confirmedWithForms),
            {
              unavailableReason: 'no confirmed enrollment requires a form',
            },
          ),
        ],
        columns: [
          column('section', 'Section'),
          column('id', 'Record', 'id'),
          column('offeringId', 'Offering', 'id'),
          column('name', 'Name'),
          column('unit', 'Capacity unit'),
          column('capacity', 'Capacity', 'count'),
          column('committed', 'Committed', 'count'),
          column('held', 'Held', 'count'),
          column('fill', 'Fill', 'ratio'),
          column('rosterSize', 'Roster size', 'count'),
          column('rosterMin', 'Rule set minimum', 'count'),
          column('complete', 'Complete', 'boolean'),
          column('enrollmentsMissingForms', 'Enrollments missing forms', 'count'),
        ],
        rows,
        disclosures: [
          'Roster completeness counts active and substitute memberships effective at the as-of instant against the rule set rosterMin; player eligibility is evaluated by match readiness.',
          'A team entry whose rule set has no rosterMin is reported with completeness unknown.',
        ],
      };
    },
  };

  readonly demand: ReportDefinition<'demand'> = {
    key: 'demand',
    title: 'Demand by day, time, age band, format and program',
    requirementIds: ['SPK-REPORT-006'],
    viewAction: ReportingActions.viewDemandReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'partial',
    pointInTimeNote:
      'Each demand signal is counted by the instant it was recorded (submission, acquisition, joining, confirmation); later records do not change the figures.',
    compute: async (ctx, params) => {
      const facility = ctx.facility!;
      const method = params.forecastMethod ?? 'none';
      const periods = method === 'none' ? 0 : (params.forecastPeriods ?? 4);
      const days = localDays(facility.timezone, params.from, params.to, ctx.policy.maxPeriodDays);
      const length = days.length;
      const earliest = addDays(params.from, -length * periods);
      const span = localDays(
        facility.timezone,
        earliest,
        params.to,
        ctx.policy.maxPeriodDays * (periods + 1),
      );
      const spanStart = span[0]!.start;
      const end = days[days.length - 1]!.end;
      // Period index of an instant: 0 is the requested range, k the k-th preceding range.
      const boundaries = Array.from({ length: periods + 1 }, (_, k) => ({
        k,
        start: span[(periods - k) * length]!.start,
        end: span[(periods - k) * length + length - 1]!.end,
      }));
      const periodOf = (t: Date | null): number | null => {
        if (t === null) return null;
        const v = new Date(t).getTime();
        if (v > ctx.asOf.getTime()) return null;
        for (const b of boundaries) if (v >= b.start && v < b.end) return b.k;
        return null;
      };

      const offerings = await offeringsAt(ctx);
      const ids = [...offerings.keys()];
      const counts = new Map<string, number[]>();
      const add = (key: string, k: number) => {
        const list = counts.get(key) ?? Array.from({ length: periods + 1 }, () => 0);
        list[k] = (list[k] ?? 0) + 1;
        counts.set(key, list);
      };
      if (ids.length > 0) {
        const sessions = await ctx.db
          .selectFrom('reporting_sessions_v')
          .select(['session_id', 'offering_id', 'scheduled_start', 'status'])
          .where('organization_id', '=', ctx.organizationId)
          .where('offering_id', 'in', ids)
          .execute();
        const firstSession = new Map<string, Date>();
        const sessionStart = new Map<string, Date>();
        for (const s of sessions) {
          sessionStart.set(s.session_id, new Date(s.scheduled_start));
          if (s.status === 'canceled') continue;
          const current = firstSession.get(s.offering_id);
          if (!current || new Date(s.scheduled_start) < current) {
            firstSession.set(s.offering_id, new Date(s.scheduled_start));
          }
        }
        const keyOf = (signal: string, offeringId: string, at: Date | undefined): string | null => {
          const o = offerings.get(offeringId);
          if (!o) return null;
          const weekday = at ? weekdayName(toLocalWeekday(facility.timezone, at)) : 'unscheduled';
          const band = at
            ? timeBand(facility.timezone, at, ctx.policy.timeBandMinutes)
            : 'unscheduled';
          return JSON.stringify([signal, o.programName, o.format, o.ageBand, weekday, band]);
        };
        const record = (signal: string, offeringId: string, t: Date | null, at?: Date) => {
          const k = periodOf(t);
          if (k === null) return;
          const key = keyOf(signal, offeringId, at ?? firstSession.get(offeringId));
          if (key) add(key, k);
        };
        const since = new Date(spanStart);
        const until = new Date(Math.min(end, ctx.asOf.getTime() + 1));
        const apps = await ctx.db
          .selectFrom('reporting_applications_v')
          .select(['offering_id', 'submitted_at'])
          .where('organization_id', '=', ctx.organizationId)
          .where('offering_id', 'in', ids)
          .where('submitted_at', '>=', since)
          .where('submitted_at', '<', until)
          .execute();
        for (const a of apps) record('application_submitted', a.offering_id, a.submitted_at);
        const holds = await ctx.db
          .selectFrom('reporting_holds_v')
          .select(['offering_id', 'acquired_at'])
          .where('organization_id', '=', ctx.organizationId)
          .where('offering_id', 'in', ids)
          .where('acquired_at', '>=', since)
          .where('acquired_at', '<', until)
          .execute();
        for (const h of holds)
          if (h.offering_id) record('hold_acquired', h.offering_id, h.acquired_at);
        const waits = await ctx.db
          .selectFrom('reporting_waitlist_entries_v')
          .select(['offering_id', 'joined_at'])
          .where('organization_id', '=', ctx.organizationId)
          .where('offering_id', 'in', ids)
          .where('joined_at', '>=', since)
          .where('joined_at', '<', until)
          .execute();
        for (const w of waits) record('waitlist_joined', w.offering_id, w.joined_at);
        const enrolled = await ctx.db
          .selectFrom('reporting_enrollments_v')
          .select(['offering_id', 'confirmed_at'])
          .where('organization_id', '=', ctx.organizationId)
          .where('offering_id', 'in', ids)
          .where('confirmed_at', '>=', since)
          .where('confirmed_at', '<', until)
          .execute();
        for (const e of enrolled) record('enrollment_confirmed', e.offering_id, e.confirmed_at);
        const bookings = await ctx.db
          .selectFrom('reporting_session_bookings_v')
          .select(['offering_id', 'session_id', 'confirmed_at'])
          .where('organization_id', '=', ctx.organizationId)
          .where('offering_id', 'in', ids)
          .where('confirmed_at', '>=', since)
          .where('confirmed_at', '<', until)
          .execute();
        for (const b of bookings) {
          record(
            'session_booking_confirmed',
            b.offering_id,
            b.confirmed_at,
            sessionStart.get(b.session_id),
          );
        }
      }

      const demandRows = [...counts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, list]) => {
          const [signal, program, format, ageBand, dayOfWeek, startBand] = JSON.parse(
            key,
          ) as string[];
          const previous = list.slice(1);
          const forecast =
            method === 'trailing_mean' && previous.length > 0
              ? Math.round((previous.reduce((a, b) => a + b, 0) / previous.length) * 100) / 100
              : null;
          return {
            signal: signal ?? null,
            program: program ?? null,
            format: format ?? null,
            ageBand: ageBand ?? null,
            dayOfWeek: dayOfWeek ?? null,
            startBand: startBand ?? null,
            observed: list[0] ?? 0,
            forecast,
            forecastMethod: method === 'none' ? null : method,
          };
        })
        .filter((r) => r.observed > 0 || (r.forecast ?? 0) > 0);
      const rows: ReportRow[] = demandRows;

      const bySignal = new Map<string, number>();
      for (const r of demandRows)
        bySignal.set(String(r.signal), (bySignal.get(String(r.signal)) ?? 0) + r.observed);
      const values = [...bySignal.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([signal, n]) =>
          metricValue('MET-086', `Observed ${signal.replaceAll('_', ' ')}`, 'count', n, {
            dimensions: { signal, series: 'observed' },
          }),
        );
      if (method === 'none') {
        values.push(
          metricValue('MET-089', 'Demand forecast', 'count', null, {
            dimensions: { series: 'forecast' },
            unavailableReason:
              'no forecast requested; no forecasting method is approved (pending decision)',
          }),
        );
      } else {
        const total = demandRows.reduce((sum, r) => sum + (r.forecast ?? 0), 0);
        values.push(
          metricValue(
            'MET-089',
            'Demand forecast (all signals)',
            'count',
            Math.round(total * 100) / 100,
            {
              dimensions: {
                series: 'forecast',
                method,
                inputPeriods: String(periods),
              },
            },
          ),
        );
      }
      return {
        scope: { from: params.from, to: params.to },
        values,
        columns: [
          column('signal', 'Signal'),
          column('program', 'Program'),
          column('format', 'Format'),
          column('ageBand', 'Age band (program)'),
          column('dayOfWeek', 'Day of week'),
          column('startBand', 'Start-time band'),
          column('observed', 'Observed', 'count'),
          column('forecast', 'Forecast (separate series)', 'count'),
          column('forecastMethod', 'Forecast method'),
        ],
        rows,
        disclosures: [
          'Observed demand and forecasts are separate columns and are never combined (SPK-REPORT-006, rule G12).',
          method === 'trailing_mean'
            ? `Forecast method trailing_mean: the mean of the same cell over the ${periods} preceding ranges of ${length} days, evaluated as of the same instant; it is an engineering baseline, not an approved forecasting method.`
            : 'No forecast was requested.',
          'Day and time come from the offering’s first scheduled session (a session booking uses its booked session); offerings without a session are reported as unscheduled.',
          'Age band is the program’s configured band (DEC-003); no age is computed per person here.',
        ],
      };
    },
  };
}

function emptyFunnel(params: { from: string; to: string }) {
  return {
    scope: { from: params.from, to: params.to },
    values: [
      metricValue('MET-025', 'Applications submitted', 'count', 0, {
        dimensions: { stage: 'submitted' },
      }),
      metricValue('MET-026', 'Funnel conversion rate', 'ratio', null, {
        unavailableReason: 'no offering at the facility',
      }),
      metricValue('MET-028', 'Holds committed', 'count', 0, {
        dimensions: { outcome: 'committed' },
      }),
    ],
    columns: [column('offeringId', 'Offering', 'id')],
    rows: [],
    disclosures: ['No offering is located at the facility.'],
  };
}
