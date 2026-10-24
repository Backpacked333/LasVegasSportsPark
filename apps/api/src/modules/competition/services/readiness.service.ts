import { Inject, Injectable } from '@nestjs/common';
import {
  systemPrincipal,
  type EligibilitySeverity,
  type Event,
  type FixtureReadiness,
  type FixtureReadinessIssue,
  type Principal,
  type ReadinessStatus,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import { CLOCK, DATABASE, type Clock } from '../../../kernel';
import { ClosuresService, EventsService, ResourcesService } from '../../scheduling';
import {
  FINANCIAL_CONDITIONS_PORT,
  FORMS_CHECK_PORT,
  type ConditionFinding,
  type FinancialConditionsPort,
  type FormsCheckPort,
} from '../competition-matches.ports';
import { loadRuleSetRow, loadSeasonRow } from '../competition.queries';
import { iso, organizationOf, ruleSetContentOf } from '../competition.shared';
import {
  READINESS_CHECK_REGISTRY,
  SUSPENSION_CHECK_PORT,
  type ReadinessCheckRegistry,
  type ReadinessIssue,
  type SuspensionCheckPort,
} from '../ports';
import { DisputesService } from './disputes.service';
import { EligibilityService } from './eligibility.service';
import { FixturesService } from './fixtures.service';
import { RosterService } from './roster.service';
import { TeamEntriesService } from './team-entries.service';

interface IssueInput {
  code: string;
  severity: EligibilitySeverity;
  message: string;
  source: { type: string; id: string | null };
  responsibleRole: string;
  requiredAction: string;
  deadline?: string | null;
}

/**
 * Match readiness (SPK-READY-001..004, §4.8 `GET /v1/fixtures/{id}/readiness`). Derived on every
 * read from authoritative records — never a stored "ready" flag: the published time and field and
 * the field's operational status come from the scheduling module, team approval and rosters from
 * part 1, eligibility (including suspensions through the discipline port) from the eligibility
 * port, required officials from the readiness check registry (workforce), forms and financial
 * conditions from their ports, disputes from this module. Each issue carries severity (blocking,
 * warning, info or unknown), reason, source record, responsible role, required action, the
 * evaluation instant and a deadline (SPK-READY-002/003). Unknown evidence is reported as unknown,
 * never as ready; a missing RSVP alone is informational.
 */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly fixtures: FixturesService,
    private readonly entries: TeamEntriesService,
    private readonly roster: RosterService,
    private readonly eligibility: EligibilityService,
    private readonly events: EventsService,
    private readonly closures: ClosuresService,
    private readonly resources: ResourcesService,
    private readonly disputes: DisputesService,
    @Inject(READINESS_CHECK_REGISTRY) private readonly registry: ReadinessCheckRegistry,
    @Inject(SUSPENSION_CHECK_PORT) private readonly suspensions: SuspensionCheckPort,
    @Inject(FORMS_CHECK_PORT) private readonly forms: FormsCheckPort,
    @Inject(FINANCIAL_CONDITIONS_PORT) private readonly finance: FinancialConditionsPort,
  ) {}

  async evaluate(principal: Principal, fixtureId: string): Promise<FixtureReadiness> {
    const organizationId = organizationOf(principal);
    // Authorization: whoever may read the fixture may read its readiness (protected NOT_FOUND, §4.10).
    const detail = await this.fixtures.get(principal, fixtureId);
    const now = this.clock.now();
    const evaluatedAt = iso(now);
    const at = detail.scheduledStart ? new Date(detail.scheduledStart) : now;
    const deadline = detail.scheduledStart;
    const system = systemPrincipal(organizationId, 'competition.readiness');
    const issues: FixtureReadinessIssue[] = [];
    const checks: FixtureReadiness['checks'] = [];
    const add = (check: string, input: IssueInput): void => {
      issues.push({
        code: input.code,
        severity: input.severity,
        message: input.message,
        source: input.source,
        responsibleRole: input.responsibleRole,
        requiredAction: input.requiredAction,
        lastEvaluatedAt: evaluatedAt,
        deadline: input.deadline === undefined ? deadline : input.deadline,
      });
      const outcome = checks.find((c) => c.name === check);
      if (outcome) outcome.issueCount += 1;
    };
    const check = (name: string) => checks.push({ name, status: 'ready', issueCount: 0 });

    const season = await loadSeasonRow(this.db, organizationId, detail.seasonId);
    const ruleSet = season
      ? await loadRuleSetRow(this.db, organizationId, season.rule_set_id)
      : null;
    const rules = ruleSet ? ruleSetContentOf(ruleSet) : null;

    // 1. Published time and field (scheduling is the authority).
    check('schedule');
    let event: Event | null = null;
    if (detail.status === 'canceled' || detail.status === 'played' || detail.status === 'forfeit') {
      add('schedule', {
        code: `fixture_${detail.status}`,
        severity: 'info',
        message: `The fixture is ${detail.status}; readiness no longer applies.`,
        source: { type: 'fixture', id: fixtureId },
        responsibleRole: 'league_manager',
        requiredAction: 'None.',
      });
    } else if (detail.status !== 'scheduled' || !detail.schedulingEventId) {
      add('schedule', {
        code: 'not_scheduled',
        severity: 'blocking',
        message: `The fixture is ${detail.status}: no published time and field.`,
        source: { type: 'fixture', id: fixtureId },
        responsibleRole: 'scheduler',
        requiredAction: 'Schedule the fixture and publish the schedule.',
        deadline: null,
      });
    } else {
      event = await this.events.getEvent(system, detail.schedulingEventId);
      if (event.status !== 'published') {
        add('schedule', {
          code: 'event_not_published',
          severity: 'blocking',
          message: `The scheduling event is ${event.status}.`,
          source: { type: 'event', id: event.id },
          responsibleRole: 'scheduler',
          requiredAction: 'Publish the schedule draft that holds this game.',
        });
      }
    }

    // 2. Field operational status: resource inventory status and active closures.
    check('field');
    if (event) {
      for (const resourceId of event.resourceIds) {
        const resource = await this.resources.getResource(system, resourceId);
        if (resource.status === 'closed') {
          add('field', {
            code: 'resource_closed',
            severity: 'blocking',
            message: `${resource.name} is closed in the inventory.`,
            source: { type: 'resource', id: resource.id },
            responsibleRole: 'facilities_operator',
            requiredAction: 'Return the space to service or move the game.',
          });
        } else if (resource.status === 'restricted') {
          add('field', {
            code: 'resource_restricted',
            severity: 'warning',
            message: `${resource.name} is restricted in the inventory.`,
            source: { type: 'resource', id: resource.id },
            responsibleRole: 'facilities_operator',
            requiredAction: 'Confirm the restriction allows the game.',
          });
        }
      }
      const closures = await this.closures.listClosures(system, event.facilityId, 'active');
      for (const closure of closures) {
        const overlaps =
          new Date(closure.interval.start) < new Date(event.scheduledEnd) &&
          new Date(event.scheduledStart) < new Date(closure.interval.end);
        if (!overlaps) continue;
        const affects =
          closure.resourceId === null ||
          event.resourceIds.includes(closure.resourceId) ||
          (closure.impact?.affectedEvents.some((e) => e.eventId === event?.id) ?? false) ||
          (closure.resolution?.unresolvedEventIds.includes(event.id) ?? false);
        if (affects) {
          add('field', {
            code: 'field_closed',
            severity: 'blocking',
            message: `An active closure (${closure.reason}) covers the field at game time.`,
            source: { type: 'closure', id: closure.id },
            responsibleRole: 'scheduler',
            requiredAction: 'Move the game or lift the closure through the authorized procedure.',
          });
        }
      }
    }

    // 3. Required officials and other registered checks (workforce, finance, facilities …).
    check('officials');
    const registered = this.registry.checks();
    for (const { name, check: run } of registered) {
      if (!checks.some((c) => c.name === name)) check(name);
      const found: ReadinessIssue[] = await run({ organizationId, fixtureId, at });
      for (const issue of found) {
        add(name, {
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          source: issue.source,
          responsibleRole: issue.responsibleRole,
          requiredAction: issue.requiredAction,
          deadline: issue.deadline,
        });
      }
    }
    if (!registered.some((c) => c.name.startsWith('workforce.'))) {
      // Until the workforce module registers its check, officials are unknown, never ok (SPK-STAFF-002).
      add('officials', {
        code: 'officials_unknown',
        severity: 'unknown',
        message: 'No assignment authority is registered; accepted officials cannot be confirmed.',
        source: { type: 'fixture', id: fixtureId },
        responsibleRole: 'league_manager',
        requiredAction:
          'Confirm accepted official assignments once the workforce check is registered.',
      });
    }

    // 4 + 5. Team acceptance and minimum eligible roster per rule set.
    check('teams');
    check('rosters');
    const sides: FixtureReadiness['sides'] = [];
    const allPersons = new Set<string>();
    const minimum = rules?.minimumPlayers ?? 0;
    for (const side of [detail.home, detail.away]) {
      if (!side) continue;
      const entry = await this.entries.findTeamEntry(organizationId, side.entryId);
      if (!entry) continue;
      if (entry.status !== 'approved') {
        add('teams', {
          code: 'entry_not_approved',
          severity: 'blocking',
          message: `${side.teamName}'s entry is ${entry.status}.`,
          source: { type: 'team_entry', id: entry.id },
          responsibleRole: 'league_manager',
          requiredAction: 'Approve the entry or replace the fixture.',
        });
      }
      const members = await this.roster.effectiveRoster(organizationId, side.entryId, at);
      let eligible = 0;
      let unknown = 0;
      for (const member of members) {
        allPersons.add(member.personId);
        const evaluation = await this.eligibility.evaluatePlayer(
          organizationId,
          side.entryId,
          member.personId,
          at,
          { existingMembership: true, fixtureId, membershipStatus: member.status },
        );
        if (evaluation.eligible) eligible += 1;
        else if (evaluation.reasons.every((r) => r.severity !== 'blocking')) unknown += 1;
        for (const reason of evaluation.reasons) {
          if (reason.code === 'suspended') {
            add('rosters', {
              code: 'player_suspended',
              severity: 'warning',
              message: `A player on ${side.teamName}'s roster is suspended for this fixture.`,
              source: reason.source,
              responsibleRole: 'captain',
              requiredAction: 'The player must not take part; the roster count excludes them.',
            });
          }
        }
      }
      if (eligible < minimum) {
        add('rosters', {
          code: 'insufficient_eligible_roster',
          severity: eligible + unknown >= minimum ? 'unknown' : 'blocking',
          message:
            eligible + unknown >= minimum
              ? `${side.teamName} has ${eligible} confirmed eligible players and ${unknown} with unknown evidence; ${minimum} are required.`
              : `${side.teamName} has ${eligible} eligible players; ${minimum} are required.`,
          source: { type: 'team_entry', id: side.entryId },
          responsibleRole: 'captain',
          requiredAction: 'Add eligible players or resolve the eligibility issues.',
        });
      }
      sides.push({
        teamEntryId: side.entryId,
        teamName: side.teamName,
        entryStatus: entry.status,
        rosterSize: members.length,
        eligiblePlayers: eligible,
        unknownPlayers: unknown,
        minimumPlayers: minimum,
      });
    }
    if (!detail.away) {
      add('teams', {
        code: 'bye',
        severity: 'info',
        message: 'This fixture is a bye.',
        source: { type: 'fixture', id: fixtureId },
        responsibleRole: 'league_manager',
        requiredAction: 'None.',
        deadline: null,
      });
    }

    // 6 + 7. Required forms and financial conditions (ports; unknown until registered).
    const conditionContext = {
      fixtureId,
      seasonId: detail.seasonId,
      teamEntryIds: sides.map((s) => s.teamEntryId),
      personIds: [...allPersons],
      at,
    };
    check('forms');
    for (const finding of await this.forms.requiredForms(organizationId, conditionContext)) {
      this.addCondition(add, 'forms', finding);
    }
    check('finance');
    for (const finding of await this.finance.fixtureConditions(organizationId, conditionContext)) {
      this.addCondition(add, 'finance', finding);
    }

    // 8. Unresolved suspensions: proposals awaiting approval about roster players.
    check('suspensions');
    if (allPersons.size > 0) {
      const proposed = await this.db
        .selectFrom('suspensions')
        .select(['id', 'subject_person_id'])
        .where('organization_id', '=', organizationId)
        .where('subject_person_id', 'in', [...allPersons])
        .where('status', '=', 'proposed')
        .execute();
      for (const row of proposed) {
        add('suspensions', {
          code: 'suspension_pending_approval',
          severity: 'unknown',
          message: 'A proposed suspension of a roster player awaits approval.',
          source: { type: 'suspension', id: row.id },
          responsibleRole: 'league_manager',
          requiredAction: 'Approve or overturn the proposed suspension before the game.',
        });
      }
    }

    // 9. Pending disputes affecting play.
    check('disputes');
    for (const dispute of await this.disputes.pendingForFixture(
      this.db,
      organizationId,
      fixtureId,
    )) {
      add('disputes', {
        code: 'dispute_pending',
        severity: 'warning',
        message: `A dispute on this fixture is ${dispute.status.replaceAll('_', ' ')}.`,
        source: { type: 'dispute', id: dispute.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Decide the dispute.',
      });
    }

    // 10. Material change notifications: a reschedule or postponement happened; delivery evidence
    //     belongs to the communications module, so until it reports, the notification is unknown.
    check('notifications');
    const changes = await this.db
      .selectFrom('audit_records')
      .select(['id', 'occurred_at'])
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', 'fixture')
      .where('target_id', '=', fixtureId)
      .where(
        sql<boolean>`details->>'change' in ('rescheduled', 'postponed', 'synced_from_scheduling')`,
      )
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .execute();
    for (const change of changes) {
      add('notifications', {
        code: 'change_notification_unknown',
        severity: 'unknown',
        message: `The fixture changed materially on ${iso(change.occurred_at)}; delivery of the change notice is not confirmed.`,
        source: { type: 'audit_record', id: change.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Confirm both teams received the change notice.',
      });
    }

    // 11. RSVP: informational only (SPK-READY-002 "a missing RSVP alone must not become a block").
    check('availability');
    for (const side of [detail.home, detail.away]) {
      if (!side) continue;
      if (side.availability.noResponse > 0) {
        add('availability', {
          code: 'rsvp_missing',
          severity: 'info',
          message: `${side.availability.noResponse} player(s) of ${side.teamName} have not responded.`,
          source: { type: 'team_entry', id: side.entryId },
          responsibleRole: 'captain',
          requiredAction: 'Ask players to respond; RSVP is not an eligibility condition.',
        });
      }
    }

    return {
      fixtureId,
      fixtureStatus: detail.status,
      status: statusOf(issues),
      evaluatedAt,
      scheduledStart: detail.scheduledStart,
      checks: summarize(checks, issues),
      issues,
      sides,
    };
  }

  private addCondition(
    add: (check: string, input: IssueInput) => void,
    check: string,
    finding: ConditionFinding,
  ): void {
    if (finding.status === 'satisfied') return;
    add(check, {
      code: finding.code,
      severity: finding.status === 'unknown' ? 'unknown' : 'blocking',
      message: finding.message,
      source: finding.source,
      responsibleRole: finding.responsibleRole,
      requiredAction: finding.requiredAction,
      deadline: finding.deadline,
    });
  }
}

/** SPK-READY-002: blocked when anything blocks; unknown when evidence is missing; warning; else ready. */
export function statusOf(issues: Array<{ severity: EligibilitySeverity }>): ReadinessStatus {
  if (issues.some((i) => i.severity === 'blocking')) return 'blocked';
  if (issues.some((i) => i.severity === 'unknown')) return 'unknown';
  if (issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'ready';
}

/** Per-check status from the issues recorded under it (issues are appended in check order). */
function summarize(
  checks: FixtureReadiness['checks'],
  issues: FixtureReadinessIssue[],
): FixtureReadiness['checks'] {
  let offset = 0;
  return checks.map((c) => {
    const own = issues.slice(offset, offset + c.issueCount);
    offset += c.issueCount;
    return { name: c.name, issueCount: c.issueCount, status: statusOf(own) };
  });
}
