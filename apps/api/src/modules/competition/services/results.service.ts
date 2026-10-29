import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  DomainError,
  encodeCursor,
  errors,
  hasStaffRole,
  newId,
  z,
  type ListResultRevisionsQuery,
  type Page,
  type Principal,
  type PublishResultInput,
  type PublishResultOutcome,
  type ResubmitResultInput,
  type ResultClassification,
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
  executorFor,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { MatchActions } from '../competition-matches.actions';
import { MatchEvents } from '../competition-matches.events';
import { RESULT_CORRECTION_REVIEW } from '../competition-matches.policy';
import { ASSIGNMENT_CHECK_PORT, type AssignmentCheckPort } from '../competition-matches.ports';
import { detailsOf, toResultRevision, withRuleSetRoles } from '../competition-matches.shared';
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
  iso,
  organizationOf,
  ruleSetContentOf,
  type SeasonRow,
} from '../competition.shared';
import { FixtureMachine } from '../competition.state-machines';
import { BracketsService, type CorrectionImpact } from './brackets.service';
import { DisciplineService } from './discipline.service';
import { FixturesService } from './fixtures.service';
import { StandingsService } from './standings.service';

type RevisionRow = Selectable<ResultRevisionsTable>;
type FixtureRow = Selectable<FixturesTable>;

interface FixtureContext {
  fixture: FixtureRow;
  season: SeasonRow;
  ruleSetId: string;
  ruleSetName: string;
  ruleSetVersion: number;
  rules: RuleSetContent;
}

const reviewDedupeKey = (revisionId: string): string => `result_correction:${revisionId}`;

const ResultCursor = z.object({ at: z.string(), id: z.uuid() });

/** Classifications recorded before kickoff: a game that will not (or did not yet) take place. */
const PRE_KICKOFF_CLASSIFICATIONS: readonly ResultClassification[] = [
  'forfeit',
  'canceled',
  'postponed',
];

/** Winner and loser of a decided game (forfeit: the forfeiting side loses); null when undecided. */
function sidesOf(
  revision: RevisionRow,
  fixture: FixtureRow,
): { winnerEntryId: string | null; loserEntryId: string | null } {
  const home = fixture.home_entry_id;
  const away = fixture.away_entry_id;
  if (!away) return { winnerEntryId: null, loserEntryId: null };
  if (revision.classification === 'forfeit' && revision.forfeiting_entry_id) {
    const loser = revision.forfeiting_entry_id;
    return { winnerEntryId: loser === home ? away : home, loserEntryId: loser };
  }
  if (
    revision.classification === 'completed' &&
    revision.home_score !== null &&
    revision.away_score !== null &&
    revision.home_score !== revision.away_score
  ) {
    return revision.home_score > revision.away_score
      ? { winnerEntryId: home, loserEntryId: away }
      : { winnerEntryId: away, loserEntryId: home };
  }
  // CMP-10: a drawn playoff game decided by a shootout (rule set tiebreak.playoff 'shootout').
  const shootout = revision.shootout_winner_entry_id ?? null;
  if (
    revision.classification === 'completed' &&
    shootout !== null &&
    (shootout === home || shootout === away)
  ) {
    return { winnerEntryId: shootout, loserEntryId: shootout === home ? away : home };
  }
  return { winnerEntryId: null, loserEntryId: null };
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
      this.assertKickoffPassed(context.fixture, input.classification);
      await this.assertShootoutAllowed(trx, context, input);
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
          shootout_winner_entry_id: input.shootoutWinnerEntryId ?? null,
          details: json(this.detailsFromInput(input, incidentIds)),
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
      this.assertKickoffPassed(context.fixture, input.classification);
      await this.assertShootoutAllowed(trx, context, input);
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
          shootout_winner_entry_id: input.shootoutWinnerEntryId ?? null,
          details: json(
            this.detailsFromInput(input, [...(previous.incidentIds ?? []), ...incidentIds]),
          ),
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
      // A correction waiting for management review that is returned closes its review task. CMP-11:
      // the task is found through the kernel's exception reads (IF-29) and resolved by the reviewer
      // as the audited actor (exceptions.manage_own_queue for the league manager queue).
      const task = await this.openReviewTask(trx, organizationId, revisionId);
      if (task) {
        await this.exceptions.transition(trx, principal, task.id, 'resolved', {
          reason: input.reason,
          correlationId: correlationId ?? undefined,
          resolution: {
            outcome: 'correction_returned',
            resultRevisionId: revisionId,
            reviewedBy: snapshotActor(principal),
          },
        });
      }
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

  /**
   * `POST /v1/results/{id}/publish`: submitted → official. A correction that would touch published
   * history (SPK-RESULT-004) is not published: a management review task is raised instead, and the
   * correction is published only when the reviewing manager names that open task
   * (`reviewExceptionId`), which records the decision and resolves the task.
   */
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
      const official = await this.officialOf(trx, organizationId, revision.fixture_id, {
        forUpdate: true,
      });
      if (!official && input.reviewExceptionId) {
        throw errors.validation('Only a correction of an official result is reviewed.', {
          reviewExceptionId: input.reviewExceptionId,
        });
      }
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'competition.publish_result',
        requestedBy: principal,
        correlationId,
        input: { resultRevisionId: revisionId, fixtureId: revision.fixture_id },
        status: 'running',
      });
      const isBracketGame = await this.brackets.isBracketFixture(
        trx,
        organizationId,
        revision.fixture_id,
      );
      // A bracket game's outcome (winner and loser) before and after this publication.
      const previousSides = official ? sidesOf(official, context.fixture) : null;
      const nextSides = sidesOf(revision, context.fixture);
      const outcomeChanged =
        previousSides !== null &&
        (previousSides.winnerEntryId !== nextSides.winnerEntryId ||
          previousSides.loserEntryId !== nextSides.loserEntryId);
      // The bracket already progressed on the previous outcome: a change has to revise it.
      const revisesProgression =
        isBracketGame && outcomeChanged && previousSides?.winnerEntryId !== null;
      let reviewed: { exceptionId: string; impact: CorrectionImpact } | null = null;
      if (official) {
        if (!(revision.reason ?? input.reason)) {
          throw errors.validation('A correction of an official result requires a reason.');
        }
        let impact = await this.correctionImpact(trx, context, revision.id, isBracketGame);
        if (revisesProgression) {
          // SPK-RESULT-004: downstream nodes that already act on the old outcome are not rewritten
          // silently; with any of them the correction waits for management review.
          const blockers = await this.brackets.revisionBlockers(
            trx,
            organizationId,
            revision.fixture_id,
          );
          impact = {
            bracketNodeIds: [
              ...new Set([...impact.bracketNodeIds, ...blockers.bracketNodeIds]),
            ].sort(),
            fixtureIds: [...new Set([...impact.fixtureIds, ...blockers.fixtureIds])].sort(),
          };
        }
        if (input.reviewExceptionId) {
          // The named task must be this correction's open review task (it is resolved below).
          await this.assertReviewTask(trx, principal, input.reviewExceptionId, revisionId);
          reviewed = { exceptionId: input.reviewExceptionId, impact };
        } else if (impact.bracketNodeIds.length > 0 || impact.fixtureIds.length > 0) {
          return this.requireReview(trx, principal, {
            revision,
            official,
            impact,
            input,
            correlationId,
            operationId,
          });
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

      // Served suspensions (SPK-DISC-002 completion by match count): only a match that took place.
      const at = context.fixture.scheduled_start ? new Date(context.fixture.scheduled_start) : now;
      if (outcome) {
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
      }
      // Cards propose the suspensions the approved rule set prescribes (SPK-DISC-003).
      const proposedSuspensionIds = await this.discipline.proposeFromRuleSet(trx, principal, {
        organizationId,
        fixtureId: revision.fixture_id,
        resultRevisionId: revisionId,
        seasonId: context.fixture.season_id,
        competitionId: context.season.competition_id,
        ruleSet: {
          id: context.ruleSetId,
          name: context.ruleSetName,
          version: context.ruleSetVersion,
          cards: context.rules.cards,
        },
        resultCards: detailsOf(updated).cards,
        correlationId,
        operationId,
      });
      // CMP-12 (SPK-DISC-001, SPK-RESULT-004): a correction that removed the card behind a
      // suspension overturns a proposed one and raises a league-manager exception for an active one.
      if (official) {
        await this.discipline.reconcileRemovedCards(trx, principal, {
          organizationId,
          fixtureId: revision.fixture_id,
          seasonId: context.fixture.season_id,
          cards: context.rules.cards,
          resultCards: detailsOf(updated).cards,
          correlationId,
          operationId,
        });
      }
      // Bracket progression of a playoff game (SPK-COMP-001, SPK-RESULT-004): the first result
      // with a winner fills the empty slots it feeds; a correction that changes a recorded
      // outcome revises the progression when nothing downstream acts on it yet (otherwise it was
      // reviewed above, and the published bracket stays as history).
      let progressedBracketNodeIds: string[] = [];
      if (isBracketGame && (!previousSides || previousSides.winnerEntryId === null)) {
        progressedBracketNodeIds = await this.brackets.recordOutcome(trx, principal, {
          organizationId,
          fixtureId: revision.fixture_id,
          ...sidesOf(updated, context.fixture),
          correlationId,
          operationId,
        });
      } else if (revisesProgression && !reviewed && previousSides) {
        progressedBracketNodeIds = await this.brackets.reviseOutcome(trx, principal, {
          organizationId,
          fixtureId: revision.fixture_id,
          previous: previousSides,
          next: sidesOf(updated, context.fixture),
          correlationId,
          operationId,
        });
      }
      // League standings derive from league-phase official results only (SPK-RESULT-001).
      const standings = isBracketGame
        ? null
        : await this.standings.recompute(trx, principal, {
            organizationId,
            seasonId: context.fixture.season_id,
            divisionId: context.fixture.division_id,
            triggerResultId: revisionId,
            correlationId,
            operationId,
          });
      if (reviewed) {
        // The management review task is resolved by this decision; the published bracket and the
        // downstream games are not rewritten here (they stay as published history). The reviewing
        // manager is the audited actor (CMP-11).
        await this.exceptions.transition(trx, principal, reviewed.exceptionId, 'resolved', {
          reason: updated.reason ?? undefined,
          correlationId: correlationId ?? undefined,
          resolution: {
            outcome: 'correction_published',
            resultRevisionId: revisionId,
            supersededRevisionId: official?.id ?? null,
            reviewedBy: snapshotActor(principal),
          },
        });
      }

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
          standingsProjectionId: standings?.id ?? null,
          reviewExceptionId: reviewed?.exceptionId ?? null,
          affectedBracketNodeIds: reviewed?.impact.bracketNodeIds ?? [],
          affectedFixtureIds: reviewed?.impact.fixtureIds ?? [],
          proposedSuspensionIds,
          progressedBracketNodeIds,
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
          standingsProjectionId: standings?.id ?? null,
          reviewExceptionId: reviewed?.exceptionId ?? null,
          affectedBracketNodeIds: reviewed?.impact.bracketNodeIds ?? [],
          affectedFixtureIds: reviewed?.impact.fixtureIds ?? [],
          operationId,
        },
        correlationId,
        operationId,
      });
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: {
          resultRevisionId: revisionId,
          supersededRevisionId: official?.id ?? null,
          standingsProjectionId: standings?.id ?? null,
          reviewExceptionId: reviewed?.exceptionId ?? null,
        },
      });
      return {
        revision: toResultRevision(updated),
        published: true,
        supersededRevisionId: official?.id ?? null,
        reviewExceptionId: reviewed?.exceptionId ?? null,
        standings,
        proposedSuspensionIds,
        progressedBracketNodeIds,
        operationId,
      };
    });
  }

  /** Raises (or rejoins) the management review task; nothing is rewritten (SPK-RESULT-004, SPK-AT-014). */
  private async requireReview(
    trx: Trx,
    principal: Principal,
    input: {
      revision: RevisionRow;
      official: RevisionRow;
      impact: CorrectionImpact;
      input: PublishResultInput;
      correlationId: string | null;
      operationId: string;
    },
  ): Promise<PublishResultOutcome> {
    const { revision, official, impact, correlationId, operationId } = input;
    const organizationId = revision.organization_id;
    const exception = await this.exceptions.raise(trx, {
      organizationId,
      category: RESULT_CORRECTION_REVIEW.category,
      severity: RESULT_CORRECTION_REVIEW.severity,
      title: 'Result correction affects published history',
      affectedType: 'result_revision',
      affectedId: revision.id,
      ownerQueue: RESULT_CORRECTION_REVIEW.ownerQueue,
      dedupeKey: reviewDedupeKey(revision.id),
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
      targetId: revision.id,
      beforeRevision: revision.revision,
      afterRevision: revision.revision,
      reason: input.input.reason ?? revision.reason,
      correlationId,
      operationId,
      details: {
        outcome: 'review_required',
        exceptionId: exception.id,
        affectedBracketNodeIds: impact.bracketNodeIds,
        affectedFixtureIds: impact.fixtureIds,
      },
    });
    if (!exception.deduplicated) {
      await this.outbox.enqueue(trx, MatchEvents.resultCorrectionReviewRequired, {
        organizationId,
        aggregateType: 'result_revision',
        aggregateId: revision.id,
        payload: {
          resultRevisionId: revision.id,
          fixtureId: revision.fixture_id,
          officialRevisionId: official.id,
          exceptionId: exception.id,
          affectedBracketNodeIds: impact.bracketNodeIds,
          affectedFixtureIds: impact.fixtureIds,
        },
        correlationId,
        operationId,
      });
    }
    await this.operations.transition(trx, operationId, 'succeeded', {
      result: { outcome: 'review_required', exceptionId: exception.id },
    });
    return {
      revision: toResultRevision(revision),
      published: false,
      supersededRevisionId: null,
      reviewExceptionId: exception.id,
      standings: null,
      proposedSuspensionIds: [],
      progressedBracketNodeIds: [],
      operationId,
    };
  }

  /**
   * What a correction would touch (SPK-RESULT-004): for a playoff game, the published nodes it
   * plays or feeds and downstream games already played; for a league game, the published nodes
   * whose standings seed would change if the correction became official.
   */
  private async correctionImpact(
    trx: Trx,
    context: FixtureContext,
    candidateRevisionId: string,
    isBracketGame: boolean,
  ): Promise<CorrectionImpact> {
    const { fixture } = context;
    const organizationId = fixture.organization_id;
    if (isBracketGame) return this.brackets.correctionImpact(trx, organizationId, fixture.id);
    const depth = await this.brackets.publishedSeedDepth(
      trx,
      organizationId,
      fixture.season_id,
      fixture.division_id,
    );
    if (depth === 0) return { bracketNodeIds: [], fixtureIds: [] };
    const before = await this.standings.seedOrder(
      trx,
      organizationId,
      fixture.season_id,
      fixture.division_id,
    );
    const after = await this.standings.seedOrder(
      trx,
      organizationId,
      fixture.season_id,
      fixture.division_id,
      { fixtureId: fixture.id, resultRevisionId: candidateRevisionId },
    );
    const changed = new Set<number>();
    for (let seed = 1; seed <= depth; seed += 1) {
      if (before[seed - 1] !== after[seed - 1]) changed.add(seed);
    }
    return this.brackets.seedImpact(
      trx,
      organizationId,
      fixture.season_id,
      fixture.division_id,
      changed,
    );
  }

  /** The review task named by the manager must be the open one raised for this correction. */
  private async assertReviewTask(
    trx: Trx,
    principal: Principal,
    exceptionId: string,
    revisionId: string,
  ): Promise<void> {
    if (!hasStaffRole(principal, ...RESULT_CORRECTION_REVIEW.reviewerRoles)) {
      throw errors.accessDenied('Only league management decides a result correction review.', {
        action: MatchActions.publishResult.id,
      });
    }
    const task = await this.exceptions.get(organizationOf(principal), exceptionId, trx);
    const matches =
      task !== null &&
      task.category === RESULT_CORRECTION_REVIEW.category &&
      task.affected_type === 'result_revision' &&
      task.affected_id === revisionId;
    if (!matches) {
      throw errors.validation('The review task does not belong to this correction.', {
        reviewExceptionId: exceptionId,
      });
    }
    if (task.status !== 'open' && task.status !== 'acknowledged') {
      throw errors.invalidTransition('ResultCorrectionReview', task.status, 'publish');
    }
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

  /**
   * CMP-05 (SPK-RESULT-004): the result revisions of a season, newest first, for staff who hold the
   * result read action (the same action a single read uses), e.g. the submitted results awaiting
   * publication across the season.
   */
  async listForSeason(
    principal: Principal,
    seasonId: string,
    query: ListResultRevisionsQuery,
  ): Promise<Page<ResultRevision>> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const season = await loadSeasonRow(db, organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    await this.authorization.require(principal, MatchActions.readResults, {
      type: 'season',
      id: seasonId,
      organizationId,
    });
    const cursor = decodeCursor(query.cursor, ResultCursor);
    if (query.cursor && !cursor) throw errors.validation('The cursor is not valid.');
    let q = db
      .selectFrom('result_revisions as r')
      .innerJoin('fixtures as f', (join) =>
        join
          .onRef('f.organization_id', '=', 'r.organization_id')
          .onRef('f.id', '=', 'r.fixture_id'),
      )
      .selectAll('r')
      .where('r.organization_id', '=', organizationId)
      .where('f.season_id', '=', seasonId);
    if (query.status) q = q.where('r.status', '=', query.status);
    if (cursor) {
      const at = new Date(cursor.at);
      q = q.where((eb) =>
        eb.or([
          eb('r.created_at', '<', at),
          eb.and([eb('r.created_at', '=', at), eb('r.id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('r.created_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toResultRevision),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: iso(last.created_at), id: last.id })
          : null,
    };
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
  /** The open management review task of a correction, through the kernel's reads (IF-29). */
  private async openReviewTask(
    trx: Trx,
    organizationId: string,
    revisionId: string,
  ): Promise<{ id: string } | null> {
    const page = await this.exceptions.list(
      organizationId,
      {
        statuses: ['open', 'acknowledged'],
        category: RESULT_CORRECTION_REVIEW.category,
        affectedType: 'result_revision',
        affectedId: revisionId,
        limit: 1,
      },
      trx,
    );
    return page.items[0] ?? null;
  }

  /**
   * CMP-12 (SPK-RESULT-001): a played result waits for kickoff; before the scheduled start only a
   * forfeit, cancellation or postponement is recorded (INVALID_TRANSITION FIXTURE_NOT_STARTED).
   */
  private assertKickoffPassed(fixture: FixtureRow, classification: ResultClassification): void {
    if (!fixture.scheduled_start || PRE_KICKOFF_CLASSIFICATIONS.includes(classification)) return;
    if (this.clock.now().getTime() >= new Date(fixture.scheduled_start).getTime()) return;
    throw new DomainError('INVALID_TRANSITION', 'The fixture has not started yet.', {
      details: {
        code: 'FIXTURE_NOT_STARTED',
        fixtureId: fixture.id,
        scheduledStart: new Date(fixture.scheduled_start).toISOString(),
        classification,
      },
    });
  }

  /**
   * CMP-10 (SPK-COMP-001, DEC-002): a drawn bracket game names a shootout winner only when the
   * season's rule set says `tiebreak.playoff: shootout`; a league game never does.
   */
  private async assertShootoutAllowed(
    trx: Trx,
    context: FixtureContext,
    input: SubmitResultInput | ResubmitResultInput,
  ): Promise<void> {
    if (!input.shootoutWinnerEntryId) return;
    const allowed =
      context.rules.tiebreak?.playoff === 'shootout' &&
      (await this.brackets.isBracketFixture(
        trx,
        context.fixture.organization_id,
        context.fixture.id,
      ));
    if (!allowed) {
      throw errors.validation('A shootout does not decide this game under its rule set.', {
        code: 'SHOOTOUT_NOT_ALLOWED',
        fixtureId: context.fixture.id,
      });
    }
  }

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
    return {
      fixture,
      season,
      ruleSetId: ruleSet.id,
      ruleSetName: ruleSet.name,
      ruleSetVersion: ruleSet.version,
      rules: ruleSetContentOf(ruleSet),
    };
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
    if (input.shootoutWinnerEntryId && !sides.includes(input.shootoutWinnerEntryId)) {
      throw errors.validation('The shootout winner must be one of the fixture sides.', {
        shootoutWinnerEntryId: input.shootoutWinnerEntryId,
      });
    }
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

  private detailsFromInput(
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

  private fixtureOutcomeOf(revision: RevisionRow): {
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
