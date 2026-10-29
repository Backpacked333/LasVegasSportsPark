import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type AvailabilitySummary,
  type CreateFixtureInput,
  type DomainEvent,
  type Event,
  type FixtureAvailabilityResponse,
  type FixtureCommandResult,
  type FixtureDetail,
  type FixtureResponse,
  type FixtureSchedule,
  type FixtureVenue,
  type ListSeasonFixturesQuery,
  type Page,
  type Principal,
  type RecordAvailabilityInput,
  type RosterPlayingStatus,
  type SeasonFixture,
  type UpdateFixtureInput,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  type Db,
  type FixtureStatus,
  type FixturesTable,
  type FixtureVenueJson,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  FacilityDirectory,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  executorFor,
  snapshotActor,
  type Clock,
  type HandlerContext,
  type Trx,
} from '../../../kernel';
import { PeopleService } from '../../identity';
import {
  EVENT_SCHEDULING_PORT,
  type EventChanged,
  type EventSchedulingPort,
} from '../../scheduling';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import {
  effectiveRoles,
  loadSeasonRow,
  rosterRowsEffectiveAt,
  statusAt,
  teamNamesOf,
  type Reader,
} from '../competition.queries';
import {
  criteriaOf,
  emptySummary,
  isStaffLike,
  organizationOf,
  toAvailabilityResponse,
  toFixture,
  toFixtureSummary,
} from '../competition.shared';
import { FixtureMachine, type FixtureEvent } from '../competition.state-machines';
import type { FixtureOutcome, FixturePort, FixtureSummary } from '../ports';
import { readTarget } from './competitions.service';

type FixtureRow = Selectable<FixturesTable>;
type EventChangedPayload = z.infer<typeof EventChanged.payload>;
type ChangeKind = z.infer<typeof CompetitionEvents.fixtureChanged.payload>['change'];

const Cursor = z.object({ start: z.string().nullable(), id: z.string() });

interface Plan {
  fixture: FixtureRow;
  operationId: string;
  step: 'create_event' | 'move_event' | 'cancel_event' | 'none';
  nextStatus: FixtureStatus;
  change: ChangeKind;
  schedule?: FixtureSchedule;
  reason: string | null;
}

/**
 * Fixtures (§4.4 Matches) and RSVPs (SPK-CAP-003). Time and space belong to the scheduling
 * module: a fixture names its scheduling event and keeps a copy of the instants as a read model.
 * Scheduling runs as a multi-step command with a durable operation: the fixture is written and
 * the operation created in one transaction, the scheduling port runs in its own transaction, and
 * a final transaction records the outcome; a port failure leaves the fixture unscheduled and the
 * operation failed with the reason (§4.9, §4.12). The scheduling.event_changed handler keeps the
 * copy in sync when the scheduler moves or cancels the event directly.
 */
@Injectable()
export class FixturesService implements FixturePort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    @Inject(EVENT_SCHEDULING_PORT) private readonly scheduling: EventSchedulingPort,
    private readonly people: PeopleService,
    private readonly facilities: FacilityDirectory,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------
  async create(
    principal: Principal,
    input: CreateFixtureInput,
    correlationId: string | null,
  ): Promise<FixtureCommandResult> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.manageFixtures, {
      type: 'fixture',
      organizationId,
    });
    const id = newId();
    // §4.7 invariant 12, §4.11: the fixture, its scheduling event and the recorded outcome commit
    // in one transaction (scheduling's commands join it; UnitOfWork.run is reentrant). A refused
    // scheduling step is recorded (operation failed) and committed before it is reported; anything
    // else rolls the whole command back, so no event exists that its fixture does not reference.
    const outcome = await this.uow.run(async () => {
      const plan = await this.uow.run(async ({ trx }): Promise<Plan> => {
        const season = await loadSeasonRow(trx, organizationId, input.seasonId);
        if (!season) throw errors.notFound('season', input.seasonId);
        if (season.status === 'completed' || season.status === 'archived') {
          throw errors.invalidTransition('Season', season.status, 'add_fixture');
        }
        const home = await this.loadEntry(trx, organizationId, input.seasonId, input.homeEntryId);
        const away = input.awayEntryId
          ? await this.loadEntry(trx, organizationId, input.seasonId, input.awayEntryId)
          : null;
        if (input.divisionId) {
          const division = await trx
            .selectFrom('divisions')
            .select('id')
            .where('organization_id', '=', organizationId)
            .where('season_id', '=', input.seasonId)
            .where('id', '=', input.divisionId)
            .executeTakeFirst();
          if (!division) throw errors.notFound('division', input.divisionId);
          for (const entry of [home, away]) {
            if (entry && entry.division_id !== null && entry.division_id !== input.divisionId) {
              throw errors.validation('Both entries must be placed in the fixture division.', {
                teamEntryId: entry.id,
                divisionId: entry.division_id,
              });
            }
          }
        }
        await trx
          .insertInto('fixtures')
          .values({
            id,
            organization_id: organizationId,
            season_id: input.seasonId,
            division_id: input.divisionId ?? null,
            round: input.round ?? null,
            home_entry_id: input.homeEntryId,
            away_entry_id: input.awayEntryId ?? null,
            scheduling_event_id: null,
            scheduled_start: null,
            scheduled_end: null,
            notes: input.notes ?? null,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
        const operationId = await this.operations.create(trx, {
          organizationId,
          kind: 'competition.create_fixture',
          requestedBy: principal,
          correlationId,
          input: { fixtureId: id, schedule: input.schedule ?? null },
          status: 'running',
        });
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: CompetitionActions.manageFixtures.id,
          targetType: 'fixture',
          targetId: id,
          afterRevision: 1,
          reason: input.reason ?? null,
          correlationId,
          operationId,
          details: {
            operation: 'create',
            seasonId: input.seasonId,
            homeEntryId: input.homeEntryId,
            awayEntryId: input.awayEntryId ?? null,
          },
        });
        await this.outbox.enqueue(trx, CompetitionEvents.fixtureCreated, {
          organizationId,
          aggregateType: 'fixture',
          aggregateId: id,
          payload: {
            fixtureId: id,
            seasonId: input.seasonId,
            divisionId: input.divisionId ?? null,
            homeEntryId: input.homeEntryId,
            awayEntryId: input.awayEntryId ?? null,
            operationId,
          },
          correlationId,
          operationId,
        });
        const fixture = await trx
          .selectFrom('fixtures')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        if (!input.schedule) {
          await this.operations.transition(trx, operationId, 'succeeded', {
            result: { fixtureId: id },
          });
          return {
            fixture,
            operationId,
            step: 'none',
            nextStatus: 'unscheduled',
            change: 'edited',
            reason: null,
          };
        }
        return {
          fixture,
          operationId,
          step: 'create_event',
          nextStatus: 'scheduled',
          change: 'scheduled',
          schedule: input.schedule,
          reason: input.reason ?? null,
        };
      });
      if (plan.step === 'none') {
        return {
          result: {
            fixture: toFixture(plan.fixture),
            operationId: plan.operationId,
            operationStatus: 'succeeded',
          } satisfies FixtureCommandResult,
        };
      }
      return this.execute(principal, plan, correlationId);
    });
    if ('failure' in outcome) throw outcome.failure;
    return outcome.result;
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateFixtureInput,
    correlationId: string | null,
  ): Promise<FixtureCommandResult> {
    const organizationId = organizationOf(principal);
    // §4.7 invariant 12: one transaction, as in create.
    const outcome = await this.uow.run(async () => {
      const plan = await this.uow.run(async ({ trx }): Promise<Plan> => {
        const fixture = await this.loadFixture(trx, organizationId, id, { forUpdate: true });
        if (!fixture) throw errors.notFound('fixture', id);
        await this.authorization.require(principal, CompetitionActions.manageFixtures, {
          type: 'fixture',
          id,
          organizationId,
        });
        assertExpectedRevision(input.expectedRevision, fixture.revision);
        const reason = input.reason ?? null;
        const operationId = await this.operations.create(trx, {
          organizationId,
          kind: `competition.${input.action}_fixture`,
          requestedBy: principal,
          correlationId,
          input: { fixtureId: id, action: input.action, schedule: input.schedule ?? null },
          status: 'running',
        });
        const hasEvent = fixture.scheduling_event_id !== null;
        switch (input.action) {
          case 'edit': {
            if (input.divisionId) {
              const division = await trx
                .selectFrom('divisions')
                .select('id')
                .where('organization_id', '=', organizationId)
                .where('season_id', '=', fixture.season_id)
                .where('id', '=', input.divisionId)
                .executeTakeFirst();
              if (!division) throw errors.notFound('division', input.divisionId);
            }
            const updated = await trx
              .updateTable('fixtures')
              .set({
                round: input.round === undefined ? fixture.round : input.round,
                division_id:
                  input.divisionId === undefined ? fixture.division_id : input.divisionId,
                notes: input.notes === undefined ? fixture.notes : input.notes,
                revision: fixture.revision + 1,
              })
              .where('organization_id', '=', organizationId)
              .where('id', '=', id)
              .where('revision', '=', fixture.revision)
              .returningAll()
              .executeTakeFirstOrThrow();
            await this.operations.transition(trx, operationId, 'succeeded', {
              result: { fixtureId: id },
            });
            await this.recordChange(
              trx,
              principal,
              fixture,
              updated,
              'edited',
              reason,
              correlationId,
              operationId,
            );
            return {
              fixture: updated,
              operationId,
              step: 'none',
              nextStatus: updated.status,
              change: 'edited',
              reason,
            };
          }
          case 'schedule': {
            const next = FixtureMachine.next(fixture.status, 'schedule');
            return {
              fixture,
              operationId,
              step: hasEvent ? 'move_event' : 'create_event',
              nextStatus: next,
              change: 'scheduled',
              schedule: input.schedule,
              reason,
            };
          }
          case 'reschedule': {
            if (fixture.status !== 'scheduled') {
              throw errors.invalidTransition('Fixture', fixture.status, 'reschedule');
            }
            return {
              fixture,
              operationId,
              step: hasEvent ? 'move_event' : 'create_event',
              nextStatus: 'scheduled',
              change: 'rescheduled',
              schedule: input.schedule,
              reason,
            };
          }
          case 'postpone': {
            const next = FixtureMachine.next(fixture.status, 'postpone');
            return {
              fixture,
              operationId,
              step: hasEvent ? 'cancel_event' : 'none',
              nextStatus: next,
              change: 'postponed',
              reason,
            };
          }
          case 'unschedule': {
            const next = FixtureMachine.next(fixture.status, 'unschedule');
            return {
              fixture,
              operationId,
              step: hasEvent ? 'cancel_event' : 'none',
              nextStatus: next,
              change: 'unscheduled',
              reason,
            };
          }
          case 'cancel': {
            const next = FixtureMachine.next(fixture.status, 'cancel');
            return {
              fixture,
              operationId,
              step: hasEvent ? 'cancel_event' : 'none',
              nextStatus: next,
              change: 'canceled',
              reason,
            };
          }
        }
      });
      if (plan.change === 'edited') {
        return {
          result: {
            fixture: toFixture(plan.fixture),
            operationId: plan.operationId,
            operationStatus: 'succeeded',
          } satisfies FixtureCommandResult,
        };
      }
      return this.execute(principal, plan, correlationId);
    });
    if ('failure' in outcome) throw outcome.failure;
    return outcome.result;
  }

  /**
   * Steps 2 and 3 of a scheduling command, inside the command's transaction: the scheduling port
   * (whose command joins it), then the recorded outcome. A refused scheduling step is returned as
   * `failure` after recording it, for the caller to commit and report.
   */
  private async execute(
    principal: Principal,
    plan: Plan,
    correlationId: string | null,
  ): Promise<{ result: FixtureCommandResult } | { failure: DomainError }> {
    const organizationId = organizationOf(principal);
    const { fixture, operationId } = plan;
    let event: Event | null = null;
    try {
      if (plan.step === 'create_event' && plan.schedule) {
        event = await this.scheduling.createEvent(principal, {
          facilityId: plan.schedule.facilityId,
          kind: 'game',
          title: await this.titleOf(organizationId, fixture),
          format: await this.formatOf(organizationId, fixture),
          scheduledStart: plan.schedule.scheduledStart,
          scheduledEnd: plan.schedule.scheduledEnd,
          setupMinutes: plan.schedule.setupMinutes,
          cleanupMinutes: plan.schedule.cleanupMinutes,
          resourceIds: plan.schedule.resourceIds,
          commitments: commitmentsOf(fixture),
          sourceType: 'fixture',
          sourceId: fixture.id,
          status: plan.schedule.publish ? 'published' : 'draft',
          reason: plan.reason ?? undefined,
          correlationId,
        });
      } else if (plan.step === 'move_event' && plan.schedule && fixture.scheduling_event_id) {
        event = await this.scheduling.moveEvent(principal, fixture.scheduling_event_id, {
          scheduledStart: plan.schedule.scheduledStart,
          scheduledEnd: plan.schedule.scheduledEnd,
          resourceIds: plan.schedule.resourceIds,
          setupMinutes: plan.schedule.setupMinutes,
          cleanupMinutes: plan.schedule.cleanupMinutes,
          reason: plan.reason ?? undefined,
          correlationId,
        });
      } else if (plan.step === 'cancel_event' && fixture.scheduling_event_id) {
        const current = await this.scheduling.getEvent(principal, fixture.scheduling_event_id);
        if (current.status !== 'canceled') {
          await this.scheduling.cancelEvent(principal, fixture.scheduling_event_id, {
            reason: plan.reason ?? `fixture ${plan.change}`,
            correlationId,
          });
        }
      }
    } catch (error) {
      // Anything but a refusal rolls the whole command back (nothing half-applied).
      if (!DomainError.is(error)) throw error;
      await this.uow.run(async ({ trx }) => {
        await this.operations.transition(trx, operationId, 'failed', {
          error: { code: error.code, message: error.message, details: error.details },
        });
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: CompetitionActions.manageFixtures.id,
          targetType: 'fixture',
          targetId: fixture.id,
          correlationId,
          operationId,
          details: { step: plan.step, outcome: 'failed', code: error.code },
        });
      });
      // §4.9, §4.12: the fixture and its failed operation are committed, so the refusal names
      // them; otherwise a caller told only "conflict" could not find the unscheduled fixture and
      // would create a second one instead of scheduling this one elsewhere.
      const base =
        error.details !== null && typeof error.details === 'object' && !Array.isArray(error.details)
          ? (error.details as Record<string, unknown>)
          : error.details === undefined
            ? {}
            : { reason: error.details };
      return {
        failure: new DomainError(error.code, error.message, {
          nextAction: error.nextAction,
          details: {
            ...base,
            fixtureId: fixture.id,
            operationId,
            fixtureStatus: fixture.status,
          },
          cause: error,
        }),
      };
    }
    const scheduledNow = event !== null && event.status === 'published';
    const result = await this.uow.run(async ({ trx }): Promise<FixtureCommandResult> => {
      const before = await this.loadFixture(trx, organizationId, fixture.id, { forUpdate: true });
      if (!before) throw errors.notFound('fixture', fixture.id);
      const nextStatus: FixtureStatus =
        plan.step === 'create_event' || plan.step === 'move_event'
          ? scheduledNow
            ? plan.nextStatus
            : before.status === 'scheduled'
              ? 'scheduled'
              : before.status
          : plan.nextStatus;
      const updated = await trx
        .updateTable('fixtures')
        .set({
          status: nextStatus,
          scheduling_event_id: event
            ? event.id
            : plan.step === 'cancel_event'
              ? null
              : before.scheduling_event_id,
          scheduled_start:
            event && scheduledNow
              ? event.scheduledStart
              : plan.step === 'cancel_event'
                ? null
                : before.scheduled_start,
          scheduled_end:
            event && scheduledNow
              ? event.scheduledEnd
              : plan.step === 'cancel_event'
                ? null
                : before.scheduled_end,
          revision: before.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', fixture.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: {
          fixtureId: fixture.id,
          schedulingEventId: updated.scheduling_event_id,
          status: updated.status,
        },
      });
      await this.recordChange(
        trx,
        principal,
        before,
        updated,
        plan.change,
        plan.reason,
        correlationId,
        operationId,
      );
      return { fixture: toFixture(updated), operationId, operationStatus: 'succeeded' };
    });
    return { result };
  }

  /** RSVP by the player, a guardian with register, or staff (SPK-CAP-003, §4.8). Not attendance, not eligibility. */
  async recordAvailability(
    principal: Principal,
    fixtureId: string,
    input: RecordAvailabilityInput,
    correlationId: string | null,
  ): Promise<FixtureAvailabilityResponse> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const fixture = await this.loadFixture(trx, organizationId, fixtureId);
      if (!fixture) throw errors.protectedNotFound('fixture');
      const personId = input.personId ?? principal.personId;
      if (!personId) throw errors.accessDenied('Link your account to a person before responding.');
      await this.authorization.require(principal, CompetitionActions.respondAvailability, {
        type: 'fixture',
        id: fixtureId,
        organizationId,
        subjectPersonIds: [personId],
        protected: true,
      });
      if (
        fixture.status !== 'unscheduled' &&
        fixture.status !== 'scheduled' &&
        fixture.status !== 'postponed'
      ) {
        throw errors.invalidTransition('Fixture', fixture.status, 'respond_availability');
      }
      // CMP-04 (SPK-CAP-003): answers close at kickoff until a rule set defines a cutoff (DEC-002).
      if (fixture.scheduled_start && now.getTime() >= new Date(fixture.scheduled_start).getTime()) {
        throw availabilityClosed(fixture);
      }
      const at = fixture.scheduled_start ? new Date(fixture.scheduled_start) : now;
      const teamEntryId = await this.sideOf(trx, organizationId, fixture, personId, at);
      if (!teamEntryId) {
        throw errors.validation('The person is not on a roster of this fixture.', { personId });
      }
      const respondedAt = input.state === 'no_response' ? null : now;
      const values = {
        team_entry_id: teamEntryId,
        state: input.state,
        responded_at: respondedAt,
        responded_by: json(snapshotActor(principal)),
        note: input.note ?? null,
      };
      // CMP-04 (§4.9): the answer is changed only from the revision the caller saw.
      const existing = await trx
        .selectFrom('availability_responses')
        .select(['id', 'revision'])
        .where('organization_id', '=', organizationId)
        .where('fixture_id', '=', fixtureId)
        .where('person_id', '=', personId)
        .forUpdate()
        .executeTakeFirst();
      let row;
      if (existing) {
        assertExpectedRevision(input.expectedRevision, existing.revision);
        row = await trx
          .updateTable('availability_responses')
          .set({ ...values, revision: existing.revision + 1 })
          .where('organization_id', '=', organizationId)
          .where('id', '=', existing.id)
          .where('revision', '=', existing.revision)
          .returningAll()
          .executeTakeFirst();
        if (!row) throw errors.staleRevision(input.expectedRevision ?? existing.revision, 0);
      } else {
        // No answer yet: a caller that names a revision saw one that no longer exists.
        if (input.expectedRevision !== undefined) {
          throw errors.staleRevision(input.expectedRevision, 0);
        }
        try {
          row = await trx
            .insertInto('availability_responses')
            .values({
              id: newId(),
              organization_id: organizationId,
              fixture_id: fixtureId,
              person_id: personId,
              ...values,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        } catch (error) {
          // A concurrent first answer for the person committed meanwhile: read it and retry.
          if (isUniqueViolation(error)) throw errors.staleRevision(0, 1);
          throw error;
        }
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.respondAvailability.id,
        targetType: 'availability_response',
        targetId: row.id,
        afterRevision: row.revision,
        correlationId,
        details: { fixtureId, teamEntryId, personId, state: input.state },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.availabilityResponded, {
        organizationId,
        aggregateType: 'fixture',
        aggregateId: fixtureId,
        payload: { fixtureId, teamEntryId, personId, state: input.state },
        correlationId,
      });
      return toAvailabilityResponse(row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------
  async get(principal: Principal, id: string): Promise<FixtureDetail> {
    const organizationId = organizationOf(principal);
    const fixture = await this.loadFixture(executorFor(this.db), organizationId, id);
    if (!fixture) throw errors.protectedNotFound('fixture');
    const now = this.clock.now();
    const at = fixture.scheduled_start ? new Date(fixture.scheduled_start) : now;
    await this.authorizeRead(principal, fixture, at);
    return this.detail(executorFor(this.db), principal, fixture);
  }

  /** CMP-01: the season's fixtures with both teams' names (one join per page). */
  async listForSeason(
    principal: Principal,
    seasonId: string,
    query: ListSeasonFixturesQuery,
  ): Promise<Page<SeasonFixture>> {
    const organizationId = organizationOf(principal);
    const season = await loadSeasonRow(executorFor(this.db), organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'season', seasonId, organizationId),
    );
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = executorFor(this.db)
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .orderBy(sql`scheduled_start asc nulls last`)
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.divisionId) q = q.where('division_id', '=', query.divisionId);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.teamEntryId) {
      const teamEntryId = query.teamEntryId;
      q = q.where((eb) =>
        eb.or([eb('home_entry_id', '=', teamEntryId), eb('away_entry_id', '=', teamEntryId)]),
      );
    }
    if (query.from) q = q.where('scheduled_end', '>', new Date(query.from));
    if (query.to) q = q.where('scheduled_start', '<', new Date(query.to));
    if (cursor) {
      q = cursor.start
        ? q.where(
            sql<boolean>`(scheduled_start > ${new Date(cursor.start)}::timestamptz or (scheduled_start = ${new Date(cursor.start)}::timestamptz and id > ${cursor.id}::uuid) or scheduled_start is null)`,
          )
        : q.where(sql<boolean>`(scheduled_start is null and id > ${cursor.id}::uuid)`);
    }
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const names = await teamNamesOf(
      executorFor(this.db),
      organizationId,
      page.flatMap((r) => [r.home_entry_id, r.away_entry_id]),
    );
    const items = page.map((row): SeasonFixture => ({
      ...toFixture(row),
      homeTeamName: names.get(row.home_entry_id) ?? 'Unknown team',
      awayTeamName: row.away_entry_id ? (names.get(row.away_entry_id) ?? 'Unknown team') : null,
    }));
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last
        ? encodeCursor({
            start: last.scheduled_start ? new Date(last.scheduled_start).toISOString() : null,
            id: last.id,
          })
        : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // scheduling.event_changed handler: keep the copied instants and status in sync (idempotent).
  // -------------------------------------------------------------------------------------------
  async onSchedulingEventChanged(
    event: DomainEvent<EventChangedPayload>,
    ctx: HandlerContext,
  ): Promise<void> {
    await this.syncSchedule(event, ctx);
    await this.projectVenue(event, ctx);
  }

  /**
   * CMP-04 (SPK-SCHED-008, §4.12): the venue read model follows the fixture's CURRENT event. A
   * change of that event replaces it only when its revision is newer than the one the copy came
   * from, so a late or replayed delivery never overwrites a newer venue; a fixture whose event was
   * unlinked (canceled, moved to another event) drops the old event's venue. The copy is not an
   * edit of the fixture, so the fixture's revision is not bumped.
   */
  private async projectVenue(
    event: DomainEvent<EventChangedPayload>,
    ctx: HandlerContext,
  ): Promise<void> {
    const payload = event.payload;
    if (payload.sourceType !== 'fixture' || !payload.sourceId) return;
    const fixture = await this.loadFixture(ctx.trx, event.organizationId, payload.sourceId, {
      forUpdate: true,
    });
    if (!fixture) return;
    const venue = fixture.venue as FixtureVenueJson | null;
    if (fixture.scheduling_event_id !== payload.eventId) {
      if (venue && venue.eventId === payload.eventId && fixture.scheduling_event_id === null) {
        await ctx.trx
          .updateTable('fixtures')
          .set({ venue: null, venue_facility_id: null, venue_event_revision: null })
          .where('organization_id', '=', fixture.organization_id)
          .where('id', '=', fixture.id)
          .execute();
      }
      return;
    }
    const after = payload.after;
    const revision = payload.revision;
    if (!after || revision === undefined) return;
    if (
      venue &&
      venue.eventId === payload.eventId &&
      fixture.venue_event_revision !== null &&
      fixture.venue_event_revision >= revision
    ) {
      return;
    }
    const next: FixtureVenueJson = {
      eventId: payload.eventId,
      facilityId: after.facilityId,
      timezone: after.timezone,
      resources: after.resources.map((r) => ({ id: r.id, name: r.name })),
    };
    await ctx.trx
      .updateTable('fixtures')
      .set({
        venue: json(next),
        venue_facility_id: after.facilityId,
        venue_event_revision: revision,
      })
      .where('organization_id', '=', fixture.organization_id)
      .where('id', '=', fixture.id)
      .execute();
  }

  private async syncSchedule(
    event: DomainEvent<EventChangedPayload>,
    ctx: HandlerContext,
  ): Promise<void> {
    const payload = event.payload;
    if (payload.sourceType !== 'fixture' || !payload.sourceId) return;
    const organizationId = event.organizationId;
    const fixture = await this.loadFixture(ctx.trx, organizationId, payload.sourceId, {
      forUpdate: true,
    });
    if (!fixture) return;
    const system: Principal = {
      kind: 'system',
      organizationId,
      accountId: null,
      personId: null,
      staffRoles: [],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'competition.sync_fixture_schedule',
    };
    // §4.12, §4.6: deliveries can arrive late and out of order (a retried event is overtaken by
    // later ones), and the payload carries no ordering token. So the fixture follows the event's
    // CURRENT state, read inside this handler's transaction (the read joins it), never the
    // payload's `change`/`after`: every delivery, in any order, converges on the latest committed
    // state, and a late `moved` can never relink a canceled event or undo a postponement.
    let current: Event | null;
    try {
      current = await this.scheduling.getEvent(system, payload.eventId);
    } catch (error) {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') return;
      throw error;
    }
    if (current.sourceType !== 'fixture' || current.sourceId !== fixture.id) return;
    // the fixture moved on to another event (rescheduled through a new one): this one is stale
    if (fixture.scheduling_event_id !== null && fixture.scheduling_event_id !== current.id) return;
    if (current.status === 'canceled') {
      // EventMachine: canceled is terminal, so a canceled event is never linked again.
      if (fixture.status !== 'scheduled' || fixture.scheduling_event_id !== current.id) return;
      const updated = await ctx.trx
        .updateTable('fixtures')
        .set({
          status: 'postponed',
          scheduling_event_id: null,
          scheduled_start: null,
          scheduled_end: null,
          revision: fixture.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', fixture.id)
        .where('revision', '=', fixture.revision)
        .returningAll()
        .executeTakeFirst();
      if (updated)
        await this.recordChange(
          ctx.trx,
          system,
          fixture,
          updated,
          'synced_from_scheduling',
          payload.reason,
          event.correlationId,
          event.operationId,
        );
      return;
    }
    if (current.status !== 'published') return;
    if (
      fixture.status !== 'unscheduled' &&
      fixture.status !== 'postponed' &&
      fixture.status !== 'scheduled'
    )
      return;
    const scheduledStart = new Date(current.scheduledStart).toISOString();
    const scheduledEnd = new Date(current.scheduledEnd).toISOString();
    const unchanged =
      fixture.status === 'scheduled' &&
      fixture.scheduling_event_id === current.id &&
      fixture.scheduled_start !== null &&
      new Date(fixture.scheduled_start).toISOString() === scheduledStart &&
      fixture.scheduled_end !== null &&
      new Date(fixture.scheduled_end).toISOString() === scheduledEnd;
    if (unchanged) return;
    const updated = await ctx.trx
      .updateTable('fixtures')
      .set({
        status: 'scheduled',
        scheduling_event_id: current.id,
        scheduled_start: scheduledStart,
        scheduled_end: scheduledEnd,
        revision: fixture.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', fixture.id)
      .where('revision', '=', fixture.revision)
      .returningAll()
      .executeTakeFirst();
    if (updated)
      await this.recordChange(
        ctx.trx,
        system,
        fixture,
        updated,
        'synced_from_scheduling',
        payload.reason,
        event.correlationId,
        event.operationId,
      );
  }

  // -------------------------------------------------------------------------------------------
  // FixturePort
  // -------------------------------------------------------------------------------------------
  async findFixture(
    organizationId: string,
    fixtureId: string,
    trx?: Trx,
  ): Promise<FixtureSummary | null> {
    const row = await this.loadFixture(trx ?? executorFor(this.db), organizationId, fixtureId);
    return row ? toFixtureSummary(row) : null;
  }

  async listSeasonFixtures(
    organizationId: string,
    seasonId: string,
    trx?: Trx,
  ): Promise<FixtureSummary[]> {
    const rows = await (trx ?? executorFor(this.db))
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .orderBy(sql`scheduled_start asc nulls last`)
      .orderBy('id')
      .execute();
    return rows.map(toFixtureSummary);
  }

  async fixturesOfEntry(
    organizationId: string,
    teamEntryId: string,
    window: { from?: Date; to?: Date } = {},
    trx?: Trx,
  ): Promise<FixtureSummary[]> {
    let q = (trx ?? executorFor(this.db))
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where((eb) =>
        eb.or([eb('home_entry_id', '=', teamEntryId), eb('away_entry_id', '=', teamEntryId)]),
      )
      .orderBy(sql`scheduled_start asc nulls last`)
      .orderBy('id');
    if (window.from) q = q.where('scheduled_end', '>', window.from);
    if (window.to) q = q.where('scheduled_start', '<', window.to);
    return (await q.execute()).map(toFixtureSummary);
  }

  async recordOutcome(
    trx: Trx,
    principal: Principal,
    fixtureId: string,
    outcome: FixtureOutcome,
    reason: string,
    correlationId: string | null,
  ): Promise<FixtureSummary> {
    const organizationId = organizationOf(principal);
    const fixture = await this.loadFixture(trx, organizationId, fixtureId, { forUpdate: true });
    if (!fixture) throw errors.notFound('fixture', fixtureId);
    const event: FixtureEvent =
      outcome === 'played' ? 'record_played' : outcome === 'forfeit' ? 'forfeit' : 'abandon';
    const next = FixtureMachine.next(fixture.status, event);
    const updated = await trx
      .updateTable('fixtures')
      .set({ status: next, revision: fixture.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', fixtureId)
      .where('revision', '=', fixture.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.recordChange(
      trx,
      principal,
      fixture,
      updated,
      'outcome_recorded',
      reason,
      correlationId,
      null,
    );
    return toFixtureSummary(updated);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  async loadFixture(
    db: Reader,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<FixtureRow | null> {
    let q = db
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (options.forUpdate) q = q.forUpdate();
    return (await q.executeTakeFirst()) ?? null;
  }

  private async loadEntry(
    db: Reader,
    organizationId: string,
    seasonId: string,
    teamEntryId: string,
  ) {
    const entry = await db
      .selectFrom('team_entries')
      .select(['id', 'status', 'division_id', 'team_id'])
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .where('id', '=', teamEntryId)
      .executeTakeFirst();
    if (!entry) throw errors.notFound('team_entry', teamEntryId);
    if (entry.status !== 'applied' && entry.status !== 'approved') {
      throw errors.invalidTransition('TeamEntry', entry.status, 'play_fixture');
    }
    return entry;
  }

  private async titleOf(organizationId: string, fixture: FixtureRow): Promise<string> {
    const names = await executorFor(this.db)
      .selectFrom('team_entries')
      .innerJoin('teams', (join) =>
        join
          .onRef('teams.organization_id', '=', 'team_entries.organization_id')
          .onRef('teams.id', '=', 'team_entries.team_id'),
      )
      .select(['team_entries.id', 'teams.name'])
      .where('team_entries.organization_id', '=', organizationId)
      .where('team_entries.id', 'in', [
        fixture.home_entry_id,
        fixture.away_entry_id ?? fixture.home_entry_id,
      ])
      .execute();
    const home = names.find((n) => n.id === fixture.home_entry_id)?.name ?? 'Home';
    const away = fixture.away_entry_id
      ? (names.find((n) => n.id === fixture.away_entry_id)?.name ?? 'Away')
      : 'bye';
    return `${home} v ${away}`;
  }

  private async formatOf(organizationId: string, fixture: FixtureRow): Promise<string | null> {
    if (!fixture.division_id) return null;
    const division = await executorFor(this.db)
      .selectFrom('divisions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', fixture.division_id)
      .executeTakeFirst();
    return division ? criteriaOf(division).format : null;
  }

  private async recordChange(
    trx: Trx,
    principal: Principal,
    before: FixtureRow,
    after: FixtureRow,
    change: ChangeKind,
    reason: string | null,
    correlationId: string | null,
    operationId: string | null,
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId: after.organization_id,
      actor: principal,
      action: CompetitionActions.manageFixtures.id,
      targetType: 'fixture',
      targetId: after.id,
      beforeRevision: before.revision,
      afterRevision: after.revision,
      reason,
      correlationId,
      operationId,
      details: {
        change,
        status: after.status,
        previousStatus: before.status,
        schedulingEventId: after.scheduling_event_id,
      },
    });
    await this.outbox.enqueue(trx, CompetitionEvents.fixtureChanged, {
      organizationId: after.organization_id,
      aggregateType: 'fixture',
      aggregateId: after.id,
      payload: {
        fixtureId: after.id,
        seasonId: after.season_id,
        homeEntryId: after.home_entry_id,
        awayEntryId: after.away_entry_id,
        status: after.status,
        previousStatus: before.status,
        schedulingEventId: after.scheduling_event_id,
        scheduledStart: after.scheduled_start
          ? new Date(after.scheduled_start).toISOString()
          : null,
        scheduledEnd: after.scheduled_end ? new Date(after.scheduled_end).toISOString() : null,
        change,
        reason,
      },
      correlationId,
      operationId,
    });
  }

  /** The side (entry id) a person is effectively on for the fixture, if any. */
  private async sideOf(
    db: Reader,
    organizationId: string,
    fixture: FixtureRow,
    personId: string,
    at: Date,
  ): Promise<string | null> {
    for (const entryId of [fixture.home_entry_id, fixture.away_entry_id]) {
      if (!entryId) continue;
      const rows = await rosterRowsEffectiveAt(db, organizationId, entryId, at);
      if (rows.some((r) => r.person_id === personId && statusAt(r) !== null)) return entryId;
    }
    return null;
  }

  /** Staff in scope, a roster player or role holder (self), or a guardian with view over a child on a roster. */
  private async authorizeRead(principal: Principal, fixture: FixtureRow, at: Date): Promise<void> {
    const organizationId = fixture.organization_id;
    const base = { type: 'fixture', id: fixture.id, organizationId, protected: true };
    if (isStaffLike(principal)) {
      await this.authorization.require(principal, CompetitionActions.readFixture, base);
      return;
    }
    if (!principal.personId) throw errors.protectedNotFound('fixture');
    const persons = new Set<string>();
    for (const entryId of [fixture.home_entry_id, fixture.away_entry_id]) {
      if (!entryId) continue;
      for (const r of await rosterRowsEffectiveAt(
        executorFor(this.db),
        organizationId,
        entryId,
        at,
      )) {
        if (statusAt(r) !== null) persons.add(r.person_id);
      }
      for (const r of await effectiveRoles(
        executorFor(this.db),
        organizationId,
        entryId,
        this.clock.now(),
      ))
        persons.add(r.person_id);
    }
    if (persons.has(principal.personId)) {
      const self = await this.authorization.decide(principal, CompetitionActions.readFixture, {
        ...base,
        subjectPersonIds: [principal.personId],
      });
      if (self.allowed) return;
    }
    for (const subject of persons) {
      if (subject === principal.personId) continue;
      const person = await this.people.loadPerson(executorFor(this.db), organizationId, subject);
      if (!person || person.kind !== 'child') continue;
      const guardian = await this.authorization.decide(principal, CompetitionActions.readFixture, {
        ...base,
        subjectPersonIds: [subject],
      });
      if (guardian.allowed) return;
    }
    throw errors.protectedNotFound('fixture');
  }

  /**
   * The fixture as its authorized reader sees it (the caller has authorized the read): both sides
   * with availability summaries, the venue (CMP-04), the viewer's roster status at kickoff and the
   * answers of the viewer and of every rostered person they hold `register` over.
   */
  async detail(db: Reader, principal: Principal, fixture: FixtureRow): Promise<FixtureDetail> {
    const organizationId = fixture.organization_id;
    const personId = principal.personId;
    const at = fixture.scheduled_start ? new Date(fixture.scheduled_start) : this.clock.now();
    const rostered = new Map<string, RosterPlayingStatus>();
    const side = async (entryId: string) => {
      const entry = await db
        .selectFrom('team_entries')
        .innerJoin('teams', (join) =>
          join
            .onRef('teams.organization_id', '=', 'team_entries.organization_id')
            .onRef('teams.id', '=', 'team_entries.team_id'),
        )
        .select(['team_entries.id', 'team_entries.team_id', 'teams.name'])
        .where('team_entries.organization_id', '=', organizationId)
        .where('team_entries.id', '=', entryId)
        .executeTakeFirstOrThrow();
      const roster = (await rosterRowsEffectiveAt(db, organizationId, entryId, at)).filter(
        (r) => statusAt(r) !== null,
      );
      for (const row of roster) {
        const status = statusAt(row);
        if (status && !rostered.has(row.person_id)) rostered.set(row.person_id, status);
      }
      const { summary, mine } = await this.summaryOf(
        db,
        organizationId,
        fixture.id,
        entryId,
        roster.length,
        personId,
      );
      return {
        side: { entryId, teamId: entry.team_id, teamName: entry.name, availability: summary },
        mine,
      };
    };
    const home = await side(fixture.home_entry_id);
    const away = fixture.away_entry_id ? await side(fixture.away_entry_id) : null;
    return {
      ...toFixture(fixture),
      home: home.side,
      away: away?.side ?? null,
      myResponse: home.mine ?? away?.mine ?? null,
      venue: await this.venueOf(db, fixture),
      rosterStatus: personId ? (rostered.get(personId) ?? null) : null,
      responses: await this.responsesFor(db, principal, fixture, rostered),
    };
  }

  /** CMP-04: the copied venue with the facility's current name (FacilityDirectory, IF-03). */
  async venueOf(
    db: Reader,
    fixture: Pick<FixtureRow, 'organization_id' | 'venue' | 'venue_facility_id'>,
  ): Promise<FixtureVenue | null> {
    const venue = fixture.venue as FixtureVenueJson | null;
    if (!venue || !fixture.venue_facility_id) return null;
    const facility = (
      await this.facilities.describe(fixture.organization_id, [fixture.venue_facility_id], db)
    ).get(fixture.venue_facility_id);
    if (!facility) return null;
    return {
      facilityId: facility.id,
      facilityName: facility.name,
      timezone: venue.timezone,
      resources: venue.resources.map((r) => ({ id: r.id, name: r.name })),
    };
  }

  /**
   * CMP-04 (SPK-CAP-003): the answers the viewer may see and change: their own and those of every
   * rostered person they hold `register` over (customerSubjects of the RSVP action, IF-02). A
   * person without an answer reads `no_response` with a null revision.
   */
  private async responsesFor(
    db: Reader,
    principal: Principal,
    fixture: FixtureRow,
    rostered: ReadonlyMap<string, RosterPlayingStatus>,
  ): Promise<FixtureResponse[]> {
    if (!principal.personId || rostered.size === 0) return [];
    const subjects = (
      await this.authorization.customerSubjects(principal, CompetitionActions.respondAvailability)
    ).filter((id) => rostered.has(id));
    if (subjects.length === 0) return [];
    const rows = await db
      .selectFrom('availability_responses')
      .select(['person_id', 'state', 'revision', 'responded_at'])
      .where('organization_id', '=', fixture.organization_id)
      .where('fixture_id', '=', fixture.id)
      .where('person_id', 'in', subjects)
      .execute();
    const byPerson = new Map(rows.map((r) => [r.person_id, r]));
    return subjects.map((personId) => {
      const row = byPerson.get(personId);
      return row
        ? {
            personId,
            state: row.state,
            revision: row.revision,
            respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
          }
        : { personId, state: 'no_response' as const, revision: null, respondedAt: null };
    });
  }

  private async summaryOf(
    db: Reader,
    organizationId: string,
    fixtureId: string,
    teamEntryId: string,
    rosterSize: number,
    personId: string | null,
  ): Promise<{ summary: AvailabilitySummary; mine: FixtureDetail['myResponse'] }> {
    const responses = await db
      .selectFrom('availability_responses')
      .select(['person_id', 'state'])
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .where('team_entry_id', '=', teamEntryId)
      .execute();
    const summary = emptySummary();
    let mine: FixtureDetail['myResponse'] = null;
    for (const r of responses) {
      if (r.state === 'available') summary.available += 1;
      else if (r.state === 'unavailable') summary.unavailable += 1;
      else if (r.state === 'tentative') summary.tentative += 1;
      if (personId && r.person_id === personId) mine = r.state;
    }
    summary.noResponse = Math.max(
      0,
      rosterSize - (summary.available + summary.unavailable + summary.tentative),
    );
    return { summary, mine };
  }
}

function commitmentsOf(fixture: FixtureRow) {
  const commitments = [
    { partyType: 'team' as const, partyId: fixture.home_entry_id, role: 'home_team' },
  ];
  if (fixture.away_entry_id) {
    commitments.push({
      partyType: 'team' as const,
      partyId: fixture.away_entry_id,
      role: 'away_team',
    });
  }
  return commitments;
}

/** CMP-04 / CMP-14: availability answers and requests close at kickoff (INVALID_TRANSITION). */
export function availabilityClosed(fixture: { id: string; scheduled_start: Date | string | null }) {
  return new DomainError('INVALID_TRANSITION', 'Availability for this fixture closed at kickoff.', {
    details: {
      code: 'AVAILABILITY_CLOSED',
      fixtureId: fixture.id,
      scheduledStart: fixture.scheduled_start
        ? new Date(fixture.scheduled_start).toISOString()
        : null,
    },
  });
}
