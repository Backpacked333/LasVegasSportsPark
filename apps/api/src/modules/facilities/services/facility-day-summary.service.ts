import { Inject, Injectable } from '@nestjs/common';
import { type FacilityDaySummary, type Principal } from '@sportspark/contracts';
import { tstzrange, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import { AuthorizationService, executorFor, type Clock } from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import {
  addDays,
  localDateOf,
  resolveLocal,
  SchedulingActions,
  ScheduleInsightsService,
} from '../../scheduling';
import { FacilitiesActions } from '../facilities.actions';
import { FacilitiesReader, organizationOf } from './facilities-reader';

/**
 * `GET /v1/facilities/{id}/day-summary` (page headers): counts for one facility-local day
 * (SPK-SCHED-008: midnight to midnight in the facility's IANA zone, so a 23- or 25-hour day on a
 * daylight-saving change). The schedule counts come from scheduling's composed read under
 * `scheduling.read_schedule`; restriction and task counts are this module's own, under
 * `facilities.view_maintenance`. A section the viewer may not read is null, never 0.
 */
@Injectable()
export class FacilityDaySummaryService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
    private readonly reader: FacilitiesReader,
    private readonly insights: ScheduleInsightsService,
  ) {}

  async summarize(
    principal: Principal,
    facilityId: string,
    date?: string,
  ): Promise<FacilityDaySummary> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const facility = await this.reader.loadFacility(db, organizationId, facilityId);
    const target = { type: 'facility', id: facilityId, organizationId, facilityId } as const;
    const [mayReadSchedule, mayReadMaintenance] = await Promise.all([
      this.authorization.decide(principal, SchedulingActions.readSchedule, target),
      this.authorization.decide(principal, FacilitiesActions.viewMaintenance, target),
    ]);
    if (!mayReadSchedule.allowed && !mayReadMaintenance.allowed) {
      // neither section is readable: the ordinary refusal of the schedule read
      await this.authorization.require(principal, SchedulingActions.readSchedule, target);
    }
    const now = this.clock.now();
    const day = date ?? localDateOf(facility.timezone, now);
    const start = resolveLocal(day, '00:00', facility.timezone)!.instant;
    const end = resolveLocal(addDays(day, 1), '00:00', facility.timezone)!.instant;
    const window = { start: start.toISOString(), end: end.toISOString() };

    const schedule = mayReadSchedule.allowed
      ? await this.insights.windowSummary(principal, facilityId, window)
      : null;

    let restrictions: FacilityDaySummary['restrictions'] = null;
    let maintenance: FacilityDaySummary['maintenance'] = null;
    if (mayReadMaintenance.allowed) {
      const rows = await db
        .selectFrom('restrictions')
        .select([
          'status',
          sql<number>`count(*)::int`.as('n'),
          sql<number>`count(*) filter (where upper(during) <= ${now.toISOString()}::timestamptz)::int`.as(
            'ended',
          ),
        ])
        .where('organization_id', '=', organizationId)
        .where('facility_id', '=', facilityId)
        .where('status', 'in', ['proposed', 'approved', 'active'])
        .where(sql<boolean>`during && ${tstzrange(start, end)}`)
        .groupBy('status')
        .execute();
      const n = (status: string) => Number(rows.find((r) => r.status === status)?.n ?? 0);
      restrictions = {
        active: n('active'),
        approved: n('approved'),
        proposed: n('proposed'),
        unreleasedAfterEnd: Number(rows.find((r) => r.status === 'active')?.ended ?? 0),
      };
      const tasks = await db
        .selectFrom('maintenance_tasks')
        .select([
          sql<number>`count(*)::int`.as('open'),
          sql<number>`count(*) filter (where due_at < ${now.toISOString()}::timestamptz)::int`.as(
            'overdue',
          ),
        ])
        .where('organization_id', '=', organizationId)
        .where('facility_id', '=', facilityId)
        .where('status', 'in', ['open', 'assigned', 'in_progress'])
        .executeTakeFirst();
      maintenance = {
        openTasks: Number(tasks?.open ?? 0),
        overdueTasks: Number(tasks?.overdue ?? 0),
      };
    }

    return {
      facilityId,
      date: day,
      timezone: facility.timezone,
      window,
      schedule,
      restrictions,
      maintenance,
    };
  }
}
