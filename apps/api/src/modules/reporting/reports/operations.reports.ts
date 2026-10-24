import { Inject, Injectable } from '@nestjs/common';
import type { AssignmentTargetType, FixtureReadiness, ReportRow } from '@sportspark/contracts';
import { ReadinessService } from '../../competition';
import { ASSIGNMENT_COVERAGE_PORT, type AssignmentCoveragePort } from '../../workforce';
import { column, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import { iso, localDays, metricValue, ratio, HOUR_MS } from '../reporting.shared';

const LIVE_NOTE =
  'Evaluated live from the owning module at the request instant; a past as-of instant cannot be reconstructed. The stored report run is the reproducible record.';

/**
 * R04 match readiness, R05 uncovered assignments, R11 maintenance restrictions and R12
 * communication failures (SPK-REPORT-002). Readiness comes from the competition module's
 * ReadinessService and coverage from the workforce module's ASSIGNMENT_COVERAGE_PORT (their
 * exported query services); the rest is read through the views of migration 1300.
 */
@Injectable()
export class OperationsReports {
  constructor(
    private readonly readiness: ReadinessService,
    @Inject(ASSIGNMENT_COVERAGE_PORT) private readonly coverage: AssignmentCoveragePort,
  ) {}

  readonly matchReadiness: ReportDefinition<'match_readiness'> = {
    key: 'match_readiness',
    title: 'Match readiness',
    requirementIds: ['SPK-REPORT-002', 'SPK-READY-001', 'SPK-READY-002'],
    viewAction: ReportingActions.viewOperationsReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'none',
    pointInTimeNote: LIVE_NOTE,
    compute: async (ctx, params) => {
      const facility = ctx.facility!;
      const days = localDays(facility.timezone, params.from, params.to, ctx.policy.maxPeriodDays);
      const fixtures = await ctx.db
        .selectFrom('reporting_fixtures_v')
        .select(['fixture_id', 'division_id', 'scheduled_start', 'status'])
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('scheduled_start', '>=', new Date(days[0]!.start))
        .where('scheduled_start', '<', new Date(days[days.length - 1]!.end))
        .where('status', 'not in', ['canceled', 'played', 'forfeit'])
        .orderBy('scheduled_start')
        .orderBy('fixture_id')
        .execute();
      const counts = { ready: 0, warning: 0, blocked: 0, unknown: 0 };
      const severities = { blocking: 0, warning: 0, info: 0, unknown: 0 };
      const rows: ReportRow[] = [];
      for (const f of fixtures) {
        // Authorization is the report's (view_operations_reports); the evaluation itself runs as
        // the organization's system principal so it sees every source the readiness rules read.
        const evaluation: FixtureReadiness = await this.readiness.evaluate(
          ctx.system,
          f.fixture_id,
        );
        counts[evaluation.status] += 1;
        const bySeverity = { blocking: 0, warning: 0, info: 0, unknown: 0 };
        for (const issue of evaluation.issues) {
          bySeverity[issue.severity] += 1;
          severities[issue.severity] += 1;
        }
        rows.push({
          fixtureId: f.fixture_id,
          divisionId: f.division_id,
          scheduledStart: f.scheduled_start ? iso(f.scheduled_start) : null,
          status: evaluation.status,
          blocking: bySeverity.blocking,
          warnings: bySeverity.warning,
          info: bySeverity.info,
          unknown: bySeverity.unknown,
          issueCodes: [
            ...new Set(evaluation.issues.filter((i) => i.severity !== 'info').map((i) => i.code)),
          ]
            .sort()
            .join(' '),
          evaluatedAt: evaluation.evaluatedAt,
        });
      }
      const known = counts.ready + counts.warning + counts.blocked;
      return {
        scope: { from: params.from, to: params.to },
        values: [
          metricValue(
            'MET-013',
            'Fixtures ready (no blocking issue)',
            'count',
            counts.ready + counts.warning,
          ),
          metricValue('MET-013', 'Fixtures blocked', 'count', counts.blocked),
          metricValue('MET-013', 'Fixtures with unknown readiness', 'count', counts.unknown),
          metricValue(
            'MET-014',
            'Readiness rate',
            'ratio',
            ratio(counts.ready + counts.warning, known),
            {
              unavailableReason: 'no fixture with a known evaluation in the window',
            },
          ),
          metricValue('MET-015', 'Blocking issues', 'count', severities.blocking, {
            dimensions: { severity: 'blocking' },
          }),
          metricValue('MET-015', 'Warnings', 'count', severities.warning, {
            dimensions: { severity: 'warning' },
          }),
          metricValue('MET-015', 'Informational issues', 'count', severities.info, {
            dimensions: { severity: 'info' },
          }),
          metricValue('MET-015', 'Unknown evidence', 'count', severities.unknown, {
            dimensions: { severity: 'unknown' },
          }),
        ],
        columns: [
          column('fixtureId', 'Fixture', 'id'),
          column('divisionId', 'Division', 'id'),
          column('scheduledStart', 'Scheduled start', 'instant'),
          column('status', 'Readiness'),
          column('blocking', 'Blocking', 'count'),
          column('warnings', 'Warnings', 'count'),
          column('info', 'Info', 'count'),
          column('unknown', 'Unknown', 'count'),
          column('issueCodes', 'Issue codes'),
          column('evaluatedAt', 'Evaluated at', 'instant'),
        ],
        rows,
        disclosures: [
          'Readiness is derived on every read (SPK-READY-004); unknown evidence is never counted as ready (SPK-READY-002).',
          'Issue codes only: restricted sources (discipline, disputes) are not identified in this report (SPK-DISC-004).',
        ],
      };
    },
  };

  readonly uncoveredAssignments: ReportDefinition<'uncovered_assignments'> = {
    key: 'uncovered_assignments',
    title: 'Uncovered assignments',
    requirementIds: ['SPK-REPORT-002', 'SPK-STAFF-002'],
    viewAction: ReportingActions.viewOperationsReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'none',
    pointInTimeNote: LIVE_NOTE,
    compute: async (ctx, params) => {
      const facility = ctx.facility!;
      const days = localDays(facility.timezone, params.from, params.to, ctx.policy.maxPeriodDays);
      const requirements = await ctx.db
        .selectFrom('reporting_assignment_requirements_v')
        .select(['requirement_id', 'target_type', 'target_id', 'target_start', 'target_title'])
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('target_start', '>=', new Date(days[0]!.start))
        .where('target_start', '<', new Date(days[days.length - 1]!.end))
        .orderBy('target_start')
        .orderBy('requirement_id')
        .execute();
      const targets = new Map<string, (typeof requirements)[number]>();
      for (const r of requirements) targets.set(`${r.target_type}:${r.target_id}`, r);
      let required = 0;
      let covered = 0;
      const rows: ReportRow[] = [];
      for (const target of targets.values()) {
        const roles = await this.coverage.coverage(
          ctx.organizationId,
          target.target_type as AssignmentTargetType,
          target.target_id,
        );
        for (const role of roles) {
          if (!role.mustBeAccepted) continue;
          const uncovered = role.uncoveredSlots.length;
          const acceptedSlots = Math.min(role.acceptedPersonIds.length, role.requiredCount);
          required += role.requiredCount;
          covered += acceptedSlots;
          rows.push({
            targetType: target.target_type,
            targetId: target.target_id,
            title: target.target_title,
            start: target.target_start ? iso(target.target_start) : null,
            requirementId: role.requirementId,
            kind: role.kind,
            role: role.role,
            required: role.requiredCount,
            accepted: acceptedSlots,
            offered: role.offered,
            proposed: role.proposed,
            uncovered,
          });
        }
      }
      return {
        scope: { from: params.from, to: params.to },
        values: [
          metricValue('MET-017', 'Uncovered required slots', 'count', required - covered),
          metricValue('MET-018', 'Assignment coverage rate', 'ratio', ratio(covered, required), {
            unavailableReason: 'no required slot in the window',
          }),
        ],
        columns: [
          column('targetType', 'Target type'),
          column('targetId', 'Target', 'id'),
          column('title', 'Title'),
          column('start', 'Start', 'instant'),
          column('requirementId', 'Requirement', 'id'),
          column('kind', 'Kind'),
          column('role', 'Role'),
          column('required', 'Required', 'count'),
          column('accepted', 'Accepted', 'count'),
          column('offered', 'Offered (not covering)', 'count'),
          column('proposed', 'Proposed (not covering)', 'count'),
          column('uncovered', 'Uncovered', 'count'),
        ],
        rows,
        disclosures: [
          'Only accepted or completed assignments cover a slot; proposed and offered assignments never do (SPK-STAFF-002).',
          'Assignees are not named in this report.',
        ],
      };
    },
  };

  readonly maintenanceRestrictions: ReportDefinition<'maintenance_restrictions'> = {
    key: 'maintenance_restrictions',
    title: 'Maintenance restrictions',
    requirementIds: ['SPK-REPORT-002', 'SPK-FAC-002', 'SPK-FAC-003', 'SPK-FAC-004'],
    viewAction: ReportingActions.viewOperationsReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'facility',
    pointInTime: 'none',
    pointInTimeNote: LIVE_NOTE,
    compute: async (ctx) => {
      const facility = ctx.facility!;
      const restrictions = await ctx.db
        .selectFrom('reporting_restrictions_v')
        .selectAll()
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('status', 'in', ['approved', 'active'])
        .where('starts_at', '<=', ctx.asOf)
        .where('ends_at', '>', ctx.asOf)
        .orderBy('starts_at')
        .orderBy('restriction_id')
        .execute();
      const tasks = await ctx.db
        .selectFrom('reporting_maintenance_tasks_v')
        .select(['task_id', 'resource_id', 'asset_id', 'severity', 'status', 'due_at'])
        .where('organization_id', '=', ctx.organizationId)
        .where('facility_id', '=', facility.id)
        .where('status', 'in', ['open', 'assigned', 'in_progress'])
        .orderBy('due_at')
        .orderBy('task_id')
        .execute();
      const rows: ReportRow[] = [];
      let awaitingRelease = 0;
      for (const r of restrictions) {
        const awaiting = r.task_status === 'resolved' || r.task_status === 'closed';
        if (awaiting) awaitingRelease += 1;
        rows.push({
          section: 'restriction',
          id: r.restriction_id,
          resourceId: r.resource_id,
          resourceName: r.resource_name,
          kind: r.kind,
          severity: null,
          from: iso(r.starts_at),
          to: iso(r.ends_at),
          dueAt: null,
          affectedUnits: r.affected_unit_count,
          source: r.task_id
            ? 'maintenance_task'
            : r.preventive_schedule_id
              ? 'preventive_schedule'
              : 'manual',
          awaitingRelease: awaiting,
          hoursOverdue: null,
        });
      }
      let overdue = 0;
      let noDueDate = 0;
      for (const t of tasks) {
        if (t.due_at === null) {
          noDueDate += 1;
          continue;
        }
        const late = ctx.asOf.getTime() - new Date(t.due_at).getTime();
        if (late <= 0) continue;
        overdue += 1;
        rows.push({
          section: 'overdue_task',
          id: t.task_id,
          resourceId: t.resource_id,
          resourceName: null,
          kind: null,
          severity: t.severity,
          from: null,
          to: null,
          dueAt: iso(t.due_at),
          affectedUnits: null,
          source: null,
          awaitingRelease: null,
          hoursOverdue: Math.floor(late / HOUR_MS),
        });
      }
      return {
        scope: { from: null, to: null },
        values: [
          metricValue('MET-054', 'Active operating restrictions', 'count', restrictions.length),
          metricValue('MET-056', 'Overdue maintenance tasks', 'count', overdue),
          metricValue('MET-056', 'Open tasks without a due date', 'count', noDueDate),
          metricValue(
            'MET-056',
            'Overdue share of open tasks',
            'ratio',
            ratio(overdue, tasks.length),
            {
              unavailableReason: 'no open task',
            },
          ),
          metricValue('MET-057', 'Awaiting inspection or release', 'count', awaitingRelease),
        ],
        columns: [
          column('section', 'Section'),
          column('id', 'Record', 'id'),
          column('resourceId', 'Space', 'id'),
          column('resourceName', 'Space name'),
          column('kind', 'Restriction kind'),
          column('severity', 'Task severity'),
          column('from', 'From', 'instant'),
          column('to', 'To', 'instant'),
          column('dueAt', 'Due', 'instant'),
          column('affectedUnits', 'Affected conflict units', 'count'),
          column('source', 'Source'),
          column('awaitingRelease', 'Awaiting release', 'boolean'),
          column('hoursOverdue', 'Hours overdue', 'count'),
        ],
        rows,
        disclosures: [
          'A restriction stays in force until its authorized release, even after its task is resolved (SPK-FAC-004).',
        ],
      };
    },
  };

  readonly communicationFailures: ReportDefinition<'communication_failures'> = {
    key: 'communication_failures',
    title: 'Communication failures',
    requirementIds: ['SPK-REPORT-002', 'SPK-COMMS-003', 'SPK-COMMS-004', 'SPK-UX-006'],
    viewAction: ReportingActions.viewOperationsReports,
    exportAction: ReportingActions.exportOperational,
    scope: 'organization',
    pointInTime: 'none',
    pointInTimeNote: LIVE_NOTE,
    compute: async (ctx, params) => {
      const start = new Date(params.periodStart);
      const end = new Date(params.periodEnd);
      const attempts = await ctx.db
        .selectFrom('reporting_delivery_attempts_v')
        .select([
          'notification_id',
          'notification_kind',
          'category',
          'channel',
          'provider',
          'status',
          'attempted_at',
        ])
        .where('organization_id', '=', ctx.organizationId)
        .where('queued_at', '>=', start)
        .where('queued_at', '<', end)
        .execute();
      const byState = new Map<string, number>();
      for (const a of attempts) {
        const key = `${a.channel}|${a.status}|${a.category}`;
        byState.set(key, (byState.get(key) ?? 0) + 1);
      }
      const byNotification = new Map<string, typeof attempts>();
      for (const a of attempts) {
        const list = byNotification.get(a.notification_id) ?? [];
        list.push(a);
        byNotification.set(a.notification_id, list);
      }
      let essential = 0;
      let failedEssential = 0;
      const failedKinds = new Map<string, number>();
      for (const list of byNotification.values()) {
        if (list[0]!.category !== 'operational') continue;
        essential += 1;
        if (list.every((a) => a.status === 'failed')) {
          failedEssential += 1;
          failedKinds.set(
            list[0]!.notification_kind,
            (failedKinds.get(list[0]!.notification_kind) ?? 0) + 1,
          );
        }
      }
      const threshold = new Date(
        ctx.asOf.getTime() - ctx.policy.unknownDeliveryThresholdMinutes * 60_000,
      );
      const staleUnknown = await ctx.db
        .selectFrom('reporting_delivery_attempts_v')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('organization_id', '=', ctx.organizationId)
        .where('status', '=', 'unknown')
        .where((eb) =>
          eb.or([
            eb('attempted_at', '<', threshold),
            eb.and([eb('attempted_at', 'is', null), eb('queued_at', '<', threshold)]),
          ]),
        )
        .executeTakeFirst();
      const revoked = await ctx.db
        .selectFrom('reporting_notification_recipients_v')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('organization_id', '=', ctx.organizationId)
        .where('status', '=', 'revoked')
        .where('revoked_at', '>=', start)
        .where('revoked_at', '<', end)
        .executeTakeFirst();
      const rows: ReportRow[] = [...byState.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, count]) => {
          const [channel, status, category] = key.split('|');
          return {
            section: 'attempts',
            channel: channel ?? null,
            status: status ?? null,
            category: category ?? null,
            notificationKind: null,
            count,
          };
        });
      for (const [kind, count] of [...failedKinds.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        rows.push({
          section: 'failed_essential',
          channel: null,
          status: 'failed',
          category: 'operational',
          notificationKind: kind,
          count,
        });
      }
      return {
        scope: { from: iso(start), to: iso(end) },
        values: [
          metricValue('MET-059', 'Delivery attempts', 'count', attempts.length),
          metricValue(
            'MET-059',
            'Failed attempts',
            'count',
            attempts.filter((a) => a.status === 'failed').length,
            {
              dimensions: { state: 'failed' },
            },
          ),
          metricValue('MET-060', 'Failed essential notices', 'count', failedEssential),
          metricValue(
            'MET-060',
            'Failed essential share',
            'ratio',
            ratio(failedEssential, essential),
            {
              unavailableReason: 'no operational notice was attempted in the period',
            },
          ),
          metricValue(
            'MET-061',
            'Recipients withheld for revoked authority',
            'count',
            Number(revoked?.n ?? 0),
          ),
          metricValue(
            'MET-062',
            'Unknown deliveries past the threshold',
            'count',
            Number(staleUnknown?.n ?? 0),
            {
              dimensions: { thresholdMinutes: String(ctx.policy.unknownDeliveryThresholdMinutes) },
            },
          ),
        ],
        columns: [
          column('section', 'Section'),
          column('channel', 'Channel'),
          column('status', 'State'),
          column('category', 'Category'),
          column('notificationKind', 'Notification kind'),
          column('count', 'Count', 'count'),
        ],
        rows,
        disclosures: [
          `Unknown deliveries are reported after ${ctx.policy.unknownDeliveryThresholdMinutes} minutes (placeholder, DEC-015).`,
          'Promotional messages never count as essential failures (SPK-COMMS-007).',
        ],
      };
    },
  };
}
