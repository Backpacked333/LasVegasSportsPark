import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  hasStaffRole,
  newId,
  type Principal,
  type PublishResultInput,
  type PublishResultOutcome,
  type ResubmitResultInput,
  type ResultDetails,
  type ResultRevision,
  type ReturnResultInput,
  type RuleSetContent,
  type SubmitResultInput,
} from '@sportspark/contracts';
import { json, type Db, type FixturesTable, type ResultRevisionsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { MatchActions } from '../competition-matches.actions';
import { MatchEvents } from '../competition-matches.events';
import { RESULT_CORRECTION_REVIEW } from '../competition-matches.policy';
import { ASSIGNMENT_CHECK_PORT, type AssignmentCheckPort } from '../competition-matches.ports';
import { toResultRevision, withRuleSetRoles } from '../competition-matches.shared';
import { ResultMachine } from '../competition-matches.state-machines';
import {
  loadRuleSetRow,
  loadSeasonRow,
  rosterRowsEffectiveAt,
  statusAt,
  type Reader,
} from '../competition.queries';
import {
  isStaffLike,
  organizationOf,
  ruleSetContentOf,
  type SeasonRow,
} from '../competition.shared';
import { FixtureMachine } from '../competition.state-machines';
import { BracketsService } from './brackets.service';
import { DisciplineService } from './discipline.service';
import { FixturesService } from './fixtures.service';
import { StandingsService } from './standings.service';

type RevisionRow = Selectable<ResultRevisionsTable>;
type FixtureRow = Selectable<FixturesTable>;

interface FixtureContext {
  fixture: FixtureRow;
  season: SeasonRow;
  ruleSetId: string;
  rules: RuleSetContent;
}

/**
 * Result revisions (§4.6 Result: draft → submitted → official → superseded; SPK-RESULT-001/002/004,
 * SPK-STAFF-005, §4.8 `POST /v1/fixtures/{id}/results`, `POST /v1/results/{id}/publish`).
 *
 * - Submission: an accepted official (through the assignment port) or league administration, within
 *   the rule set's `submitRoles`; scores, classification, cards, incidents and abandonment details.
 * - Publication: the only path to an official result (§4.7 invariant 8). The action's static roles
 *   plus the rule set's `approveRoles` decide (DEC-065). Standings are recomputed in the same
 *   transaction; the fixture moves to played/forfeit/abandoned through the fixture port; served
 *   suspensions are counted.
 * - Corrections: a new revision superseding the official one; actor, reason and publication time
 *   of the superseded row are preserved (the database trigger allows nothing else). When the
 *   fixture feeds a published bracket node or a downstream game already played, nothing is
 *   rewritten: an operational exception owned by the league manager is raised instead
 *   (SPK-RESULT-004, SPK-AT-014).
 */
@Injectable()
export class ResultsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly exceptions: OperationalExceptions,
    private readonly fixtures: FixturesService,
    private readonly standings: StandingsService,
    private readonly brackets: BracketsService,
    private readonly discipline: DisciplineService,
    @Inject(ASSIGNMENT_CHECK_PORT) private readonly assignments: AssignmentCheckPort,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------
  /** `POST /v1/fixtures/{id}/results`: a new revision, submitted in the same command (draft → submitted). */
  async submit(
    principal: Principal,
    fixtureId: string,
    input: SubmitResultInput,
    correlationId: string | null,
  ): Promise<ResultRevision> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const context = await this.loadContext(trx, organizationId, fixtureId, { forUpdate: true });
      await this.authorizeSubmit(trx, principal, context);
      this.validateInput(context.fixture, input);
      if (context.fixture.status === 'canceled') {
        throw errors.invalidTransition('Fixture', context.fixture.status, 'submit_result');
      }
      const open = await trx
        .selectFrom('result_revisions')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('fixture_id', '=', fixtureId)
        .where('status', 'in', ['draft', 'submitted'])
        .executeTakeFirst();
      if (open) {
        throw errors.resourceConflict(
          'A result revision for this fixture is already in progress.',
          {
            resultRevisionId: open.id,
          },
        );
      }
      const official = await this.officialOf(trx, organizationId, fixtureId);
      if (official && !input.reason) {
        throw errors.validation('A correction of an official result requires a reason.', {
          officialRevisionId: official.id,
        });
      }
      const last = await trx
        .selectFrom('result_revisions')
        .select((eb) => eb.fn.max('revision_no').as('n'))
        .where('organization_id', '=', organizationId)
        .where('fixture_id', '=', fixtureId)
        .executeTakeFirst();
      const revisionNo = Number(last?.n ?? 0) + 1;
      const id = newId();
      const incidentIds = await this.recordIncidents(trx, principal, context, input, correlationId);
      const now = this.clock.now();
      const status = ResultMachine.next(ResultMachine.initial, 'submit');
      const row = await trx
        .insertInto('result_revisions')
        .values({
          id,
          organization_id: organizationId,
          fixture_id: fixtureId,
          revision_no: revisionNo,
          status,
          classification: input.classification,
          home_score: input.homeScore ?? null,
          away_score: input.awayScore ?? null,
          forfeiting_entry_id: input.forfeitingEntryId ?? null,
          details: json(this.detailsOf(input, incidentIds)),
          submitted_by: json(snapshotActor(principal)),
          submitted_by_person_id: principal.personId,
          submitted_at: now,
          returned_at: null,
          returned_by: null,
          return_reason: null,
          published_by: null,
          published_by_person_id: null,
          published_at: null,
          supersedes_revision_id: official?.id ?? null,
          superseded_at: null,
          superseded_by: null,
          superseded_by_revision_id: null,
          reason: input.reason ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.linkIncidents(trx, organizationId, id, incidentIds);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.submitResult.id,
        targetType: 'result_revision',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          fixtureId,
          revisionNo,
          transitions: [ResultMachine.initial, status],
          classification: input.classification,
          correctionOf: official?.id ?? null,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.resultSubmitted, {
        organizationId,
        aggregateType: 'result_revision',
        aggregateId: id,
        payload: {
          resultRevisionId: id,
          fixtureId,
          seasonId: context.fixture.season_id,
          revisionNo,
          classification: input.classification,
          isCorrection: official !== null,
        },
        correlationId,
      });
      return toResultRevision(row);
    });
  }

  /** `POST /v1/results/{id}/submit`: a revision returned for correction goes back to submitted. */
  async resubmit(
    principal: Principal,
    revisionId: string,
    input: ResubmitResultInput,
    correlationId: string | null,
  ): Promise<ResultRevision> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const revision = await this.loadRevision(trx, organizationId, revisionId, {
        forUpdate: true,
      });
      if (!revision) throw errors.notFound('result_revision', revisionId);
      const context = await this.loadContext(trx, organizationId, revision.fixture_id, {
        forUpdate: true,
      });
      await this.authorizeSubmit(trx, principal, context);
      assertExpectedRevision(input.expectedRevision, revision.revision);
      const next = ResultMachine.next(revision.status, 'submit');
      this.validateInput(context.fixture, input);
      const previous = revision.details as Partial<ResultDetails>;
      const incidentIds = await this.recordIncidents(trx, principal, context, input, correlationId);
      const now = this.clock.now();
      const updated = await trx
        .updateTable('result_revisions')
        .set({
          status: next,
          classification: input.classification,
          home_score: input.homeScore ?? null,
          away_score: input.awayScore ?? null,
          forfeiting_entry_id: input.forfeitingEntryId ?? null,
          details: json(this.detailsOf(input, [...(previous.incidentIds ?? []), ...incidentIds])),
          submitted_by: json(snapshotActor(principal)),
          submitted_by_person_id: principal.personId,
          submitted_at: now,
          reason: input.reason ?? revision.reason,
          revision: revision.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', revisionId)
        .where('revision', '=', revision.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.linkIncidents(trx, organizationId, revisionId, incidentIds);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.submitResult.id,
        targetType: 'result_revision',
        targetId: revisionId,
        beforeRevision: revision.revision,
        afterRevision: updated.revision,
        reason: input.reason ?? null,
        correlationId,
        details: { transitions: [revision.status, next], classification: input.classification },
      });
      await this.outbox.enqueue(trx, MatchEvents.resultSubmitted, {
        organizationId,
        aggregateType: 'result_revision',
        aggregateId: revisionId,
        payload: {
          resultRevisionId: revisionId,
          fixtureId: revision.fixture_id,
          seasonId: context.fixture.season_id,
          revisionNo: revision.revision_no,
          classification: input.classification,
          isCorrection: revision.supersedes_revision_id !== null,
        },
        correlationId,
      });
      return toResultRevision(updated);
    });
  }

  /** `POST /v1/results/{id}/return`: submitted → draft with the reviewer's reason. */
  async returnForCorrection(
    principal: Principal,
    revisionId: string,
    input: ReturnResultInput,
    correlationId: string | null,
  ): Promise<ResultRevision> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const revision = await this.loadRevision(trx, organizationId, revisionId, {
        forUpdate: true,
      });
      if (!revision) throw errors.notFound('result_revision', revisionId);
      await this.authorization.require(principal, MatchActions.reviewResult, {
        type: 'result_revision',
        id: revisionId,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, revision.revision);
      const next = ResultMachine.next(revision.status, 'return_for_correction');
      const now = this.clock.now();
      const updated = await trx
        .updateTable('result_revisions')
        .set({
          status: next,
          returned_at: now,
          returned_by: json(snapshotActor(principal)),
          return_reason: input.reason,
          revision: revision.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', revisionId)
        .where('revision', '=', revision.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.reviewResult.id,
        targetType: 'result_revision',
        targetId: revisionId,
        beforeRevision: revision.revision,
        afterRevision: updated.revision,
        reason: input.reason,
        correlationId,
        details: { transitions: [revision.status, next] },
      });
      await this.outbox.enqueue(trx, MatchEvents.resultReturned, {
        organizationId,
        aggregateType: 'result_revision',
        aggregateId: revisionId,
        payload: {
          resultRevisionId: revisionId,
          fixtureId: revision.fixture_id,
          reason: input.reason,
        },
        correlationId,
      });
      return toResultRevision(updated);
    });
  }

  /** `POST /v1/results/{id}/publish`: submitted → official (or management review for a risky correction). */
  async publish(
    principal: Principal,
    revisionId: string,
    input: PublishResultInput,
    correlationId: string | null,
  ): Promise<PublishResultOutcome> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const revision = await this.loadRevision(trx, organizationId, revisionId, {
        forUpdate: true,
      });
      if (!revision) throw errors.notFound('result_revision', revisionId);
      const context = await this.loadContext(trx, organizationId, revision.fixture_id, {
        forUpdate: true,
      });
      // §4.7 invariant 8: publication authority = league manager + the rule set's approval roles.
      await this.authorization.require(
        principal,
        withRuleSetRoles(MatchActions.publishResult, context.rules.resultApproval.approveRoles),
        { type: 'result_revision', id: revisionId, organizationId },
      );
      assertExpectedRevision(input.expectedRevision, revision.revision);
      const next = ResultMachine.next(revision.status, 'publish');
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'competition.publish_result',
        requestedBy: principal,
        correlationId,
        input: { resultRevisionId: revisionId, fixtureId: revision.fixture_id },
        status: 'running',
      });
      const official = await this.officialOf(trx, organizationId, revision.fixture_id, {
        forUpdate: true,
      });
      if (official) {
        if (!(revision.reason ?? input.reason)) {
          throw errors.validation('A correction of an official result requires a reason.');
        }
        const impact = await this.brackets.correctionImpact(
          trx,
          organizationId,
          revision.fixture_id,
        );
        if (impact.bracketNodeIds.length > 0 || impact.fixtureIds.length > 0) {
          const exception = await this.exceptions.raise(trx, {
            organizationId,
            category: RESULT_CORRECTION_REVIEW.category,
            severity: RESULT_CORRECTION_REVIEW.severity,
            title: 'Result correction affects published history',
            affectedType: 'result_revision',
            affectedId: revisionId,
            ownerQueue: RESULT_CORRECTION_REVIEW.ownerQueue,
            dedupeKey: `result_correction:${revisionId}`,
            details: {
              fixtureId: revision.fixture_id,
              officialRevisionId: official.id,
              affectedBracketNodeIds: impact.bracketNodeIds,
              affectedFixtureIds: impact.fixtureIds,
              requestedBy: snapshotActor(principal),
            },
          });
          await this.audit.record(trx, {
            organizationId,
            actor: principal,
            action: MatchActions.publishResult.id,
            targetType: 'result_revision',
            targetId: revisionId,
            beforeRevision: revision.revision,
            afterRevision: revision.revision,
            reason: input.reason ?? revision.reason,
            correlationId,
            operationId,
            details: {
              outcome: 'review_required',
              exceptionId: exception.id,
              affectedBracketNodeIds: impact.bracketNodeIds,
              affectedFixtureIds: impact.fixtureIds,
            },
          });
          await this.outbox.enqueue(trx, MatchEvents.resultCorrectionReviewRequired, {
            organizationId,
            aggregateType: 'result_revision',
            aggregateId: revisionId,
            payload: {
              resultRevisionId: revisionId,
              fixtureId: revision.fixture_id,
              officialRevisionId: official.id,
              exceptionId: exception.id,
              affectedBracketNodeIds: impact.bracketNodeIds,
              affectedFixtureIds: impact.fixtureIds,
            },
            correlationId,
            operationId,
          });
          await this.operations.transition(trx, operationId, 'succeeded', {
            result: { outcome: 'review_required', exceptionId: exception.id },
          });
          return {
            revision: toResultRevision(revision),
            published: false,
            supersededRevisionId: null,
            reviewExceptionId: exception.id,
            standings: null,
            operationId,
          };
        }
      }
      const now = this.clock.now();
      if (official) {
        // The superseded row keeps scores, actor, reason and publication time (§4.7 invariant 9).
        await trx
          .updateTable('result_revisions')
          .set({
            status: ResultMachine.next(official.status, 'supersede'),
            superseded_at: now,
            superseded_by: json(snapshotActor(principal)),
            superseded_by_revision_id: revisionId,
            revision: official.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', official.id)
          .where('revision', '=', official.revision)
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: MatchActions.publishResult.id,
          targetType: 'result_revision',
          targetId: official.id,
          beforeRevision: official.revision,
          afterRevision: official.revision + 1,
          reason: revision.reason ?? input.reason ?? null,
          correlationId,
          operationId,
          details: { transitions: ['official', 'superseded'], supersededBy: revisionId },
        });
      }
      const updated = await trx
        .updateTable('result_revisions')
        .set({
          status: next,
          published_by: json(snapshotActor(principal)),
          published_by_person_id: principal.personId,
          published_at: now,
          supersedes_revision_id: official?.id ?? revision.supersedes_revision_id,
          reason: revision.reason ?? input.reason ?? null,
          revision: revision.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', revisionId)
        .where('revision', '=', revision.revision)
        .returningAll()
        .executeTakeFirstOrThrow();

      // The fixture follows the classification through its own machine (part 1 port).
      const outcome = this.fixtureOutcomeOf(updated);
      if (outcome && FixtureMachine.can(context.fixture.status, outcome.event)) {
        await this.fixtures.recordOutcome(
          trx,
          principal,
          revision.fixture_id,
          outcome.outcome,
          `result ${updated.revision_no} published`,
          correlationId,
        );
      }

      // Served suspensions (SPK-DISC-002 completion by match count).
      const at = context.fixture.scheduled_start ? new Date(context.fixture.scheduled_start) : now;
      const personIds = await this.rosterPersons(trx, organizationId, context.fixture, at);
      await this.discipline.serveFixture(trx, principal, {
        organizationId,
        fixtureId: revision.fixture_id,
        competitionId: context.season.competition_id,
        personIds,
        at,
        correlationId,
        operationId,
      });

      const standings = await this.standings.recompute(trx, principal, {
        organizationId,
        seasonId: context.fixture.season_id,
        divisionId: context.fixture.division_id,
        triggerResultId: revisionId,
        correlationId,
        operationId,
      });

      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.publishResult.id,
        targetType: 'result_revision',
        targetId: revisionId,
        beforeRevision: revision.revision,
        afterRevision: updated.revision,
        reason: updated.reason,
        correlationId,
        operationId,
        details: {
          transitions: [revision.status, next],
          supersededRevisionId: official?.id ?? null,
          standingsProjectionId: standings.id,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.resultPublished, {
        organizationId,
        aggregateType: 'result_revision',
        aggregateId: revisionId,
        payload: {
          resultRevisionId: revisionId,
          fixtureId: revision.fixture_id,
          seasonId: context.fixture.season_id,
          divisionId: context.fixture.division_id,
          status: next,
          classification: updated.classification,
          supersededRevisionId: official?.id ?? null,
          standingsProjectionId: standings.id,
          operationId,
        },
        correlationId,
        operationId,
      });
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: {
          resultRevisionId: revisionId,
          supersededRevisionId: official?.id ?? null,
          standingsProjectionId: standings.id,
        },
      });
      return {
        revision: toResultRevision(updated),
        published: true,
        supersededRevisionId: official?.id ?? null,
        reviewExceptionId: null,
        standings,
        operationId,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------
  /** Staff see every revision; customers who may read the fixture see its published history only. */
  async listForFixture(principal: Principal, fixtureId: string): Promise<ResultRevision[]> {
    await this.fixtures.get(principal, fixtureId); // authorizes (protected NOT_FOUND, §4.10)
    const organizationId = organizationOf(principal);
    const rows = await this.db
      .selectFrom('result_revisions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .orderBy('revision_no')
      .execute();
    const visible = isStaffLike(principal)
      ? rows
      : rows.filter((r) => r.status === 'official' || r.status === 'superseded');
    return visible.map(toResultRevision);
  }

  async get(principal: Principal, revisionId: string): Promise<ResultRevision> {
    const organizationId = organizationOf(principal);
    const row = await this.loadRevision(this.db, organizationId, revisionId);
    if (!row) throw errors.protectedNotFound('result_revision');
    await this.fixtures.get(principal, row.fixture_id);
    if (!isStaffLike(principal) && row.status !== 'official' && row.status !== 'superseded') {
      throw errors.protectedNotFound('result_revision');
    }
    return toResultRevision(row);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  private async loadContext(
    db: Reader,
    organizationId: string,
    fixtureId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<FixtureContext> {
    let q = db
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', fixtureId);
    if (options.forUpdate) q = q.forUpdate();
    const fixture = await q.executeTakeFirst();
    if (!fixture) throw errors.notFound('fixture', fixtureId);
    const season = await loadSeasonRow(db, organizationId, fixture.season_id);
    if (!season) throw errors.notFound('season', fixture.season_id);
    const ruleSet = await loadRuleSetRow(db, organizationId, season.rule_set_id);
    if (!ruleSet) throw errors.notFound('rule_set', season.rule_set_id);
    return { fixture, season, ruleSetId: ruleSet.id, rules: ruleSetContentOf(ruleSet) };
  }

  private async loadRevision(
    db: Reader,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<RevisionRow | null> {
    let q = db
      .selectFrom('result_revisions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (options.forUpdate) q = q.forUpdate();
    return (await q.executeTakeFirst()) ?? null;
  }

  private async officialOf(
    db: Reader,
    organizationId: string,
    fixtureId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<RevisionRow | null> {
    let q = db
      .selectFrom('result_revisions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .where('status', '=', 'official');
    if (options.forUpdate) q = q.forUpdate();
    return (await q.executeTakeFirst()) ?? null;
  }

  /**
   * SPK-STAFF-005: officials submit when they hold an accepted assignment for the fixture (the
   * assignment port; proposed assignments do not count, SPK-STAFF-002) and the rule set lists their
   * role among `submitRoles`; league administration submits directly.
   */
  private async authorizeSubmit(
    trx: Trx,
    principal: Principal,
    context: FixtureContext,
  ): Promise<void> {
    const organizationId = context.fixture.organization_id;
    await this.authorization.require(
      principal,
      withRuleSetRoles(MatchActions.submitResult, context.rules.resultApproval.submitRoles),
      { type: 'fixture', id: context.fixture.id, organizationId },
    );
    if (principal.kind !== 'staff') return;
    if (hasStaffRole(principal, 'league_manager', 'general_manager', 'system_administrator'))
      return;
    const allowedByRuleSet = principal.staffRoles.some((r) =>
      context.rules.resultApproval.submitRoles.includes(r),
    );
    const accepted =
      principal.personId !== null &&
      (await this.assignments.isAcceptedOfficial(
        organizationId,
        context.fixture.id,
        principal.personId,
        trx,
      ));
    if (!allowedByRuleSet || !accepted) {
      throw errors.accessDenied(
        'Only an accepted official for this fixture, or league administration, may submit its result.',
        { action: MatchActions.submitResult.id, fixtureId: context.fixture.id },
      );
    }
  }

  private validateInput(fixture: FixtureRow, input: SubmitResultInput | ResubmitResultInput): void {
    if (fixture.away_entry_id === null) {
      throw errors.validation('A bye has no result.', { fixtureId: fixture.id });
    }
    const sides = [fixture.home_entry_id, fixture.away_entry_id];
    if (input.forfeitingEntryId && !sides.includes(input.forfeitingEntryId)) {
      throw errors.validation('The forfeiting entry must be one of the fixture sides.', {
        forfeitingEntryId: input.forfeitingEntryId,
      });
    }
    for (const card of input.cards ?? []) {
      if (!sides.includes(card.teamEntryId)) {
        throw errors.validation('A card names an entry of this fixture.', { card });
      }
    }
    for (const incident of input.incidents ?? []) {
      if (incident.teamEntryId && !sides.includes(incident.teamEntryId)) {
        throw errors.validation('An incident names an entry of this fixture.', {
          teamEntryId: incident.teamEntryId,
        });
      }
    }
  }

  private detailsOf(
    input: SubmitResultInput | ResubmitResultInput,
    incidentIds: string[],
  ): ResultDetails {
    return {
      cards: (input.cards ?? []).map((c) => ({ ...c, minute: c.minute ?? null })),
      abandonment: input.abandonment ?? null,
      incidentIds,
      notes: input.notes ?? null,
      disputeId: input.disputeId ?? null,
    };
  }

  /** Incidents reported with the result are restricted records linked to the revision (SPK-DISC-001/004). */
  private async recordIncidents(
    trx: Trx,
    principal: Principal,
    context: FixtureContext,
    input: SubmitResultInput | ResubmitResultInput,
    correlationId: string | null,
  ): Promise<string[]> {
    const ids: string[] = [];
    const occurredAt = context.fixture.scheduled_start
      ? new Date(context.fixture.scheduled_start)
      : this.clock.now();
    for (const incident of input.incidents ?? []) {
      const id = newId();
      ids.push(id);
      await this.discipline.insertIncident(trx, principal, {
        id,
        organizationId: context.fixture.organization_id,
        kind: incident.kind,
        fixtureId: context.fixture.id,
        seasonId: context.fixture.season_id,
        competitionId: context.season.competition_id,
        subjectPersonId: incident.subjectPersonId ?? null,
        teamEntryId: incident.teamEntryId ?? null,
        // Linked by `linkIncidents` once the revision row exists (same transaction).
        resultRevisionId: null,
        occurredAt,
        minute: incident.minute ?? null,
        cardKind: incident.cardKind ?? null,
        severity: incident.severity,
        summary: incident.summary,
        narrative: incident.narrative ?? null,
        evidence: incident.evidence ?? [],
        correlationId,
      });
    }
    return ids;
  }

  private async linkIncidents(
    trx: Trx,
    organizationId: string,
    revisionId: string,
    incidentIds: string[],
  ): Promise<void> {
    if (incidentIds.length === 0) return;
    await trx
      .updateTable('incidents')
      .set({ result_revision_id: revisionId })
      .where('organization_id', '=', organizationId)
      .where('id', 'in', incidentIds)
      .execute();
  }

  private fixtureOutcomeOf(
    revision: RevisionRow,
  ): {
    outcome: 'played' | 'forfeit' | 'abandoned';
    event: 'record_played' | 'forfeit' | 'abandon';
  } | null {
    switch (revision.classification) {
      case 'completed':
        return { outcome: 'played', event: 'record_played' };
      case 'forfeit':
        return { outcome: 'forfeit', event: 'forfeit' };
      case 'abandoned':
        return { outcome: 'abandoned', event: 'abandon' };
      default:
        return null;
    }
  }

  private async rosterPersons(
    db: Reader,
    organizationId: string,
    fixture: FixtureRow,
    at: Date,
  ): Promise<string[]> {
    const persons = new Set<string>();
    for (const entryId of [fixture.home_entry_id, fixture.away_entry_id]) {
      if (!entryId) continue;
      for (const row of await rosterRowsEffectiveAt(db, organizationId, entryId, at)) {
        if (statusAt(row) !== null) persons.add(row.person_id);
      }
    }
    return [...persons];
  }
}
