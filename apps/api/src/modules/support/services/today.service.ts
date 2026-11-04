import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  errors,
  type AssignmentRequirement,
  type Event,
  type Principal,
  type ResolutionHistoryEntry,
  type TodayFeed,
  type TodayItem,
  type TodayQuery,
  type TodaySource,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  AuthorizationService,
  CLOCK,
  DATABASE,
  ExceptionActions,
  FacilityDirectory,
  OperationalExceptions,
  type Clock,
  listFacilityScope,
} from '../../../kernel';
import { MatchActions, ReadinessService } from '../../competition';
import { FacilitiesActions, RestrictionsService } from '../../facilities';
import { EventsService, addDays, localDateOf, resolveLocal } from '../../scheduling';
import {
  RequirementsService,
  WorkforceActions,
  coverageTargetKey,
  uncoveredDedupeKey,
} from '../../workforce';
import { SupportActions } from '../support.actions';
import { SUPPORT_POLICY, type SupportPolicy } from '../support.policy';
import { isPermissionError, minutesBetween, organizationOf } from '../support.shared';
import { ExceptionQueuesService } from './exception-queues.service';
import { ExceptionsService } from './exceptions.service';
import { NextActions, type ExceptionRow } from './next-actions';

const SEVERITY_RANK: Record<TodayItem['severity'], number> = {
  critical: 0,
  high: 1,
  warning: 2,
  info: 3,
};

/** The workforce target whose required roles an activity carries: its fixture, else the event. */
function coverageTargetOf(event: Event): { targetType: 'fixture' | 'event'; targetId: string } {
  return event.sourceType === 'fixture' && event.sourceId
    ? { targetType: 'fixture', targetId: event.sourceId }
    : { targetType: 'event', targetId: event.id };
}

interface FacilityDay {
  id: string;
  name: string;
  timezone: string;
  localDate: string;
  start: Date;
  end: Date;
}

/** A source's own result: how many items it gave and whether the per-request bound cut it short. */
interface SourceResult {
  count: number;
  truncated?: boolean;
  /** How many records the bound left out; null when unknown. */
  omitted?: number | null;
}

type SourceStatus = Pick<TodaySource, 'status' | 'count' | 'truncated' | 'omitted'>;

/** One facility's activities of the day, as the schedule source read them. */
interface FacilitySchedule {
  facility: FacilityDay;
  window: { start: string; end: string };
  events: Event[];
  /** The schedule held more activities than the per-facility bound. */
  truncated: boolean;
  status: SourceStatus;
}

/** SPK-UX-006 groups, derived from the owning module of an exception's category. */
function groupOf(category: string): TodayItem['group'] {
  if (category.startsWith('finance.')) return 'financial';
  if (category.startsWith('communications.')) return 'communications';
  if (category.startsWith('facilities.')) return 'maintenance';
  if (category.startsWith('workforce.')) return 'staffing';
  if (category.startsWith('enrollment.') || category.startsWith('catalog.')) return 'registration';
  if (category.startsWith('entry.') || category.includes('incident')) return 'incident';
  if (category.startsWith('competition.')) return 'match_readiness';
  return 'other';
}

/**
 * Today workspace (SPK-UX-006): one feed of the issues that need someone today, within the
 * viewer's scope. Sources are read with the VIEWER'S principal through the owning modules:
 *   - operational exceptions (kernel `OperationalExceptions.listOpen`), limited to the queues the
 *     viewer owns (oversight roles see every queue) and their facilities — this includes failed
 *     urgent communications, unknown financial outcomes and overdue maintenance, which those
 *     modules raise as exceptions;
 *   - today's fixture readiness blockers (competition `ReadinessService.evaluate`);
 *   - uncovered required assignments of today's activities (workforce `RequirementsService`), unless
 *     an open exception the viewer sees already covers the slot;
 *   - maintenance restrictions in effect or proposed today (facilities `RestrictionsService`).
 * A source the viewer may not read is reported `not_permitted` and contributes nothing. Every item
 * carries title, severity, affected record, owner queue, age, deadline, the next actions the
 * viewer is permitted to take and its resolution history. Derived conditions disappear only when
 * the owning module's state changes; closing an exception never hides them (SPK-UX-006).
 */
@Injectable()
export class TodayService {
  private readonly logger = new Logger(TodayService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SUPPORT_POLICY) private readonly policy: SupportPolicy,
    private readonly authorization: AuthorizationService,
    private readonly kernelExceptions: OperationalExceptions,
    private readonly exceptions: ExceptionsService,
    private readonly queues: ExceptionQueuesService,
    private readonly nextActions: NextActions,
    private readonly events: EventsService,
    private readonly readiness: ReadinessService,
    private readonly requirements: RequirementsService,
    private readonly restrictions: RestrictionsService,
    private readonly facilityDirectory: FacilityDirectory,
  ) {}

  async feed(principal: Principal, query: TodayQuery): Promise<TodayFeed> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SupportActions.readToday, {
      type: 'today',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    const now = this.clock.now();
    const facilities = await this.facilitiesFor(principal, organizationId, query.facilityId, now);
    const configured = await this.queues.configured(this.db, organizationId);
    const items: TodayItem[] = [];
    const sources: TodaySource[] = [];

    // 1. Operational exceptions (kernel), within facility and queue scope. R3-PERFORMANCE-01:
    // at most `todayExceptionLimit` are listed (each with its resolution history), most severe and
    // soonest due first; the rest are counted and summarised, and stay in GET /v1/exceptions.
    const coveredKeys = new Set<string>();
    {
      const status = await this.attempt(async () => {
        const rows = (await this.kernelExceptions.listOpen(
          principal,
          organizationId,
        )) as ExceptionRow[];
        const facilityIds = new Set(facilities.map((f) => f.id));
        const visible = rows.filter(
          (r) =>
            (r.facility_id === null || facilityIds.has(r.facility_id)) &&
            this.queues.visibleTo(principal, this.queues.resolve(r.owner_queue, configured)),
        );
        const levels = new Map(
          visible.map((r) => [r.id, this.exceptions.serviceLevelsOf(r, configured, now)]),
        );
        const dueAt = (r: ExceptionRow) =>
          levels.get(r.id)?.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
        // The feed's own order (severity, deadline, id), so the listed ones are the ones it shows first.
        const ranked = [...visible].sort(
          (a, b) =>
            SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
            dueAt(a) - dueAt(b) ||
            `exception:${a.id}`.localeCompare(`exception:${b.id}`),
        );
        const listed = ranked.slice(0, Math.max(0, this.policy.todayExceptionLimit));
        const left = ranked.slice(listed.length);
        const history = await this.exceptions.history(
          this.db,
          organizationId,
          listed.map((r) => r.id),
        );
        const keys: string[] = [];
        for (const row of listed) {
          // Only a listed exception stands in for the derived slot it owns; the slot of one left
          // out still shows as a coverage item.
          if (row.dedupe_key) keys.push(row.dedupe_key);
          const view = await this.exceptions.view(row, {
            principal,
            queues: configured,
            history,
            now,
          });
          items.push({
            id: `exception:${row.id}`,
            source: 'exception',
            group: groupOf(row.category),
            category: row.category,
            title: row.title,
            severity: row.severity,
            facilityId: row.facility_id,
            affected: view.affected,
            ownerQueue: row.owner_queue,
            status: row.status === 'acknowledged' ? 'acknowledged' : 'open',
            openedAt: view.openedAt,
            ageMinutes: view.ageMinutes,
            deadlineAt: view.deadlineAt,
            overdue: view.overdue,
            // SUP-01: the expectedRevision of the acknowledge, resolve and close steps.
            revision: row.revision,
            nextActions: view.nextActions,
            history: view.history,
            details: { ...view.details, exceptionId: row.id, revision: row.revision },
          });
        }
        if (left.length > 0) {
          items.push(await this.omittedExceptionsItem(principal, left, levels));
        }
        for (const k of keys) coveredKeys.add(k);
        return { count: listed.length, truncated: left.length > 0, omitted: left.length };
      }, items);
      sources.push({ source: 'kernel.operational_exceptions', facilityId: null, ...status });
    }

    // Today's activities of every facility in scope, read first so that the readiness budget is
    // spent on the fixtures that matter most across the whole read (R3-PERFORMANCE-01).
    const days: FacilitySchedule[] = [];
    for (const facility of facilities) {
      const window = { start: facility.start.toISOString(), end: facility.end.toISOString() };
      let events: Event[] = [];
      let truncated = false;
      const status = await this.attempt(async () => {
        const page = await this.events.listEvents(principal, {
          facilityId: facility.id,
          start: window.start,
          end: window.end,
          limit: this.policy.todayEventLimit,
        });
        events = page.items;
        truncated = page.nextCursor !== null;
        // Activities past the per-facility bound are not counted here: their number is unknown.
        return { count: events.length, truncated, omitted: null };
      });
      days.push({
        facility,
        window,
        events,
        truncated: status.status === 'ok' && truncated,
        status,
      });
    }
    const evaluated = this.readinessSelection(days, now);

    const facilityViews: TodayFeed['facilities'] = [];
    for (const day of days) {
      const { facility, window, events } = day;
      const scheduleStatus = day.status;
      sources.push({ source: 'scheduling.events', facilityId: facility.id, ...scheduleStatus });
      facilityViews.push({
        facilityId: facility.id,
        name: facility.name,
        timezone: facility.timezone,
        localDate: facility.localDate,
        window,
        activities: {
          total: events.length,
          published: events.filter((e) => e.status === 'published').length,
          canceled: events.filter((e) => e.status === 'canceled').length,
          visible: scheduleStatus.status === 'ok',
        },
      });
      const live = events.filter((e) => e.status !== 'canceled');

      // 2. Fixture readiness blockers (competition), for the fixtures the bound selected.
      if (scheduleStatus.status !== 'ok') {
        sources.push({
          source: 'competition.readiness',
          facilityId: facility.id,
          ...scheduleStatus,
        });
      } else {
        const status = await this.attempt(async () => {
          let count = 0;
          let readable = 0;
          const fixtures = live.filter(isFixtureEvent);
          const chosen = fixtures.filter((e) => evaluated.has(e.id));
          for (const event of chosen) {
            const item = await this.readinessItem(principal, event, now);
            if (item === 'not_permitted') continue;
            readable += 1;
            if (item) {
              items.push(item);
              count += 1;
            }
          }
          if (chosen.length > 0 && readable === 0) throw errors.accessDenied();
          const left = fixtures.filter((e) => !evaluated.has(e.id)).sort(readinessOrder(now));
          if (left.length > 0) {
            const omitted = await this.omittedReadinessItem(principal, facility, left, {
              evaluated: chosen.length,
              now,
            });
            // Nobody may read this facility's readiness: the source is not permitted, not partial.
            if (!omitted && readable === 0) throw errors.accessDenied();
            if (omitted) items.push(omitted);
          }
          return {
            count,
            truncated: left.length > 0 || day.truncated,
            omitted: day.truncated ? null : left.length,
          };
        }, items);
        sources.push({ source: 'competition.readiness', facilityId: facility.id, ...status });
      }

      // 3. Uncovered required assignments (workforce).
      if (scheduleStatus.status !== 'ok') {
        sources.push({ source: 'workforce.coverage', facilityId: facility.id, ...scheduleStatus });
      } else {
        const status = await this.attempt(async () => {
          let count = 0;
          let readable = 0;
          // R3-PERFORMANCE-01: one batched requirements-and-coverage read for the facility's live
          // activities, instead of one read per activity.
          const requirements = await this.requirements.listForTargets(
            principal,
            live.map(coverageTargetOf),
          );
          for (const event of live) {
            const target = coverageTargetOf(event);
            const produced = await this.coverageItems(
              principal,
              event,
              target,
              requirements.get(coverageTargetKey(target.targetType, target.targetId)) ?? [],
              facility,
              coveredKeys,
              now,
            );
            if (produced === 'not_permitted') continue;
            readable += 1;
            items.push(...produced);
            count += produced.length;
          }
          if (live.length > 0 && readable === 0) throw errors.accessDenied();
          // Activities past the schedule bound were not checked; their number is unknown.
          return { count, truncated: day.truncated, omitted: null };
        }, items);
        sources.push({ source: 'workforce.coverage', facilityId: facility.id, ...status });
      }

      // 4. Maintenance restrictions affecting today (facilities).
      const restrictionStatus = await this.attempt(async () => {
        const active = await this.restrictions.activeRestrictions(principal, facility.id, window);
        const proposed = (
          await this.restrictions.list(principal, { facilityId: facility.id, status: 'proposed' })
        ).filter(
          (r) =>
            new Date(r.interval.start).getTime() < facility.end.getTime() &&
            new Date(r.interval.end).getTime() > facility.start.getTime(),
        );
        for (const r of [...active, ...proposed]) {
          const isActive = r.status === 'active';
          items.push({
            id: `restriction:${r.id}`,
            source: 'restriction',
            group: 'maintenance',
            category: isActive
              ? 'facilities.restriction_active'
              : 'facilities.restriction_proposed',
            title: isActive
              ? `${r.kind.replaceAll('_', ' ')} restriction in effect: ${r.reason}`
              : `Proposed ${r.kind.replaceAll('_', ' ')} restriction awaiting approval: ${r.reason}`,
            severity: isActive ? 'warning' : 'info',
            facilityId: r.facilityId,
            affected: { type: 'resource', id: r.resourceId },
            ownerQueue: 'facilities_operator',
            status: 'unresolved',
            openedAt: r.approvedAt ?? r.createdAt,
            ageMinutes: minutesBetween(r.approvedAt ?? r.createdAt, now),
            deadlineAt: r.interval.end,
            overdue: false,
            revision: r.revision,
            nextActions: await this.nextActions.permitted(principal, [
              isActive
                ? {
                    definition: FacilitiesActions.releaseToService,
                    label: 'Release the area to service',
                    method: 'POST',
                    href: `/v1/maintenance-restrictions/${r.id}/release`,
                    facilityId: r.facilityId,
                  }
                : {
                    definition: FacilitiesActions.applyRestriction,
                    label: 'Review and approve the restriction',
                    method: 'POST',
                    href: `/v1/maintenance-restrictions/${r.id}/approve`,
                    facilityId: r.facilityId,
                  },
            ]),
            history: this.restrictionHistory(r),
            details: {
              restrictionId: r.id,
              kind: r.kind,
              interval: r.interval,
              taskId: r.taskId,
              affectedConflictUnitIds: r.affectedConflictUnitIds,
            },
          });
        }
        return active.length + proposed.length;
      }, items);
      sources.push({
        source: 'facilities.restrictions',
        facilityId: facility.id,
        ...restrictionStatus,
      });
    }

    items.sort((a, b) => {
      const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (s !== 0) return s;
      const da = a.deadlineAt ? new Date(a.deadlineAt).getTime() : Number.POSITIVE_INFINITY;
      const db = b.deadlineAt ? new Date(b.deadlineAt).getTime() : Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.id.localeCompare(b.id);
    });
    return { generatedAt: now.toISOString(), facilities: facilityViews, items, sources };
  }

  /**
   * R3-PERFORMANCE-01: the fixture events whose readiness this read evaluates — at most
   * `todayReadinessLimit` across every facility whose schedule was read, in `readinessOrder`.
   * Each evaluation derives the fixture's readiness from its authoritative records (SPK-READY-004),
   * so the bound is what keeps one read of Today bounded on a busy league night.
   */
  private readinessSelection(days: readonly FacilitySchedule[], now: Date): Set<string> {
    const candidates = days
      .filter((d) => d.status.status === 'ok')
      .flatMap((d) => d.events.filter((e) => e.status !== 'canceled' && isFixtureEvent(e)));
    candidates.sort(readinessOrder(now));
    return new Set(
      candidates.slice(0, Math.max(0, this.policy.todayReadinessLimit)).map((e) => e.id),
    );
  }

  /**
   * One item naming the exceptions the bound left out (R3-PERFORMANCE-01): how many, by severity
   * and queue, as severe as the most severe of them, with the full list as the next action.
   */
  private async omittedExceptionsItem(
    principal: Principal,
    left: readonly ExceptionRow[],
    levels: ReadonlyMap<string, { deadline: Date | null; overdue: boolean }>,
  ): Promise<TodayItem> {
    const lead = left[0] as ExceptionRow;
    const deadlines = left
      .map((r) => levels.get(r.id)?.deadline?.getTime())
      .filter((d): d is number => d !== undefined);
    const tally = (key: (r: ExceptionRow) => string) =>
      left.reduce<Record<string, number>>((acc, r) => {
        acc[key(r)] = (acc[key(r)] ?? 0) + 1;
        return acc;
      }, {});
    return {
      id: 'exceptions-omitted',
      source: 'exception',
      group: 'other',
      category: 'support.today_exceptions_omitted',
      title: `${left.length} more open exception(s) in your queues are not listed here`,
      severity: lead.severity,
      facilityId: null,
      affected: null,
      ownerQueue: lead.owner_queue,
      status: 'unresolved',
      openedAt: null,
      ageMinutes: null,
      deadlineAt: deadlines.length > 0 ? new Date(Math.min(...deadlines)).toISOString() : null,
      overdue: left.some((r) => levels.get(r.id)?.overdue === true),
      revision: null,
      nextActions: await this.nextActions.permitted(principal, [
        {
          definition: ExceptionActions.read,
          label: 'Open the full exception list',
          method: 'GET',
          href: '/v1/exceptions',
          facilityId: null,
        },
      ]),
      history: [],
      details: {
        omitted: left.length,
        listed: this.policy.todayExceptionLimit,
        bySeverity: tally((r) => r.severity),
        byQueue: tally((r) => r.owner_queue),
      },
    };
  }

  /**
   * One item per facility naming the fixtures whose readiness the bound did not evaluate
   * (R3-PERFORMANCE-01). Their readiness is unknown here, never ready (SPK-READY-002): a warning
   * that points at the next of them. Null when the viewer may not read readiness at this facility.
   */
  private async omittedReadinessItem(
    principal: Principal,
    facility: FacilityDay,
    left: readonly Event[],
    context: { evaluated: number; now: Date },
  ): Promise<TodayItem | null> {
    const next = left[0] as Event;
    const fixtureId = next.sourceId as string;
    const nextActions = await this.nextActions.permitted(principal, [
      {
        definition: MatchActions.readReadiness,
        label: `Explain readiness: ${next.title}`,
        method: 'GET',
        href: `/v1/fixtures/${fixtureId}/readiness`,
        facilityId: facility.id,
      },
    ]);
    if (nextActions.length === 0) return null;
    const upcoming = new Date(next.scheduledEnd).getTime() > context.now.getTime();
    return {
      id: `readiness-omitted:${facility.id}`,
      source: 'readiness',
      group: 'match_readiness',
      category: 'competition.readiness_not_evaluated',
      title: `${facility.name}: readiness of ${left.length} more fixture(s) today is not checked here`,
      severity: 'warning',
      facilityId: facility.id,
      affected: { type: 'fixture', id: fixtureId },
      ownerQueue: 'league_manager',
      status: 'unresolved',
      openedAt: null,
      ageMinutes: null,
      deadlineAt: upcoming ? new Date(next.scheduledStart).toISOString() : null,
      overdue: false,
      revision: null,
      nextActions,
      history: [],
      details: {
        omitted: left.length,
        evaluated: context.evaluated,
        limit: this.policy.todayReadinessLimit,
        fixtures: left.map((e) => ({
          fixtureId: e.sourceId,
          eventId: e.id,
          title: e.title,
          scheduledStart: e.scheduledStart,
          scheduledEnd: e.scheduledEnd,
        })),
      },
    };
  }

  /** One item per fixture with blocking issues (or unconfirmed evidence, as information). */
  private async readinessItem(
    principal: Principal,
    event: Event,
    now: Date,
  ): Promise<TodayItem | null | 'not_permitted'> {
    let readiness;
    try {
      readiness = await this.readiness.evaluate(principal, event.sourceId as string);
    } catch (error) {
      if (isPermissionError(error)) return 'not_permitted';
      throw error;
    }
    // Required officials are reported by the coverage source (workforce) to avoid duplicates.
    const issues = readiness.issues.filter(
      (i) => i.source.type !== 'assignment_requirement' && i.severity !== 'info',
    );
    const blocking = issues.filter((i) => i.severity === 'blocking');
    if (blocking.length === 0 && !(this.policy.showUnconfirmedReadiness && issues.length > 0)) {
      return null;
    }
    const lead = blocking[0] ?? issues[0];
    const start = new Date(event.scheduledStart);
    return {
      id: `readiness:${readiness.fixtureId}`,
      source: 'readiness',
      group: 'match_readiness',
      category:
        blocking.length > 0 ? 'competition.readiness_blocked' : 'competition.readiness_unconfirmed',
      title:
        blocking.length > 0
          ? `${event.title}: ${blocking.length} blocking readiness issue(s)`
          : `${event.title}: readiness not confirmed (${issues.length} open check(s))`,
      severity: blocking.length > 0 ? 'high' : 'info',
      facilityId: event.facilityId,
      affected: { type: 'fixture', id: readiness.fixtureId },
      ownerQueue: lead?.responsibleRole ?? 'league_manager',
      status: 'unresolved',
      openedAt: null,
      ageMinutes: null,
      deadlineAt: start.toISOString(),
      overdue: blocking.length > 0 && start.getTime() < now.getTime(),
      revision: null,
      nextActions: await this.nextActions.permitted(principal, [
        {
          definition: MatchActions.readReadiness,
          label: 'Explain readiness',
          method: 'GET',
          href: `/v1/fixtures/${readiness.fixtureId}/readiness`,
          facilityId: event.facilityId,
        },
      ]),
      history: [],
      details: {
        fixtureId: readiness.fixtureId,
        eventId: event.id,
        readinessStatus: readiness.status,
        evaluatedAt: readiness.evaluatedAt,
        issues: issues.map((i) => ({
          code: i.code,
          severity: i.severity,
          message: i.message,
          responsibleRole: i.responsibleRole,
          requiredAction: i.requiredAction,
        })),
      },
    };
  }

  private async coverageItems(
    principal: Principal,
    event: Event,
    target: { targetType: 'fixture' | 'event'; targetId: string },
    requirements: AssignmentRequirement[] | 'not_permitted',
    facility: FacilityDay,
    coveredKeys: ReadonlySet<string>,
    now: Date,
  ): Promise<TodayItem[] | 'not_permitted'> {
    if (requirements === 'not_permitted') return 'not_permitted';
    const out: TodayItem[] = [];
    const start = new Date(event.scheduledStart);
    for (const req of requirements) {
      if (!req.mustBeAccepted) continue;
      for (const slot of req.coverage.uncoveredSlots) {
        // An open exception the viewer sees already owns this slot (workforce escalation).
        if (
          coveredKeys.has(uncoveredDedupeKey(target.targetType, target.targetId, req.role, slot))
        ) {
          continue;
        }
        const ownerQueue = target.targetType === 'fixture' ? 'league_manager' : 'scheduler';
        out.push({
          id: `coverage:${target.targetType}:${target.targetId}:${req.role}:${slot}`,
          source: 'coverage',
          group: 'staffing',
          category: 'workforce.uncovered_assignment',
          title: `Uncovered ${req.role.replaceAll('_', ' ')} (slot ${slot}) for ${event.title}`,
          severity: 'high',
          facilityId: facility.id,
          affected: { type: target.targetType, id: target.targetId },
          ownerQueue,
          status: 'unresolved',
          openedAt: null,
          ageMinutes: null,
          deadlineAt: start.toISOString(),
          overdue: start.getTime() < now.getTime(),
          revision: null,
          nextActions: await this.nextActions.permitted(principal, [
            {
              definition: WorkforceActions.proposeAssignment,
              label: 'Offer the role to a qualified, available person',
              method: 'POST',
              href: '/v1/assignments',
              facilityId: facility.id,
            },
          ]),
          history: [],
          details: {
            requirementId: req.id,
            role: req.role,
            kind: req.kind,
            slot,
            requiredCount: req.requiredCount,
            accepted: req.coverage.accepted,
            offered: req.coverage.offered,
            proposed: req.coverage.proposed,
            eventId: event.id,
          },
        });
      }
    }
    return out;
  }

  private restrictionHistory(r: {
    createdAt: string;
    approvedAt: string | null;
    approvedBy: { actorLabel: string } | null;
  }): ResolutionHistoryEntry[] {
    const history: ResolutionHistoryEntry[] = [
      {
        at: r.createdAt,
        action: 'facilities.restriction_proposed',
        actorLabel: 'facilities',
        reason: null,
      },
    ];
    if (r.approvedAt) {
      history.push({
        at: r.approvedAt,
        action: 'facilities.restriction_approved',
        actorLabel: r.approvedBy?.actorLabel ?? 'facilities',
        reason: null,
      });
    }
    return history;
  }

  /** The facilities in the viewer's scope (or the one asked for) with today's local window. */
  private async facilitiesFor(
    principal: Principal,
    organizationId: string,
    facilityId: string | undefined,
    now: Date,
  ): Promise<FacilityDay[]> {
    // §4.2 (SUP-02): the kernel's facility directory (K-04), never its table.
    let rows: Array<{ id: string; name: string; timezone: string }>;
    if (facilityId) {
      const found = (await this.facilityDirectory.describe(organizationId, [facilityId])).get(
        facilityId,
      );
      if (!found) throw errors.notFound('facility', facilityId);
      rows = [found];
    } else {
      rows = await this.facilityDirectory.list(organizationId, { statuses: ['active'] });
      // §4.3, §4.14: the facilities of the roles that hold the Today read action (identity-05).
      const scope = listFacilityScope(principal, SupportActions.readToday);
      if (scope) {
        const allowed = new Set(scope);
        rows = rows.filter((f) => allowed.has(f.id));
      }
    }
    return rows.map((f) => {
      // SPK-SCHED-008: "today" is the facility-local day, from local midnight to local midnight.
      const localDate = localDateOf(f.timezone, now);
      const start = resolveLocal(localDate, '00:00', f.timezone)?.instant ?? now;
      const end = resolveLocal(addDays(localDate, 1), '00:00', f.timezone)?.instant ?? now;
      return { id: f.id, name: f.name, timezone: f.timezone, localDate, start, end };
    });
  }

  /**
   * Runs one source. When it fails, the items it added are withdrawn, so a source is either
   * complete or absent (with its status), never half shown. A source the per-request bound cut
   * short says so (`truncated`, `omitted`, R3-PERFORMANCE-01).
   */
  private async attempt(
    fn: () => Promise<number | SourceResult>,
    items?: TodayItem[],
  ): Promise<SourceStatus> {
    const before = items?.length ?? 0;
    try {
      const result = await fn();
      const {
        count,
        truncated = false,
        omitted = 0,
      } = typeof result === 'number' ? { count: result } : result;
      return { status: 'ok', count, truncated, omitted: truncated ? omitted : 0 };
    } catch (error) {
      items?.splice(before);
      const failed = { count: 0, truncated: false, omitted: 0 };
      if (isPermissionError(error)) return { status: 'not_permitted', ...failed };
      this.logger.warn(`today source unavailable: ${String(error)}`);
      return { status: 'unavailable', ...failed };
    }
  }
}

/** A fixture's scheduling event (the readiness source evaluates the fixture it names). */
function isFixtureEvent(event: Event): boolean {
  return event.sourceType === 'fixture' && event.sourceId !== null;
}

/**
 * R3-PERFORMANCE-01: which fixtures' readiness matters most now — those still to finish, soonest
 * start first (in progress, then upcoming), then finished ones, latest first; ties by event id.
 */
function readinessOrder(now: Date): (a: Event, b: Event) => number {
  const finished = (e: Event) => new Date(e.scheduledEnd).getTime() <= now.getTime();
  return (a, b) => {
    const fa = finished(a);
    const fb = finished(b);
    if (fa !== fb) return fa ? 1 : -1;
    const sa = new Date(a.scheduledStart).getTime();
    const sb = new Date(b.scheduledStart).getTime();
    if (sa !== sb) return fa ? sb - sa : sa - sb;
    return a.id.localeCompare(b.id);
  };
}
