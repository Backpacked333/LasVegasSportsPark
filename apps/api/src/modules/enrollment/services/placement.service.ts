import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  PlacementMachine,
  errors,
  newId,
  type AssignPlacementInput,
  type CreatePlacementRequestInput,
  type EligibilityEvaluation,
  type ListPlacementRequestsQuery,
  type Page,
  type PlacementCandidate,
  type PlacementReason,
  type PlacementRequest,
  type Principal,
  type ProposePlacementInput,
  type RejectPlacementProposalInput,
  type ReleasePlacementInput,
} from '@sportspark/contracts';
import {
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type PlacementRequestsTable,
} from '@sportspark/db';
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
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  ELIGIBILITY_PORT,
  ROSTER_PORT,
  RosterService,
  TEAM_ENTRY_QUERY_PORT,
  type EligibilityPort,
  type RosterPort,
  type TeamEntryQueryPort,
} from '../../competition';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import {
  actorSnapshot,
  hiddenFrom,
  isStaffLike,
  minutesFrom,
  organizationOf,
  toPlacementRequest,
  type Reader,
} from '../enrollment.shared';
import { CapacityService, type PoolRow } from './capacity.service';
import { RegistrationEvaluator } from './registration-evaluator';

export type PlacementRow = Selectable<PlacementRequestsTable>;

/** Entry states that take players (competition TeamEntryMachine). */
const OPEN_ENTRY_STATES = ['applied', 'approved'];

/** Competition's eligibility reasons, plus an explicit pass so every decision states its basis. */
function reasonsOf(evaluation: EligibilityEvaluation): PlacementReason[] {
  const reasons: PlacementReason[] = evaluation.reasons.map((r) => ({
    code: r.code,
    severity: r.severity,
    message: r.message,
    source: r.source,
  }));
  if (
    evaluation.eligible &&
    !reasons.some((r) => r.severity === 'blocking' || r.severity === 'unknown')
  ) {
    reasons.unshift({
      code: 'eligible',
      severity: 'info',
      message: 'Eligible for this team entry under the season rule set.',
      source: { type: 'team_entry', id: evaluation.teamEntryId },
    });
  }
  return reasons;
}

/**
 * Free-agent placement (§4.4 PlacementRequest, PlacementMachine §4.6, SPK-PLACE-001..005).
 * Individual registrants record approved placement information; staff receive eligible candidate
 * team entries with explainable reasons from the competition EligibilityPort plus capacity facts,
 * and decide — placement is staff-reviewed (operator-mediated, DEC-031). A candidate list or a
 * proposal reserves nothing (SPK-PLACE-003). Assignment re-checks current eligibility and capacity
 * at commitment, then adds the roster membership through the competition module's own roster
 * command (which evaluates eligibility again inside its transaction). That command runs between two
 * enrollment transactions, recorded as one `operation`, so neither module writes the other's
 * tables (§4.2) and no transaction spans the other module's command. Placement requests are never
 * exposed publicly or to captains (SPK-PLACE-005).
 */
@Injectable()
export class PlacementService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly exceptions: OperationalExceptions,
    private readonly evaluator: RegistrationEvaluator,
    private readonly capacity: CapacityService,
    private readonly roster: RosterService,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly teamEntries: TeamEntryQueryPort,
    @Inject(ELIGIBILITY_PORT) private readonly eligibility: EligibilityPort,
    @Inject(ROSTER_PORT) private readonly rosters: RosterPort,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<PlacementRow | undefined> {
    let q = db
      .selectFrom('placement_requests')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // POST /placement-requests (SPK-PLACE-001)
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    input: CreatePlacementRequestInput,
    correlationId: string | null,
  ): Promise<PlacementRequest> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        input.participantPersonId,
      );
      await this.authorization.require(principal, EnrollmentActions.requestPlacement, {
        type: 'placement_request',
        organizationId,
        subjectPersonIds: [person.id],
      });
      if (input.applicationId) {
        const application = await trx
          .selectFrom('applications')
          .select('participant_person_id')
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.applicationId)
          .executeTakeFirst();
        if (!application || application.participant_person_id !== person.id) {
          throw errors.validation('The application belongs to another participant.', {
            path: 'applicationId',
          });
        }
      }
      for (const teammate of input.requestedTeammatePersonIds) {
        // Requested teammates are recorded by id only and never shown publicly (SPK-PLACE-005, DEC-051).
        if (!(await this.evaluator.participantOrNull(trx, organizationId, teammate))) {
          throw errors.validation('A requested teammate is not a person of this organization.', {
            path: 'requestedTeammatePersonIds',
          });
        }
      }
      const id = newId();
      try {
        await trx
          .insertInto('placement_requests')
          .values({
            id,
            organization_id: organizationId,
            participant_person_id: person.id,
            application_id: input.applicationId ?? null,
            enrollment_id: null,
            offering_id: input.offeringId ?? null,
            season_id: input.seasonId,
            status: 'unassigned',
            availability: json(input.availability),
            preferred_competition_id: input.preferredCompetitionId ?? null,
            preferred_division_id: input.preferredDivisionId ?? null,
            declared_level: input.declaredLevel ?? null,
            position_preferences: json(input.positionPreferences),
            requested_teammate_person_ids: json(input.requestedTeammatePersonIds),
            notes: input.notes ?? null,
            requested_by: json(actorSnapshot(principal)),
            requested_by_person_id: principal.personId,
            proposed_team_entry_id: null,
            proposed_at: null,
            proposed_by: null,
            assigned_team_entry_id: null,
            assigned_at: null,
            decided_by: null,
            decided_by_person_id: null,
            roster_membership_ref: null,
            last_operation_id: null,
            released_at: null,
            release_reason: null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error) && pgConstraintName(error) === 'placement_requests_live_idx') {
          throw errors.duplicateEntitlement(
            'A placement request for this participant and season already exists.',
            {
              participantPersonId: person.id,
              seasonId: input.seasonId,
            },
          );
        }
        if (isForeignKeyViolation(error)) throw errors.notFound('season or division');
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.requestPlacement.id,
        targetType: 'placement_request',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: { seasonId: input.seasonId, assistedByStaff: isStaffLike(principal) },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.placementRequested, {
        organizationId,
        aggregateType: 'placement_request',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          placementRequestId: id,
          seasonId: input.seasonId,
          participantPersonId: person.id,
        },
      });
      return toPlacementRequest((await this.load(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads (never public; the participant's authorized adults or staff, SPK-PLACE-005)
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<PlacementRequest> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('placement_request');
    await this.authorization.require(principal, EnrollmentActions.readPlacement, {
      type: 'placement_request',
      id,
      organizationId,
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return toPlacementRequest(row);
  }

  async list(
    principal: Principal,
    query: ListPlacementRequestsQuery,
  ): Promise<Page<PlacementRequest>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EnrollmentActions.managePlacement, {
      type: 'placement_request',
      organizationId,
    });
    let q = this.db
      .selectFrom('placement_requests')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', query.seasonId)
      .orderBy('created_at')
      .orderBy('id')
      .limit(query.limit);
    if (query.status) q = q.where('status', '=', query.status);
    return { items: (await q.execute()).map(toPlacementRequest), nextCursor: null };
  }

  // -------------------------------------------------------------------------------------------
  // Candidates (SPK-PLACE-002): explainable, read-only, reserves nothing (SPK-PLACE-003)
  // -------------------------------------------------------------------------------------------

  async candidates(principal: Principal, id: string): Promise<PlacementCandidate[]> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('placement_request');
    await this.authorization.require(principal, EnrollmentActions.managePlacement, {
      type: 'placement_request',
      id,
      organizationId,
      protected: await this.hidden(principal, row),
    });
    const now = this.clock.now();
    const teammates = new Set(row.requested_teammate_person_ids as string[]);
    const entries = (
      await this.teamEntries.listSeasonEntries(organizationId, row.season_id)
    ).filter((e) => OPEN_ENTRY_STATES.includes(e.status));
    const out: PlacementCandidate[] = [];
    for (const entry of entries) {
      const evaluation = await this.eligibility.evaluatePlayer(
        organizationId,
        entry.id,
        row.participant_person_id,
        now,
        {
          membershipStatus: 'active',
          actorIsStaff: true,
        },
      );
      const reasons = reasonsOf(evaluation);
      if (row.preferred_division_id) {
        const match = entry.divisionId === row.preferred_division_id;
        reasons.push({
          code: match ? 'preferred_division' : 'other_division',
          severity: 'info',
          message: match
            ? 'The team plays in the preferred division.'
            : 'The team plays outside the preferred division.',
          source: { type: 'division', id: entry.divisionId },
        });
      }
      const pool = await this.teamPool(this.db, organizationId, entry.id);
      if (pool && pool.capacity - pool.committed - pool.held < 1) {
        reasons.push({
          code: 'roster_capacity_full',
          severity: 'blocking',
          message: 'The team entry has no free roster place right now.',
          source: { type: 'capacity_pool', id: pool.id },
        });
      }
      const roster = await this.rosters.effectiveRoster(organizationId, entry.id, now);
      const onRoster = roster.filter((m) => teammates.has(m.personId)).length;
      if (onRoster > 0) {
        reasons.push({
          code: 'requested_teammates_on_roster',
          severity: 'info',
          message: `${onRoster} requested teammate(s) already play for this team.`,
          source: { type: 'team_entry', id: entry.id },
        });
      }
      const eligible = reasons.every((r) => r.severity !== 'blocking' && r.severity !== 'unknown');
      out.push({
        teamEntryId: entry.id,
        teamName: entry.teamName,
        divisionId: entry.divisionId,
        eligible,
        reasons,
        capacity: pool
          ? {
              poolId: pool.id,
              available: pool.capacity - pool.committed - pool.held,
              capacity: pool.capacity,
            }
          : null,
        requestedTeammatesOnRoster: onRoster,
        recommended: false,
      });
    }
    // Recommendation order: eligible first, then requested teammates, then the preferred division.
    const score = (c: PlacementCandidate) =>
      (c.eligible ? 1000 : 0) +
      c.requestedTeammatesOnRoster * 10 +
      (c.reasons.some((r) => r.code === 'preferred_division') ? 1 : 0);
    out.sort((a, b) => score(b) - score(a) || a.teamName.localeCompare(b.teamName));
    const best = out[0];
    if (best?.eligible) best.recommended = true;
    return out;
  }

  /** The enrollment-side roster-place pool of a team entry, when staff configured one. */
  private async teamPool(
    db: Reader,
    organizationId: string,
    teamEntryId: string,
  ): Promise<PoolRow | undefined> {
    return db
      .selectFrom('capacity_pools')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('scope_type', '=', 'team_entry')
      .where('scope_id', '=', teamEntryId)
      .where('unit', '=', 'roster_places')
      .where('status', '=', 'active')
      .orderBy('id')
      .executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // Propose / reject proposal (staff-reviewed; nothing is reserved)
  // -------------------------------------------------------------------------------------------

  async propose(
    principal: Principal,
    id: string,
    input: ProposePlacementInput,
    correlationId: string | null,
  ): Promise<PlacementRequest> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('placement_request');
      await this.authorization.require(principal, EnrollmentActions.managePlacement, {
        type: 'placement_request',
        id,
        organizationId,
        protected: await this.hidden(principal, row),
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = PlacementMachine.next(row.status, 'propose');
      await this.seasonEntry(trx, organizationId, row, input.teamEntryId);
      const evaluation = await this.eligibility.evaluatePlayer(
        organizationId,
        input.teamEntryId,
        row.participant_person_id,
        now,
        { membershipStatus: 'active', actorIsStaff: true },
        trx,
      );
      await trx
        .updateTable('placement_requests')
        .set({
          status,
          proposed_team_entry_id: input.teamEntryId,
          proposed_at: now,
          proposed_by: json(actorSnapshot(principal)),
          proposal_reasons: json(reasonsOf(evaluation)),
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.record(
        trx,
        principal,
        row,
        'enrollment.propose_placement',
        input.reason ?? null,
        correlationId,
        {
          teamEntryId: input.teamEntryId,
          eligible: evaluation.eligible,
        },
      );
      await this.outbox.enqueue(trx, EnrollmentEvents.placementProposed, {
        organizationId,
        aggregateType: 'placement_request',
        aggregateId: id,
        correlationId,
        payload: { organizationId, placementRequestId: id, teamEntryId: input.teamEntryId },
      });
      return toPlacementRequest((await this.load(trx, organizationId, id))!);
    });
  }

  async rejectProposal(
    principal: Principal,
    id: string,
    input: RejectPlacementProposalInput,
    correlationId: string | null,
  ): Promise<PlacementRequest> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('placement_request');
      await this.authorization.require(principal, EnrollmentActions.managePlacement, {
        type: 'placement_request',
        id,
        organizationId,
        protected: await this.hidden(principal, row),
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = PlacementMachine.next(row.status, 'reject_proposal');
      await trx
        .updateTable('placement_requests')
        .set({ status, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.record(
        trx,
        principal,
        row,
        'enrollment.reject_placement_proposal',
        input.reason,
        correlationId,
        {
          teamEntryId: row.proposed_team_entry_id,
        },
      );
      return toPlacementRequest((await this.load(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Assign (SPK-PLACE-003): check at commitment, roster add through competition, one operation
  // -------------------------------------------------------------------------------------------

  async assign(
    principal: Principal,
    id: string,
    input: AssignPlacementInput,
    correlationId: string | null,
  ): Promise<PlacementRequest> {
    // §4.7 invariants 3 and 12, §4.11, SPK-AT-023: every step runs in ONE transaction. The step
    // units below and competition's roster command join it (UnitOfWork.run is reentrant; each
    // joined unit is a savepoint), so the hold, the roster row, the committed place and the
    // operation commit together: a stop or an unexpected error between steps leaves nothing
    // half-applied and no operation `running`. A refused roster change is recorded (holds released,
    // operation failed, audit) and committed before it is reported.
    const outcome = await this.uow.run(() => this.assignSteps(principal, id, input, correlationId));
    if ('failure' in outcome) throw outcome.failure;
    return outcome.placement;
  }

  private async assignSteps(
    principal: Principal,
    id: string,
    input: AssignPlacementInput,
    correlationId: string | null,
  ): Promise<{ placement: PlacementRequest } | { failure: DomainError }> {
    const organizationId = organizationOf(principal);
    // Step 1: guards, current eligibility, capacity hold, operation.
    const prepared = await this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('placement_request');
      await this.authorization.require(principal, EnrollmentActions.managePlacement, {
        type: 'placement_request',
        id,
        organizationId,
        protected: await this.hidden(principal, row),
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      PlacementMachine.next(row.status, 'assign');
      const teamEntryId = input.teamEntryId ?? row.proposed_team_entry_id;
      if (!teamEntryId)
        throw errors.validation('Name the team entry or propose one first.', {
          path: 'teamEntryId',
        });
      await this.seasonEntry(trx, organizationId, row, teamEntryId);
      const evaluation = await this.eligibility.evaluatePlayer(
        organizationId,
        teamEntryId,
        row.participant_person_id,
        now,
        { membershipStatus: 'active', actorIsStaff: true },
        trx,
      );
      if (!evaluation.eligible) {
        throw errors.eligibility('The participant is not eligible for this team entry now.', {
          teamEntryId,
          reasons: evaluation.reasons,
        });
      }
      const pool = await this.teamPool(trx, organizationId, teamEntryId);
      const holds = pool
        ? await this.capacity.acquireHolds(trx, organizationId, {
            pools: [{ poolId: pool.id, quantity: 1 }],
            ownerKind: 'placement',
            ownerId: row.id,
            actor: principal,
            expiresAt: minutesFrom(now, this.evaluator.configuration.holdMinutes),
            correlationId,
          })
        : [];
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'enrollment.assign_placement',
        requestedBy: principal,
        correlationId,
        input: { placementRequestId: id, teamEntryId },
        status: 'running',
      });
      await trx
        .updateTable('placement_requests')
        .set({ last_operation_id: operationId, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      return {
        teamEntryId,
        holdIds: holds.map((h) => h.id),
        operationId,
        revision: row.revision + 1,
        participantPersonId: row.participant_person_id,
        reasons: reasonsOf(evaluation),
        poolId: pool?.id ?? null,
      };
    });

    // Step 2 (competition's command, joined to this transaction): the roster membership.
    let membershipId: string | null = null;
    let failure: DomainError | null = null;
    try {
      const roster = await this.roster.changeRoster(
        principal,
        prepared.teamEntryId,
        { changes: [{ action: 'add', personId: prepared.participantPersonId, status: 'active' }] },
        correlationId,
      );
      membershipId =
        roster.members.find((m) => m.personId === prepared.participantPersonId)?.id ?? null;
    } catch (error) {
      if (!DomainError.is(error)) throw error;
      // A retry after an interrupted assignment finds the membership already there: adopt it.
      const existing =
        error.code === 'RESOURCE_CONFLICT'
          ? (
              await this.rosters.effectiveRoster(
                organizationId,
                prepared.teamEntryId,
                this.clock.now(),
                this.uow.current(),
              )
            ).find((m) => m.personId === prepared.participantPersonId)
          : undefined;
      if (existing) membershipId = existing.membershipId;
      else failure = error;
    }

    if (failure) {
      // Step 3a: record the failure, give the held place back; the caller reports it after commit.
      const reported = failure;
      await this.uow.run(async ({ trx }) => {
        for (const holdId of prepared.holdIds) {
          await this.capacity.releaseHoldRow(
            trx,
            organizationId,
            holdId,
            'placement_failed',
            correlationId,
          );
        }
        await this.operations.transition(trx, prepared.operationId, 'failed', {
          error: { code: reported.code, message: reported.message, details: reported.details },
        });
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'enrollment.assign_placement_failed',
          targetType: 'placement_request',
          targetId: id,
          correlationId,
          operationId: prepared.operationId,
          reason: reported.message,
          details: { teamEntryId: prepared.teamEntryId, code: reported.code },
        });
      });
      return { failure: reported };
    }

    // Step 3b: commit the place and record the assignment.
    const placement = await this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.internal('placement request vanished');
      const status = PlacementMachine.next(row.status, 'assign');
      const decision: PlacementReason[] = [...prepared.reasons];
      let operationStatus: 'succeeded' | 'recovery_required' = 'succeeded';
      for (const holdId of prepared.holdIds) {
        try {
          await this.capacity.commitHold(
            trx,
            organizationId,
            holdId,
            { placementRequestId: id },
            correlationId,
          );
        } catch (error) {
          if (!DomainError.is(error) || error.code !== 'CAPACITY_UNAVAILABLE' || !prepared.poolId)
            throw error;
          try {
            await this.capacity.acquireCommitted(
              trx,
              organizationId,
              [{ poolId: prepared.poolId, quantity: 1 }],
              {
                placementRequestId: id,
              },
            );
          } catch (inner) {
            if (!DomainError.is(inner) || inner.code !== 'CAPACITY_UNAVAILABLE') throw inner;
            // The roster now has the player but the enrollment pool is full: keep it visible (§4.11).
            operationStatus = 'recovery_required';
            decision.push({
              code: 'roster_capacity_exceeded',
              severity: 'warning',
              message:
                'The roster place was taken before the assignment completed; staff must resolve the capacity.',
              source: { type: 'capacity_pool', id: prepared.poolId },
            });
            await this.exceptions.raise(trx, {
              organizationId,
              category: 'enrollment.placement_capacity',
              severity: 'high',
              title: 'Placement completed beyond the configured roster capacity',
              affectedType: 'placement_request',
              affectedId: id,
              ownerQueue: 'league_manager',
              dedupeKey: `placement_capacity:${id}`,
              details: { teamEntryId: prepared.teamEntryId, poolId: prepared.poolId },
            });
          }
        }
      }
      decision.push({
        code: 'capacity_checked',
        severity: 'info',
        message: prepared.poolId
          ? 'A roster place was committed in the team entry pool.'
          : 'Roster limits were checked by the competition rules.',
        source: {
          type: prepared.poolId ? 'capacity_pool' : 'team_entry',
          id: prepared.poolId ?? prepared.teamEntryId,
        },
      });
      await trx
        .updateTable('placement_requests')
        .set({
          status,
          assigned_team_entry_id: prepared.teamEntryId,
          assigned_at: now,
          decided_by: json(actorSnapshot(principal)),
          decided_by_person_id: principal.personId,
          decision_reasons: json(decision),
          roster_membership_ref: membershipId,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.operations.transition(trx, prepared.operationId, operationStatus, {
        result: {
          placementRequestId: id,
          teamEntryId: prepared.teamEntryId,
          rosterMembershipId: membershipId,
        },
      });
      await this.record(
        trx,
        principal,
        row,
        EnrollmentActions.managePlacement.id,
        input.reason ?? null,
        correlationId,
        {
          decision: 'assigned',
          teamEntryId: prepared.teamEntryId,
          rosterMembershipId: membershipId,
          reasonCodes: decision.map((r) => r.code),
        },
        prepared.operationId,
      );
      await this.outbox.enqueue(trx, EnrollmentEvents.placementAssigned, {
        organizationId,
        aggregateType: 'placement_request',
        aggregateId: id,
        correlationId,
        operationId: prepared.operationId,
        payload: {
          organizationId,
          placementRequestId: id,
          teamEntryId: prepared.teamEntryId,
          participantPersonId: row.participant_person_id,
          rosterMembershipRef: membershipId,
        },
      });
      return toPlacementRequest((await this.load(trx, organizationId, id))!);
    });
    return { placement };
  }

  // -------------------------------------------------------------------------------------------
  // Release (assigned → released): the roster removal goes through competition as well
  // -------------------------------------------------------------------------------------------

  async release(
    principal: Principal,
    id: string,
    input: ReleasePlacementInput,
    correlationId: string | null,
  ): Promise<PlacementRequest> {
    // §4.7 invariants 3 and 12: one transaction, as in assign (competition's command joins it).
    const outcome = await this.uow.run(() =>
      this.releaseSteps(principal, id, input, correlationId),
    );
    if ('failure' in outcome) throw outcome.failure;
    return outcome.placement;
  }

  private async releaseSteps(
    principal: Principal,
    id: string,
    input: ReleasePlacementInput,
    correlationId: string | null,
  ): Promise<{ placement: PlacementRequest } | { failure: DomainError }> {
    const organizationId = organizationOf(principal);
    const prepared = await this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('placement_request');
      await this.authorization.require(principal, EnrollmentActions.managePlacement, {
        type: 'placement_request',
        id,
        organizationId,
        protected: await this.hidden(principal, row),
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      PlacementMachine.next(row.status, 'release');
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'enrollment.release_placement',
        requestedBy: principal,
        correlationId,
        input: { placementRequestId: id },
        status: 'running',
      });
      return { row, operationId };
    });
    const teamEntryId = prepared.row.assigned_team_entry_id as string;
    try {
      await this.roster.changeRoster(
        principal,
        teamEntryId,
        {
          changes: [
            {
              action: 'remove',
              personId: prepared.row.participant_person_id,
              reason: input.reason,
            },
          ],
        },
        correlationId,
      );
    } catch (error) {
      // An unexpected error rolls the whole release back (nothing half-applied).
      if (!DomainError.is(error)) throw error;
      // Already off the roster (removed by the captain or staff): nothing left to remove.
      if (error.code !== 'NOT_FOUND') {
        const reported = error;
        await this.uow.run(async ({ trx }) => {
          await this.operations.transition(trx, prepared.operationId, 'failed', {
            error: { code: reported.code, message: reported.message },
          });
        });
        return { failure: reported };
      }
    }
    const placement = await this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.internal('placement request vanished');
      const status = PlacementMachine.next(row.status, 'release');
      const freed = await this.capacity.releaseAllocationsFor(
        trx,
        organizationId,
        { placementRequestId: id },
        input.reason,
      );
      await trx
        .updateTable('placement_requests')
        .set({ status, released_at: now, release_reason: input.reason, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.capacity.enqueueCapacityReleased(
        trx,
        organizationId,
        freed,
        'placement_released',
        correlationId,
      );
      await this.operations.transition(trx, prepared.operationId, 'succeeded', {
        result: { placementRequestId: id },
      });
      await this.record(
        trx,
        principal,
        row,
        'enrollment.release_placement',
        input.reason,
        correlationId,
        { teamEntryId },
        prepared.operationId,
      );
      await this.outbox.enqueue(trx, EnrollmentEvents.placementReleased, {
        organizationId,
        aggregateType: 'placement_request',
        aggregateId: id,
        correlationId,
        operationId: prepared.operationId,
        payload: { organizationId, placementRequestId: id, reason: input.reason },
      });
      return toPlacementRequest((await this.load(trx, organizationId, id))!);
    });
    return { placement };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /** The team entry must belong to the request's season and take players. */
  private async seasonEntry(
    trx: Trx,
    organizationId: string,
    row: PlacementRow,
    teamEntryId: string,
  ): Promise<void> {
    const entry = await this.teamEntries.findTeamEntry(organizationId, teamEntryId, trx);
    if (!entry || entry.seasonId !== row.season_id)
      throw errors.notFound('team_entry', teamEntryId);
    if (!OPEN_ENTRY_STATES.includes(entry.status)) {
      throw errors.invalidTransition('TeamEntry', entry.status, 'place_player');
    }
  }

  /** §4.10: a customer who may not read the request learns nothing about it. */
  private hidden(principal: Principal, row: PlacementRow): Promise<boolean> {
    return hiddenFrom(this.authorization, principal, EnrollmentActions.readPlacement, {
      type: 'placement_request',
      id: row.id,
      organizationId: row.organization_id,
      subjectPersonIds: [row.participant_person_id],
    });
  }

  private async record(
    trx: Trx,
    principal: Principal,
    row: PlacementRow,
    action: string,
    reason: string | null,
    correlationId: string | null,
    details: Record<string, unknown>,
    operationId: string | null = null,
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: principal,
      action,
      targetType: 'placement_request',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason,
      correlationId,
      operationId,
      details,
    });
  }
}
