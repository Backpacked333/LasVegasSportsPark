import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  errors,
  newId,
  z,
  type CreateDisputeInput,
  type DecideDisputeInput,
  type Dispute,
  type ListDisputesQuery,
  type Page,
  type Principal,
  type WithdrawDisputeInput,
} from '@sportspark/contracts';
import { json, type Db, type DisputesTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
} from '../../../kernel';
import { MatchActions } from '../competition-matches.actions';
import { MatchEvents } from '../competition-matches.events';
import { DISPUTE_CAPTAIN_ROLE } from '../competition-matches.policy';
import { toDispute } from '../competition-matches.shared';
import { DisputeMachine } from '../competition-matches.state-machines';
import { loadRuleSetRow, loadSeasonRow, type Reader } from '../competition.queries';
import { hoursFromNow, isStaffLike, organizationOf, ruleSetContentOf } from '../competition.shared';
import { DisciplineService, nextCursorOf } from './discipline.service';

const DisputeCursor = z.object({ at: z.string(), id: z.uuid() });

type DisputeRow = Selectable<DisputesTable>;

/**
 * Disputes (SPK-RESULT-005): eligible submitting role (a captain of a competing entry, or league
 * administration), the fixture, a submission window derived from the rule set's protest deadline
 * (counted from the official publication, else the scheduled end), reason, evidence references,
 * reviewer, decision, publication consequence and appeal handling. A dispute never changes the
 * official result itself: a consequence of `correction_required` is carried out by a correction
 * revision that cites the dispute (SPK-RESULT-004).
 */
@Injectable()
export class DisputesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly discipline: DisciplineService,
  ) {}

  async create(
    principal: Principal,
    fixtureId: string,
    input: CreateDisputeInput,
    correlationId: string | null,
  ): Promise<Dispute> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const fixture = await trx
        .selectFrom('fixtures')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', fixtureId)
        .executeTakeFirst();
      if (!fixture) throw errors.protectedNotFound('fixture');
      const season = await loadSeasonRow(trx, organizationId, fixture.season_id);
      if (!season) throw errors.notFound('season', fixture.season_id);
      const ruleSet = await loadRuleSetRow(trx, organizationId, season.rule_set_id);
      if (!ruleSet) throw errors.notFound('rule_set', season.rule_set_id);
      const rules = ruleSetContentOf(ruleSet);

      // Eligible submitting role
      let submittingRole: string;
      const teamEntryId: string | null = input.teamEntryId ?? null;
      if (isStaffLike(principal)) {
        await this.authorization.require(principal, MatchActions.submitDispute, {
          type: 'fixture',
          id: fixtureId,
          organizationId,
        });
        submittingRole =
          principal.kind === 'system' ? 'system' : (principal.staffRoles[0] ?? 'staff');
      } else {
        if (!teamEntryId) {
          throw errors.validation('A captain names the entry the dispute is submitted for.');
        }
        if (teamEntryId !== fixture.home_entry_id && teamEntryId !== fixture.away_entry_id) {
          throw errors.protectedNotFound('fixture');
        }
        await this.authorization.require(principal, MatchActions.submitDispute, {
          type: 'fixture',
          id: fixtureId,
          organizationId,
          teamEntryId,
          protected: true,
        });
        submittingRole = DISPUTE_CAPTAIN_ROLE;
      }
      if (
        teamEntryId &&
        teamEntryId !== fixture.home_entry_id &&
        teamEntryId !== fixture.away_entry_id
      ) {
        throw errors.validation('The entry does not play this fixture.', { teamEntryId });
      }

      // The disputed revision defaults to the official one.
      let revision = input.resultRevisionId
        ? await trx
            .selectFrom('result_revisions')
            .selectAll()
            .where('organization_id', '=', organizationId)
            .where('id', '=', input.resultRevisionId)
            .where('fixture_id', '=', fixtureId)
            .executeTakeFirst()
        : undefined;
      if (input.resultRevisionId && !revision) {
        throw errors.notFound('result_revision', input.resultRevisionId);
      }
      revision ??= await trx
        .selectFrom('result_revisions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('fixture_id', '=', fixtureId)
        .where('status', '=', 'official')
        .executeTakeFirst();

      // Submission window from the rule set's protest deadline (SPK-COMP-002 "protest deadlines").
      const base = revision?.published_at
        ? new Date(revision.published_at)
        : fixture.scheduled_end
          ? new Date(fixture.scheduled_end)
          : now;
      const deadline = hoursFromNow(base, rules.protestDeadlineHours);
      if (now > deadline) {
        throw errors.validation(`The protest window closed at ${deadline.toISOString()}.`, {
          code: 'protest_window_closed',
          submissionDeadlineAt: deadline.toISOString(),
          protestDeadlineHours: rules.protestDeadlineHours,
        });
      }
      const id = newId();
      const row = await trx
        .insertInto('disputes')
        .values({
          id,
          organization_id: organizationId,
          fixture_id: fixtureId,
          result_revision_id: revision?.id ?? null,
          submitting_team_entry_id: teamEntryId,
          submitting_role: submittingRole,
          submitted_by: json(snapshotActor(principal)),
          submitted_by_person_id: principal.personId,
          submitted_at: now,
          submission_deadline_at: deadline,
          reason: input.reason,
          evidence_refs: json(input.evidence),
          reviewer: null,
          reviewer_person_id: null,
          decision: null,
          decided_at: null,
          decision_reason: null,
          publication_consequence: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.submitDispute.id,
        targetType: 'dispute',
        targetId: id,
        afterRevision: 1,
        reason: input.reason,
        correlationId,
        details: {
          fixtureId,
          resultRevisionId: revision?.id ?? null,
          submittingRole,
          submittingTeamEntryId: teamEntryId,
          submissionDeadlineAt: deadline.toISOString(),
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.disputeSubmitted, {
        organizationId,
        aggregateType: 'dispute',
        aggregateId: id,
        payload: {
          disputeId: id,
          fixtureId,
          resultRevisionId: revision?.id ?? null,
          submittingTeamEntryId: teamEntryId,
        },
        correlationId,
      });
      return toDispute(row, 'none');
    });
  }

  async decide(
    principal: Principal,
    disputeId: string,
    input: DecideDisputeInput,
    correlationId: string | null,
  ): Promise<Dispute> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, disputeId, { forUpdate: true });
      if (!row) throw errors.notFound('dispute', disputeId);
      await this.authorization.require(principal, MatchActions.reviewDispute, {
        type: 'dispute',
        id: disputeId,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const next = DisputeMachine.next(row.status, input.action);
      const now = this.clock.now();
      const updated = await trx
        .updateTable('disputes')
        .set({
          status: next,
          reviewer: json(snapshotActor(principal)),
          reviewer_person_id: principal.personId,
          decision: next === 'decided' ? (input.decision ?? null) : null,
          decided_at: next === 'decided' ? now : null,
          decision_reason: next === 'decided' ? (input.reason ?? null) : null,
          publication_consequence:
            next === 'decided' ? (input.publicationConsequence ?? null) : null,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', disputeId)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.reviewDispute.id,
        targetType: 'dispute',
        targetId: disputeId,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: input.action,
          status: next,
          decision: updated.decision,
          publicationConsequence: updated.publication_consequence,
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.disputeChanged, {
        organizationId,
        aggregateType: 'dispute',
        aggregateId: disputeId,
        payload: {
          disputeId,
          fixtureId: row.fixture_id,
          status: next,
          decision: updated.decision,
          publicationConsequence: updated.publication_consequence,
        },
        correlationId,
      });
      return toDispute(updated, await this.appealStatus(trx, organizationId, disputeId));
    });
  }

  /**
   * `POST /v1/disputes/{id}/withdraw` (CMP-12, SPK-RESULT-005): the person who submitted the
   * dispute, or a captain of the submitting entry, withdraws it while it is submitted or under
   * review (DisputeMachine 'withdraw'). Anyone else gets protected NOT_FOUND (§4.10).
   */
  async withdraw(
    principal: Principal,
    disputeId: string,
    input: WithdrawDisputeInput,
    correlationId: string | null,
  ): Promise<Dispute> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, disputeId, { forUpdate: true });
      if (!row) throw errors.protectedNotFound('dispute');
      await this.authorization.require(principal, MatchActions.withdrawDispute, {
        type: 'dispute',
        id: disputeId,
        organizationId,
        subjectPersonIds: row.submitted_by_person_id ? [row.submitted_by_person_id] : [],
        teamEntryId: row.submitting_team_entry_id,
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const next = DisputeMachine.next(row.status, 'withdraw');
      const updated = await trx
        .updateTable('disputes')
        .set({ status: next, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', disputeId)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.withdrawDispute.id,
        targetType: 'dispute',
        targetId: disputeId,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: input.reason,
        correlationId,
        details: { operation: 'withdraw', status: next, previousStatus: row.status },
      });
      await this.outbox.enqueue(trx, MatchEvents.disputeChanged, {
        organizationId,
        aggregateType: 'dispute',
        aggregateId: disputeId,
        payload: {
          disputeId,
          fixtureId: row.fixture_id,
          status: next,
          decision: null,
          publicationConsequence: null,
        },
        correlationId,
      });
      return toDispute(updated, await this.appealStatus(trx, organizationId, disputeId));
    });
  }

  /**
   * `GET /v1/disputes` (CMP-05, SPK-RESULT-005): staff holding the dispute read action (the same
   * action a single read uses), by season, fixture and status, newest first.
   */
  async list(principal: Principal, query: ListDisputesQuery): Promise<Page<Dispute>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MatchActions.readDispute, {
      type: 'dispute',
      organizationId,
    });
    const cursor = decodeCursor(query.cursor, DisputeCursor);
    if (query.cursor && !cursor) throw errors.validation('The cursor is not valid.');
    let q = this.db
      .selectFrom('disputes as d')
      .selectAll('d')
      .where('d.organization_id', '=', organizationId);
    if (query.fixtureId) q = q.where('d.fixture_id', '=', query.fixtureId);
    if (query.status) q = q.where('d.status', '=', query.status);
    if (query.seasonId) {
      const seasonId = query.seasonId;
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('fixtures as f')
            .select('f.id')
            .whereRef('f.organization_id', '=', 'd.organization_id')
            .whereRef('f.id', '=', 'd.fixture_id')
            .where('f.season_id', '=', seasonId),
        ),
      );
    }
    if (cursor) {
      const at = new Date(cursor.at);
      q = q.where((eb) =>
        eb.or([
          eb('d.created_at', '<', at),
          eb.and([eb('d.created_at', '=', at), eb('d.id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    const items: Dispute[] = [];
    for (const row of page) {
      items.push(toDispute(row, await this.appealStatus(this.db, organizationId, row.id)));
    }
    return { items, nextCursor: nextCursorOf(rows, page, query.limit) };
  }

  async get(principal: Principal, disputeId: string): Promise<Dispute> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, disputeId);
    if (!row) throw errors.protectedNotFound('dispute');
    await this.authorizeRead(principal, row);
    return toDispute(row, await this.appealStatus(this.db, organizationId, disputeId));
  }

  async listForFixture(principal: Principal, fixtureId: string): Promise<Dispute[]> {
    const organizationId = organizationOf(principal);
    const rows = await this.db
      .selectFrom('disputes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .orderBy('submitted_at')
      .execute();
    const out: Dispute[] = [];
    for (const row of rows) {
      const decision = await this.authorization.decide(principal, MatchActions.readDispute, {
        type: 'dispute',
        id: row.id,
        organizationId,
        teamEntryId: row.submitting_team_entry_id,
        protected: true,
      });
      if (decision.allowed) {
        out.push(toDispute(row, await this.appealStatus(this.db, organizationId, row.id)));
      }
    }
    if (out.length === 0 && !isStaffLike(principal)) {
      // Customers without authority over any dispute of the fixture learn nothing (§4.10).
      const fixture = await this.db
        .selectFrom('fixtures')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', fixtureId)
        .executeTakeFirst();
      if (!fixture) throw errors.protectedNotFound('fixture');
    }
    return out;
  }

  /** Pending disputes of a fixture for the readiness evaluator. */
  async pendingForFixture(
    db: Reader,
    organizationId: string,
    fixtureId: string,
  ): Promise<Array<{ id: string; status: DisputeRow['status']; submissionDeadlineAt: Date }>> {
    const rows = await db
      .selectFrom('disputes')
      .select(['id', 'status', 'submission_deadline_at'])
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .where('status', 'in', ['submitted', 'under_review'])
      .execute();
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      submissionDeadlineAt: new Date(r.submission_deadline_at),
    }));
  }

  private async authorizeRead(principal: Principal, row: DisputeRow): Promise<void> {
    await this.authorization.require(principal, MatchActions.readDispute, {
      type: 'dispute',
      id: row.id,
      organizationId: row.organization_id,
      teamEntryId: row.submitting_team_entry_id,
      protected: true,
    });
  }

  private async appealStatus(
    db: Reader,
    organizationId: string,
    disputeId: string,
  ): Promise<Dispute['appealStatus']> {
    const status = await this.discipline.appealStatusOfDispute(db, organizationId, disputeId);
    switch (status) {
      case null:
      case 'withdrawn':
        return 'none';
      case 'submitted':
      case 'under_review':
        return 'pending';
      case 'granted':
        return 'granted';
      case 'denied':
        return 'denied';
    }
  }

  private async load(
    db: Reader,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<DisputeRow | null> {
    let q = db
      .selectFrom('disputes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (options.forUpdate) q = q.forUpdate();
    return (await q.executeTakeFirst()) ?? null;
  }
}
