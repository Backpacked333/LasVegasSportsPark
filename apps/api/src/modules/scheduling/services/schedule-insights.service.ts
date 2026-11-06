import { Inject, Injectable, Logger, type InjectionToken } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  errors,
  FACILITY_AVAILABILITY_MAX_RESOURCES,
  FACILITY_AVAILABILITY_MAX_SPAN_DAYS,
  type EventDetail,
  type FacilityAvailability,
  type FacilityAvailabilityQuery,
  type Interval,
  type Principal,
  type ScheduleWindowSummary,
} from '@sportspark/contracts';
import { tstzrange, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import { AuthorizationService, executorFor } from '../../../kernel';
import { DATABASE } from '../../../kernel/tokens';
// Port tokens and types only (no services): competition and identity depend on scheduling, so
// their implementations are resolved lazily by token, never imported (§4.2, no module cycle).
import {
  ROSTER_PORT,
  TEAM_ENTRY_QUERY_PORT,
  type RosterPort,
  type TeamEntryQueryPort,
} from '../../competition/ports';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity/identity.ports';
import { SchedulingActions } from '../scheduling.actions';
import { ClosureImpactContributors } from './closure-impact-contributors';
import { EventWriter } from './event-writer';
import { EventsService } from './events.service';
import { organizationOf } from './organization';

/** Default candidate step of the cross-resource grid (an hour: a grid, not a minute picker). */
const GRID_STEP_MINUTES = 60;

/**
 * Composed, read-only views of the schedule for staff screens (SPK-SCHED-003, SPK-SCHED-009,
 * SPK-UX-010): the event detail rail, page-header counts and cross-resource availability.
 * Participation, staff and team facts come from the modules that own them, through the closure
 * impact contributors they register with scheduling and their port tokens resolved lazily; a
 * module that is absent or does not answer leaves its section marked as not identified.
 */
@Injectable()
export class ScheduleInsightsService {
  private readonly logger = new Logger('ScheduleInsights');

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly moduleRef: ModuleRef,
    private readonly authorization: AuthorizationService,
    private readonly writer: EventWriter,
    private readonly events: EventsService,
    private readonly contributors: ClosureImpactContributors,
  ) {}

  private port<T>(token: InjectionToken): T | null {
    try {
      return this.moduleRef.get<T>(token, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * `GET /v1/events/{id}/detail` (staff, `scheduling.read_event_detail`; a viewer without it gets
   * the same protected NOT_FOUND as for an event they may not see, §4.10).
   */
  async eventDetail(principal: Principal, eventId: string): Promise<EventDetail> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const event = await this.writer.loadEvent(db as Db, organizationId, eventId);
    if (!event) throw errors.protectedNotFound('event');
    await this.authorization.require(principal, SchedulingActions.readEventDetail, {
      type: 'event',
      id: event.id,
      organizationId,
      facilityId: event.facility_id,
      protected: true,
    });
    const commitments = this.writer.commitmentsOf(event);
    const start = new Date(event.scheduled_start);

    // Teams: the event's team commitments, named by competition (team entry ids, SPK-SCHED-004).
    const entries = this.port<TeamEntryQueryPort>(TEAM_ENTRY_QUERY_PORT);
    const roster = this.port<RosterPort>(ROSTER_PORT);
    const teams: EventDetail['teams'] = [];
    for (const team of commitments.filter((c) => c.partyType === 'team')) {
      let teamName: string | null = null;
      let rosterSize: number | null = null;
      try {
        const entry = entries ? await entries.findTeamEntry(organizationId, team.partyId) : null;
        teamName = entry?.teamName ?? null;
        if (entry && roster) {
          rosterSize = (await roster.effectiveRoster(organizationId, team.partyId, start)).length;
        }
      } catch (error) {
        this.logger.warn(`team ${team.partyId} not answered: ${String(error)}`);
      }
      teams.push({ teamEntryId: team.partyId, role: team.role, teamName, rosterSize });
    }

    // Staff and participants: what the owning modules answer for this event (SPK-SCHED-009).
    const collected = await this.contributors.collect(db as Db, organizationId, [
      {
        eventId: event.id,
        kind: event.kind,
        scheduledStart: start.toISOString(),
        sourceType: event.source_type,
        sourceId: event.source_id,
        commitments,
      },
    ]);
    const staffPeople = [...new Set((collected.staff ?? []).map((a) => a.personId))];
    const directory = this.port<PersonDirectoryPort>(PERSON_DIRECTORY_PORT);
    const names =
      directory && staffPeople.length > 0
        ? await directory.displayNames(organizationId, staffPeople).catch(() => new Map())
        : new Map<string, { displayName: string }>();

    // Attendees: the participants the modules name, plus committed persons (counts only).
    const byVia = { commitment: 0, enrollment: 0, booking: 0, roster: 0 };
    const participants = new Set<string>();
    for (const c of collected.customers) {
      participants.add(c.personId);
      for (const via of c.via) byVia[via] += 1;
    }
    const committedPersons = commitments.filter(
      (c) => c.partyType === 'person' && c.role === 'participant',
    );
    for (const p of committedPersons) {
      if (!participants.has(p.partyId)) {
        participants.add(p.partyId);
        byVia.commitment += 1;
      }
    }
    const roles = new Map<string, number>();
    for (const c of commitments.filter((c) => c.partyType === 'person')) {
      roles.set(c.role, (roles.get(c.role) ?? 0) + 1);
    }

    return {
      event: this.writer.view(event),
      teams,
      staff: {
        identified: collected.staff !== null,
        assignments: (collected.staff ?? []).map((a) => ({
          assignmentId: a.assignmentId,
          personId: a.personId,
          displayName: names.get(a.personId)?.displayName ?? null,
          kind: a.kind,
          role: a.role,
          status: a.status,
        })),
      },
      committedPeople: [...roles.entries()]
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => a.role.localeCompare(b.role)),
      attendees: { total: participants.size, byVia },
      fixtureId: event.source_type === 'fixture' ? event.source_id : null,
      messageAudience: {
        teamEntryIds: teams.map((t) => t.teamEntryId),
        subjectPersonIds: [...participants].sort(),
      },
    };
  }

  /**
   * Counts of a facility's activities and closures overlapping a window (page headers;
   * `scheduling.read_schedule`). Bounded like every schedule window (31 days).
   */
  async windowSummary(
    principal: Principal,
    facilityId: string,
    window: Interval,
  ): Promise<ScheduleWindowSummary> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    await this.writer.loadFacility(db as Db, organizationId, facilityId);
    await this.authorization.require(principal, SchedulingActions.readSchedule, {
      type: 'schedule',
      organizationId,
      facilityId,
    });
    const start = new Date(window.start);
    const end = new Date(window.end);
    if (!(start < end)) throw errors.validation('The window must start before it ends.');
    const rows = await db
      .selectFrom('events')
      .select(['status', 'kind', 'sport', sql<number>`count(*)::int`.as('n')])
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('scheduled_start', '<', end)
      .where('scheduled_end', '>', start)
      .groupBy(['status', 'kind', 'sport'])
      .execute();
    const activities: ScheduleWindowSummary['activities'] = {
      total: 0,
      published: 0,
      draft: 0,
      canceled: 0,
      byKind: {},
      bySport: {},
    };
    for (const r of rows) {
      const n = Number(r.n);
      activities[r.status] += n;
      if (r.status === 'canceled') continue;
      activities.total += n;
      activities.byKind[r.kind] = (activities.byKind[r.kind] ?? 0) + n;
      const sport = r.sport ?? 'unspecified';
      activities.bySport[sport] = (activities.bySport[sport] ?? 0) + n;
    }
    const closures = await db
      .selectFrom('closures')
      .select(['status', sql<number>`count(*)::int`.as('n')])
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('status', 'in', ['active', 'pending'])
      .where(sql<boolean>`during && ${tstzrange(start, end)}`)
      .groupBy('status')
      .execute();
    const count = (status: string) => Number(closures.find((c) => c.status === status)?.n ?? 0);
    return {
      facilityId,
      window: { start: start.toISOString(), end: end.toISOString() },
      activities,
      closures: { active: count('active'), pending: count('pending') },
    };
  }

  /**
   * `GET /v1/resource-availability`: free start times per resource of a facility, each computed exactly as
   * `GET /v1/resources/{id}/availability` computes it (SPK-SCHED-002/003). Closed resources and
   * resources that do not support the requested sport are left out; at most
   * FACILITY_AVAILABILITY_MAX_RESOURCES resources (narrow by kind) over at most
   * FACILITY_AVAILABILITY_MAX_SPAN_DAYS days.
   */
  async facilityAvailability(
    principal: Principal,
    query: FacilityAvailabilityQuery,
  ): Promise<FacilityAvailability> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    await this.writer.loadFacility(db as Db, organizationId, query.facilityId);
    await this.authorization.require(principal, SchedulingActions.readSchedule, {
      type: 'schedule',
      organizationId,
      facilityId: query.facilityId,
    });
    const span = Date.parse(query.end) - Date.parse(query.start);
    if (!(span > 0) || span > FACILITY_AVAILABILITY_MAX_SPAN_DAYS * 86_400_000) {
      throw errors.validation(
        `The window is at most ${FACILITY_AVAILABILITY_MAX_SPAN_DAYS} days.`,
        { path: 'end', maxSpanDays: FACILITY_AVAILABILITY_MAX_SPAN_DAYS },
      );
    }
    let q = db
      .selectFrom('resources')
      .select(['id', 'name', 'kind', 'parent_resource_id', 'compatible_sports'])
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', query.facilityId)
      .where('status', '<>', 'closed')
      .orderBy('name')
      .orderBy('id');
    if (query.resourceKind) q = q.where('kind', '=', query.resourceKind);
    const sport = query.sport;
    const resources = (await q.execute()).filter(
      (r) => !sport || r.compatible_sports.length === 0 || r.compatible_sports.includes(sport),
    );
    if (resources.length > FACILITY_AVAILABILITY_MAX_RESOURCES) {
      throw errors.validation(
        `More than ${FACILITY_AVAILABILITY_MAX_RESOURCES} resources match; narrow by resourceKind.`,
        { code: 'TOO_MANY_RESOURCES', limit: FACILITY_AVAILABILITY_MAX_RESOURCES },
      );
    }
    const stepMinutes = query.stepMinutes ?? GRID_STEP_MINUTES;
    const out: FacilityAvailability['resources'] = [];
    for (const r of resources) {
      const slots = await this.events.findAvailableSlots(principal, {
        resourceId: r.id,
        interval: { start: query.start, end: query.end },
        durationMinutes: query.durationMinutes,
        stepMinutes,
      });
      out.push({
        resourceId: r.id,
        name: r.name,
        kind: r.kind,
        parentResourceId: r.parent_resource_id,
        slots,
      });
    }
    return {
      facilityId: query.facilityId,
      window: {
        start: new Date(query.start).toISOString(),
        end: new Date(query.end).toISOString(),
      },
      durationMinutes: query.durationMinutes,
      stepMinutes,
      resources: out,
    };
  }
}
