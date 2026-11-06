import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  RESULTS_AWAITING_MAX,
  type ActorSnapshot,
  type CreateResultReminderInput,
  type Principal,
  type ResultAwaiting,
  type ResultReminder,
  type ResultsAwaiting,
} from '@sportspark/contracts';
import { json, type Db, type ResultRemindersTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  executorFor,
  snapshotActor,
  type Clock,
} from '../../../kernel';
import { FieldActions } from '../competition-field.actions';
import { FieldEvents } from '../competition-field.events';
import { latestAttendanceMarks } from '../competition-field.queries';
import {
  effectiveRoles,
  fixtureFacilityId,
  loadRuleSetRow,
  loadSeasonRow,
  teamNamesOf,
} from '../competition.queries';
import { iso, organizationOf, ruleSetContentOf } from '../competition.shared';
import { FixturesService } from './fixtures.service';

function toResultReminder(row: Selectable<ResultRemindersTable>): ResultReminder {
  return {
    id: row.id,
    fixtureId: row.fixture_id,
    requestedBy: row.requested_by as unknown as ActorSnapshot,
    message: row.message,
    requestedAt: iso(row.requested_at),
    recipientCount: row.recipient_count,
  };
}

/** Team roles a result reminder reaches (the captain, and co-captains who share the job). */
const REMINDED_ROLES = ['captain', 'co_captain'] as const;

/**
 * Results waiting for a league manager's call (SPK-RESULT-001 "official standings derive only from
 * official results", SPK-RESULT-002 forfeit distinct from completion, SPK-UX-006 the "needs your
 * call" queue). A fixture is waiting when it is still `scheduled` after its scheduled end, has
 * two sides, and has no result revision in progress or official. Each one carries the players
 * marked present per side (fixture attendance, migration 0465), the rule set's minimum to start,
 * and, when exactly one side was marked below that minimum while the other reached it, the
 * forfeit the rule set's forfeit score suggests. The suggestion decides nothing: the forfeit is
 * recorded through the ordinary result submission and publication (§4.7 invariant 8).
 *
 * A reminder to both sides' captains is an append-only fact (migration 0466) with its recipients
 * in the audit record and in `competition.result_reminder_requested`; delivery belongs to
 * communications (no channel is chosen here, DEC-012 / DEC-062).
 */
@Injectable()
export class ResultsAwaitingService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly fixtures: FixturesService,
  ) {}

  /** `GET /v1/seasons/{id}/results-awaiting`, oldest first, at most RESULTS_AWAITING_MAX. */
  async list(principal: Principal, seasonId: string): Promise<ResultsAwaiting> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const season = await loadSeasonRow(db, organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    await this.authorization.require(principal, FieldActions.readResultsAwaiting, {
      type: 'season',
      id: seasonId,
      organizationId,
    });
    const now = this.clock.now();
    const rows = await db
      .selectFrom('fixtures as f')
      .select([
        'f.id',
        'f.division_id',
        'f.home_entry_id',
        'f.away_entry_id',
        'f.scheduled_start',
        'f.scheduled_end',
      ])
      .where('f.organization_id', '=', organizationId)
      .where('f.season_id', '=', seasonId)
      .where('f.status', '=', 'scheduled')
      .where('f.away_entry_id', 'is not', null)
      .where('f.scheduled_end', '<', now)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('result_revisions as r')
              .select('r.id')
              .whereRef('r.organization_id', '=', 'f.organization_id')
              .whereRef('r.fixture_id', '=', 'f.id')
              .where('r.status', 'in', ['draft', 'submitted', 'official']),
          ),
        ),
      )
      .orderBy('f.scheduled_start')
      .orderBy('f.id')
      .limit(RESULTS_AWAITING_MAX + 1)
      .execute();
    const truncated = rows.length > RESULTS_AWAITING_MAX;
    const listed = rows.slice(0, RESULTS_AWAITING_MAX);
    const ruleSet = await loadRuleSetRow(db, organizationId, season.rule_set_id);
    const forfeit = ruleSet ? ruleSetContentOf(ruleSet).forfeit : null;
    const minimum = forfeit?.minimumPlayersToStart ?? 1;
    const ids = listed.map((r) => r.id);
    const names = await teamNamesOf(
      db,
      organizationId,
      listed.flatMap((r) => [r.home_entry_id, r.away_entry_id]),
    );
    const marks = await latestAttendanceMarks(db, organizationId, ids);
    const reminders =
      ids.length === 0
        ? []
        : await db
            .selectFrom('result_reminders')
            .select(['fixture_id'])
            .select((eb) => [
              eb.fn.countAll<string>().as('n'),
              eb.fn.max('requested_at').as('last'),
            ])
            .where('organization_id', '=', organizationId)
            .where('fixture_id', 'in', ids)
            .groupBy('fixture_id')
            .execute();
    const items: ResultAwaiting[] = listed.map((row) => {
      const sideIds = [row.home_entry_id, row.away_entry_id as string];
      const sides = sideIds.map((teamEntryId) => {
        const own = marks.filter(
          (m) =>
            m.fixture_id === row.id && m.team_entry_id === teamEntryId && m.state !== 'cleared',
        );
        return {
          teamEntryId,
          teamName: names.get(teamEntryId) ?? 'Unknown team',
          present: own.length === 0 ? null : own.filter((m) => m.state === 'present').length,
        };
      });
      const short = sides.filter((s) => s.present !== null && s.present < minimum);
      const ready = sides.filter((s) => s.present !== null && s.present >= minimum);
      let suggestedForfeit: ResultAwaiting['suggestedForfeit'] = null;
      if (forfeit && short.length === 1 && ready.length === 1) {
        const loser = short[0]!;
        const homeForfeits = loser.teamEntryId === row.home_entry_id;
        suggestedForfeit = {
          forfeitingEntryId: loser.teamEntryId,
          homeScore: homeForfeits ? forfeit.scoreAgainst : forfeit.scoreFor,
          awayScore: homeForfeits ? forfeit.scoreFor : forfeit.scoreAgainst,
          reason: `${loser.teamName} had ${loser.present} player${loser.present === 1 ? '' : 's'} marked present (minimum ${minimum}).`,
        };
      }
      const reminder = reminders.find((r) => r.fixture_id === row.id);
      return {
        fixtureId: row.id,
        scheduledStart: iso(row.scheduled_start as Date),
        scheduledEnd: iso(row.scheduled_end as Date),
        divisionId: row.division_id,
        sides,
        minimumPlayersToStart: minimum,
        suggestedForfeit,
        reminderCount: reminder ? Number(reminder.n) : 0,
        lastReminderAt: reminder?.last ? iso(reminder.last as Date) : null,
      };
    });
    return { seasonId, evaluatedAt: iso(now), items, truncated };
  }

  /** `POST /v1/fixtures/{id}/result-reminders`: remind both sides' captains. */
  async remind(
    principal: Principal,
    fixtureId: string,
    input: CreateResultReminderInput,
    correlationId: string | null,
  ): Promise<ResultReminder> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const fixture = await this.fixtures.loadFixture(trx, organizationId, fixtureId, {
        forUpdate: true,
      });
      if (!fixture) throw errors.protectedNotFound('fixture');
      const facilityId = await fixtureFacilityId(trx, organizationId, fixture);
      await this.authorization.require(principal, FieldActions.remindResult, {
        type: 'fixture',
        id: fixtureId,
        organizationId,
        facilityId,
        protected: true,
      });
      const now = this.clock.now();
      if (
        fixture.status !== 'scheduled' ||
        !fixture.scheduled_end ||
        new Date(fixture.scheduled_end).getTime() > now.getTime()
      ) {
        throw errors.invalidTransition('Fixture', fixture.status, 'remind_result');
      }
      const teamEntryIds = [fixture.home_entry_id, fixture.away_entry_id].filter(
        (id): id is string => id !== null,
      );
      const recipients = new Set<string>();
      for (const teamEntryId of teamEntryIds) {
        for (const role of await effectiveRoles(trx, organizationId, teamEntryId, now)) {
          if ((REMINDED_ROLES as readonly string[]).includes(role.role)) {
            recipients.add(role.person_id);
          }
        }
      }
      const recipientPersonIds = [...recipients].sort();
      const id = newId();
      const row = await trx
        .insertInto('result_reminders')
        .values({
          id,
          organization_id: organizationId,
          fixture_id: fixtureId,
          requested_by: json(snapshotActor(principal)),
          requested_by_person_id: principal.personId,
          message: input.message ?? null,
          requested_at: now,
          recipient_count: recipientPersonIds.length,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FieldActions.remindResult.id,
        targetType: 'result_reminder',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: { fixtureId, teamEntryIds, recipientPersonIds },
      });
      await this.outbox.enqueue(trx, FieldEvents.resultReminderRequested, {
        organizationId,
        aggregateType: 'fixture',
        aggregateId: fixtureId,
        payload: {
          reminderId: id,
          fixtureId,
          teamEntryIds,
          recipientPersonIds,
          message: input.message ?? null,
          facilityId,
        },
        correlationId,
      });
      return toResultReminder(row);
    });
  }
}
