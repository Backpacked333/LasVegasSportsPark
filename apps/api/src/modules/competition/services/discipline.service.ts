import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Appeal,
  type CreateAppealInput,
  type CreateDisciplinaryDecisionInput,
  type CreateIncidentInput,
  type CreateSuspensionInput,
  type DecideAppealInput,
  type DisciplinaryDecision,
  type Incident,
  type ListIncidentsQuery,
  type ListSuspensionsQuery,
  type OverturnDecisionInput,
  type Principal,
  type Suspension,
  type SuspensionTerms,
  type UpdateIncidentInput,
  type UpdateSuspensionInput,
} from '@sportspark/contracts';
import {
  json,
  type Db,
  type DisciplinaryDecisionsTable,
  type IncidentsTable,
  type SuspensionsTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  currentTransaction,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { MatchActions } from '../competition-matches.actions';
import { MatchEvents } from '../competition-matches.events';
import { toAppeal, toDecision, toIncident, toSuspension } from '../competition-matches.shared';
import {
  AppealMachine,
  DecisionMachine,
  IncidentMachine,
  SuspensionMachine,
} from '../competition-matches.state-machines';
import type { Reader } from '../competition.queries';
import { isStaffLike, organizationOf } from '../competition.shared';
import type { ActiveSuspension, SuspensionCheckPort, SuspensionScope } from '../ports';

type SuspensionRow = Selectable<SuspensionsTable>;

/**
 * Discipline (SPK-DISC-001..005): restricted incidents, decisions, suspensions and appeals, and the
 * `SUSPENSION_CHECK_IMPL` the eligibility port consults (SPK-CAP-004, SPK-AT-013). A suspension
 * states its subject, basis, scope (never assumed to span every program), period or match count,
 * approval, appeal status and completion criteria (SPK-DISC-002); it affects eligibility only
 * once approved (active), and match-count suspensions are served by published results.
 * Incident narratives are returned by the restricted views only (SPK-DISC-004).
 */
@Injectable()
export class DisciplineService implements SuspensionCheckPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  // -------------------------------------------------------------------------------------------
  // SuspensionCheckPort (SPK-AT-013)
  // -------------------------------------------------------------------------------------------
  async activeSuspensions(
    organizationId: string,
    personId: string,
    at: Date,
    scope: SuspensionScope,
    trx?: Trx,
  ): Promise<ActiveSuspension[]> {
    const db: Reader = trx ?? currentTransaction() ?? this.db;
    const rows = await db
      .selectFrom('suspensions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_person_id', '=', personId)
      .where('status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('scope', '=', 'all'),
          sql<boolean>`competition_ids @> array[${scope.competitionId}]::uuid[]`,
        ]),
      )
      .where((eb) => eb.or([eb('effective_from', 'is', null), eb('effective_from', '<=', at)]))
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
      .where((eb) =>
        eb.or([eb('match_count', 'is', null), sql<boolean>`matches_served < match_count`]),
      )
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      reason: row.basis,
      scope: row.scope === 'all' ? 'organization' : 'competition',
      until: row.effective_to ? new Date(row.effective_to).toISOString() : null,
    }));
  }

  /**
   * A published result serves one match of every active match-count suspension of the people on
   * the fixture's rosters within scope (SPK-DISC-002 completion criteria). Idempotent per fixture.
   */
  async serveFixture(
    trx: Trx,
    principal: Principal,
    input: {
      organizationId: string;
      fixtureId: string;
      competitionId: string;
      personIds: string[];
      at: Date;
      correlationId: string | null;
      operationId: string | null;
    },
  ): Promise<string[]> {
    if (input.personIds.length === 0) return [];
    const rows = await trx
      .selectFrom('suspensions')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('subject_person_id', 'in', input.personIds)
      .where('status', '=', 'active')
      .where('match_count', 'is not', null)
      .where((eb) =>
        eb.or([
          eb('scope', '=', 'all'),
          sql<boolean>`competition_ids @> array[${input.competitionId}]::uuid[]`,
        ]),
      )
      .where(sql<boolean>`not (served_fixture_ids @> array[${input.fixtureId}]::uuid[])`)
      .where((eb) =>
        eb.or([eb('effective_from', 'is', null), eb('effective_from', '<=', input.at)]),
      )
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', input.at)]))
      .forUpdate()
      .execute();
    const served: string[] = [];
    for (const row of rows) {
      const matchesServed = row.matches_served + 1;
      const complete = row.match_count !== null && matchesServed >= row.match_count;
      const nextStatus = complete ? SuspensionMachine.next(row.status, 'complete') : row.status;
      await trx
        .updateTable('suspensions')
        .set({
          matches_served: matchesServed,
          served_fixture_ids: [...row.served_fixture_ids, input.fixtureId],
          status: nextStatus,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', row.id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId: input.organizationId,
        actor: principal,
        action: MatchActions.manageDiscipline.id,
        targetType: 'suspension',
        targetId: row.id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        correlationId: input.correlationId,
        operationId: input.operationId,
        details: {
          operation: 'serve',
          fixtureId: input.fixtureId,
          matchesServed,
          status: nextStatus,
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.suspensionChanged, {
        organizationId: input.organizationId,
        aggregateType: 'suspension',
        aggregateId: row.id,
        payload: {
          suspensionId: row.id,
          subjectPersonId: row.subject_person_id,
          status: nextStatus,
          previousStatus: row.status,
          matchesServed,
          servedFixtureId: input.fixtureId,
        },
        correlationId: input.correlationId,
        operationId: input.operationId,
      });
      served.push(row.id);
    }
    return served;
  }

  // -------------------------------------------------------------------------------------------
  // Incidents (SPK-DISC-001/004/005)
  // -------------------------------------------------------------------------------------------
  async reportIncident(
    principal: Principal,
    input: CreateIncidentInput,
    correlationId: string | null,
  ): Promise<Incident> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, MatchActions.reportIncident, {
        type: 'incident',
        organizationId,
      });
      let seasonId = input.seasonId ?? null;
      let competitionId = input.competitionId ?? null;
      if (input.fixtureId) {
        const fixture = await trx
          .selectFrom('fixtures')
          .innerJoin('seasons', (join) =>
            join
              .onRef('seasons.organization_id', '=', 'fixtures.organization_id')
              .onRef('seasons.id', '=', 'fixtures.season_id'),
          )
          .select(['fixtures.id', 'fixtures.season_id', 'seasons.competition_id'])
          .where('fixtures.organization_id', '=', organizationId)
          .where('fixtures.id', '=', input.fixtureId)
          .executeTakeFirst();
        if (!fixture) throw errors.notFound('fixture', input.fixtureId);
        seasonId = fixture.season_id;
        competitionId = fixture.competition_id;
      }
      const id = newId();
      const row = await this.insertIncident(trx, principal, {
        id,
        organizationId,
        kind: input.kind,
        fixtureId: input.fixtureId ?? null,
        seasonId,
        competitionId,
        subjectPersonId: input.subjectPersonId ?? null,
        teamEntryId: input.teamEntryId ?? null,
        resultRevisionId: null,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : this.clock.now(),
        minute: input.minute ?? null,
        cardKind: input.cardKind ?? null,
        severity: input.severity,
        summary: input.summary,
        narrative: input.narrative ?? null,
        evidence: input.evidence,
        correlationId,
      });
      return toIncident(row);
    });
  }

  /** Shared with result submission (SPK-STAFF-005 "match incidents"); runs in the caller's transaction. */
  async insertIncident(
    trx: Trx,
    principal: Principal,
    input: {
      id: string;
      organizationId: string;
      kind: Incident['kind'];
      fixtureId: string | null;
      seasonId: string | null;
      competitionId: string | null;
      subjectPersonId: string | null;
      teamEntryId: string | null;
      resultRevisionId: string | null;
      occurredAt: Date;
      minute: number | null;
      cardKind: Incident['cardKind'];
      severity: Incident['severity'];
      summary: string;
      narrative: string | null;
      evidence: Incident['evidence'];
      correlationId: string | null;
    },
  ): Promise<Selectable<IncidentsTable>> {
    const row = await trx
      .insertInto('incidents')
      .values({
        id: input.id,
        organization_id: input.organizationId,
        kind: input.kind,
        fixture_id: input.fixtureId,
        season_id: input.seasonId,
        competition_id: input.competitionId,
        subject_person_id: input.subjectPersonId,
        team_entry_id: input.teamEntryId,
        result_revision_id: input.resultRevisionId,
        occurred_at: input.occurredAt,
        minute: input.minute,
        card_kind: input.cardKind,
        severity: input.severity,
        summary: input.summary,
        narrative: input.narrative,
        evidence_refs: json(input.evidence),
        reported_by: json(snapshotActor(principal)),
        reported_by_person_id: principal.personId,
        closed_at: null,
        closed_by: null,
        closure_note: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // The audit carries identifiers and the safe summary only, never the narrative (§4.14).
    await this.audit.record(trx, {
      organizationId: input.organizationId,
      actor: principal,
      action: MatchActions.reportIncident.id,
      targetType: 'incident',
      targetId: input.id,
      afterRevision: 1,
      correlationId: input.correlationId,
      details: {
        kind: input.kind,
        severity: input.severity,
        fixtureId: input.fixtureId,
        resultRevisionId: input.resultRevisionId,
      },
    });
    await this.outbox.enqueue(trx, MatchEvents.incidentReported, {
      organizationId: input.organizationId,
      aggregateType: 'incident',
      aggregateId: input.id,
      payload: {
        incidentId: input.id,
        kind: input.kind,
        severity: input.severity,
        fixtureId: input.fixtureId,
        subjectPersonId: input.subjectPersonId,
      },
      correlationId: input.correlationId,
    });
    return row;
  }

  async updateIncident(
    principal: Principal,
    id: string,
    input: UpdateIncidentInput,
    correlationId: string | null,
  ): Promise<Incident> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('incidents')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw errors.notFound('incident', id);
      await this.authorization.require(principal, MatchActions.manageDiscipline, {
        type: 'incident',
        id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const next = IncidentMachine.next(row.status, input.action);
      const now = this.clock.now();
      const updated = await trx
        .updateTable('incidents')
        .set({
          status: next,
          closed_at: next === 'closed' ? now : null,
          closed_by: next === 'closed' ? json(snapshotActor(principal)) : null,
          closure_note: next === 'closed' ? (input.closureNote ?? null) : null,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.manageDiscipline.id,
        targetType: 'incident',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: input.action, status: next },
      });
      await this.outbox.enqueue(trx, MatchEvents.incidentChanged, {
        organizationId,
        aggregateType: 'incident',
        aggregateId: id,
        payload: { incidentId: id, status: next },
        correlationId,
      });
      return toIncident(updated);
    });
  }

  async getIncident(principal: Principal, id: string): Promise<Incident> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('incidents')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('incident');
    await this.authorization.require(principal, MatchActions.readDiscipline, {
      type: 'incident',
      id,
      organizationId,
      protected: true,
    });
    return toIncident(row);
  }

  async listIncidents(principal: Principal, query: ListIncidentsQuery): Promise<Incident[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MatchActions.readDiscipline, {
      type: 'incident',
      organizationId,
    });
    let q = this.db
      .selectFrom('incidents')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('occurred_at', 'desc')
      .orderBy('id');
    if (query.fixtureId) q = q.where('fixture_id', '=', query.fixtureId);
    if (query.seasonId) q = q.where('season_id', '=', query.seasonId);
    if (query.subjectPersonId) q = q.where('subject_person_id', '=', query.subjectPersonId);
    if (query.status) q = q.where('status', '=', query.status);
    return (await q.execute()).map(toIncident);
  }

  // -------------------------------------------------------------------------------------------
  // Decisions (SPK-DISC-003)
  // -------------------------------------------------------------------------------------------
  async issueDecision(
    principal: Principal,
    input: CreateDisciplinaryDecisionInput,
    correlationId: string | null,
  ): Promise<DisciplinaryDecision> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, MatchActions.manageDiscipline, {
        type: 'disciplinary_decision',
        organizationId,
        subjectPersonIds: [input.subjectPersonId],
      });
      if (input.incidentId) {
        const incident = await trx
          .selectFrom('incidents')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.incidentId)
          .executeTakeFirst();
        if (!incident) throw errors.notFound('incident', input.incidentId);
      }
      const id = newId();
      const now = this.clock.now();
      const row = await trx
        .insertInto('disciplinary_decisions')
        .values({
          id,
          organization_id: organizationId,
          incident_id: input.incidentId ?? null,
          subject_person_id: input.subjectPersonId,
          rule_set_id: input.ruleSetId ?? null,
          basis: input.basis,
          decision: input.decision,
          details: json(input.details ?? {}),
          decided_by: json(snapshotActor(principal)),
          decided_by_person_id: principal.personId,
          decided_at: now,
          overturned_at: null,
          overturned_by: null,
          overturn_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      let suspensionId: string | null = null;
      if (input.suspension) {
        const suspension = await this.insertSuspension(trx, principal, {
          organizationId,
          subjectPersonId: input.subjectPersonId,
          decisionId: id,
          basis: input.basis,
          terms: input.suspension,
          correlationId,
        });
        suspensionId = suspension.id;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.manageDiscipline.id,
        targetType: 'disciplinary_decision',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'issue',
          decision: input.decision,
          incidentId: input.incidentId ?? null,
          suspensionId,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.disciplinaryDecisionIssued, {
        organizationId,
        aggregateType: 'disciplinary_decision',
        aggregateId: id,
        payload: {
          decisionId: id,
          subjectPersonId: input.subjectPersonId,
          decision: input.decision,
          suspensionId,
        },
        correlationId,
      });
      return toDecision(row, suspensionId);
    });
  }

  async overturnDecision(
    principal: Principal,
    id: string,
    input: OverturnDecisionInput,
    correlationId: string | null,
  ): Promise<DisciplinaryDecision> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('disciplinary_decisions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw errors.notFound('disciplinary_decision', id);
      await this.authorization.require(principal, MatchActions.manageDiscipline, {
        type: 'disciplinary_decision',
        id,
        organizationId,
        subjectPersonIds: [row.subject_person_id],
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const updated = await this.overturnDecisionRow(
        trx,
        principal,
        row,
        input.reason,
        correlationId,
      );
      const suspension = await trx
        .selectFrom('suspensions')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('decision_id', '=', id)
        .executeTakeFirst();
      return toDecision(updated, suspension?.id ?? null);
    });
  }

  private async overturnDecisionRow(
    trx: Trx,
    principal: Principal,
    row: Selectable<DisciplinaryDecisionsTable>,
    reason: string,
    correlationId: string | null,
  ): Promise<Selectable<DisciplinaryDecisionsTable>> {
    const next = DecisionMachine.next(row.status, 'overturn');
    const now = this.clock.now();
    const updated = await trx
      .updateTable('disciplinary_decisions')
      .set({
        status: next,
        overturned_at: now,
        overturned_by: json(snapshotActor(principal)),
        overturn_reason: reason,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    // Overturning the decision ends every suspension it created (history kept, SPK-DISC-003).
    const suspensions = await trx
      .selectFrom('suspensions')
      .selectAll()
      .where('organization_id', '=', row.organization_id)
      .where('decision_id', '=', row.id)
      .where('status', 'in', ['proposed', 'active'])
      .forUpdate()
      .execute();
    for (const suspension of suspensions) {
      await this.overturnSuspensionRow(trx, principal, suspension, reason, correlationId);
    }
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: principal,
      action: MatchActions.manageDiscipline.id,
      targetType: 'disciplinary_decision',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: updated.revision,
      reason,
      correlationId,
      details: { operation: 'overturn', suspensionIds: suspensions.map((s) => s.id) },
    });
    await this.outbox.enqueue(trx, MatchEvents.disciplinaryDecisionOverturned, {
      organizationId: row.organization_id,
      aggregateType: 'disciplinary_decision',
      aggregateId: row.id,
      payload: { decisionId: row.id, subjectPersonId: row.subject_person_id },
      correlationId,
    });
    return updated;
  }

  async getDecision(principal: Principal, id: string): Promise<DisciplinaryDecision> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('disciplinary_decisions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('disciplinary_decision');
    await this.authorizeSubjectRead(principal, 'disciplinary_decision', id, row.subject_person_id);
    const suspension = await this.db
      .selectFrom('suspensions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('decision_id', '=', id)
      .executeTakeFirst();
    return toDecision(row, suspension?.id ?? null);
  }

  // -------------------------------------------------------------------------------------------
  // Suspensions (SPK-DISC-002)
  // -------------------------------------------------------------------------------------------
  async createSuspension(
    principal: Principal,
    input: CreateSuspensionInput,
    correlationId: string | null,
  ): Promise<Suspension> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, MatchActions.manageDiscipline, {
        type: 'suspension',
        organizationId,
        subjectPersonIds: [input.subjectPersonId],
      });
      if (input.decisionId) {
        const decision = await trx
          .selectFrom('disciplinary_decisions')
          .select(['id', 'subject_person_id'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.decisionId)
          .executeTakeFirst();
        if (!decision || decision.subject_person_id !== input.subjectPersonId) {
          throw errors.notFound('disciplinary_decision', input.decisionId);
        }
      }
      const row = await this.insertSuspension(trx, principal, {
        organizationId,
        subjectPersonId: input.subjectPersonId,
        decisionId: input.decisionId ?? null,
        basis: input.basis,
        terms: input.terms,
        correlationId,
        reason: input.reason ?? null,
      });
      return toSuspension(row);
    });
  }

  private async insertSuspension(
    trx: Trx,
    principal: Principal,
    input: {
      organizationId: string;
      subjectPersonId: string;
      decisionId: string | null;
      basis: string;
      terms: SuspensionTerms;
      correlationId: string | null;
      reason?: string | null;
    },
  ): Promise<SuspensionRow> {
    for (const competitionId of input.terms.competitionIds) {
      const competition = await trx
        .selectFrom('competitions')
        .select('id')
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', competitionId)
        .executeTakeFirst();
      if (!competition) throw errors.notFound('competition', competitionId);
    }
    const id = newId();
    const row = await trx
      .insertInto('suspensions')
      .values({
        id,
        organization_id: input.organizationId,
        subject_person_id: input.subjectPersonId,
        decision_id: input.decisionId,
        basis: input.basis,
        scope: input.terms.scope,
        competition_ids: input.terms.scope === 'competitions' ? input.terms.competitionIds : [],
        effective_from: input.terms.effectiveFrom ?? null,
        effective_to: input.terms.effectiveTo ?? null,
        match_count: input.terms.matchCount ?? null,
        completion_criteria: input.terms.completionCriteria,
        approved_by: null,
        approved_at: null,
        overturned_at: null,
        overturned_by: null,
        overturn_reason: null,
        created_by: json(snapshotActor(principal)),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId: input.organizationId,
      actor: principal,
      action: MatchActions.manageDiscipline.id,
      targetType: 'suspension',
      targetId: id,
      afterRevision: 1,
      reason: input.reason ?? null,
      correlationId: input.correlationId,
      details: {
        operation: 'propose',
        decisionId: input.decisionId,
        scope: input.terms.scope,
        matchCount: input.terms.matchCount ?? null,
      },
    });
    await this.outbox.enqueue(trx, MatchEvents.suspensionChanged, {
      organizationId: input.organizationId,
      aggregateType: 'suspension',
      aggregateId: id,
      payload: {
        suspensionId: id,
        subjectPersonId: input.subjectPersonId,
        status: 'proposed',
        previousStatus: null,
        matchesServed: 0,
        servedFixtureId: null,
      },
      correlationId: input.correlationId,
    });
    return row;
  }

  async updateSuspension(
    principal: Principal,
    id: string,
    input: UpdateSuspensionInput,
    correlationId: string | null,
  ): Promise<Suspension> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadSuspension(trx, organizationId, id, { forUpdate: true });
      if (!row) throw errors.notFound('suspension', id);
      await this.authorization.require(principal, MatchActions.manageDiscipline, {
        type: 'suspension',
        id,
        organizationId,
        subjectPersonIds: [row.subject_person_id],
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (input.action === 'overturn') {
        const updated = await this.overturnSuspensionRow(
          trx,
          principal,
          row,
          input.reason ?? '',
          correlationId,
        );
        return toSuspension(updated);
      }
      const next = SuspensionMachine.next(row.status, 'approve');
      const now = this.clock.now();
      const updated = await trx
        .updateTable('suspensions')
        .set({
          status: next,
          approved_by: json(snapshotActor(principal)),
          approved_at: now,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.manageDiscipline.id,
        targetType: 'suspension',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'approve', status: next },
      });
      await this.outbox.enqueue(trx, MatchEvents.suspensionChanged, {
        organizationId,
        aggregateType: 'suspension',
        aggregateId: id,
        payload: {
          suspensionId: id,
          subjectPersonId: row.subject_person_id,
          status: next,
          previousStatus: row.status,
          matchesServed: row.matches_served,
          servedFixtureId: null,
        },
        correlationId,
      });
      return toSuspension(updated);
    });
  }

  private async overturnSuspensionRow(
    trx: Trx,
    principal: Principal,
    row: SuspensionRow,
    reason: string,
    correlationId: string | null,
  ): Promise<SuspensionRow> {
    const next = SuspensionMachine.next(row.status, 'overturn');
    const now = this.clock.now();
    const updated = await trx
      .updateTable('suspensions')
      .set({
        status: next,
        overturned_at: now,
        overturned_by: json(snapshotActor(principal)),
        overturn_reason: reason,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: principal,
      action: MatchActions.manageDiscipline.id,
      targetType: 'suspension',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: updated.revision,
      reason,
      correlationId,
      details: { operation: 'overturn', previousStatus: row.status },
    });
    await this.outbox.enqueue(trx, MatchEvents.suspensionChanged, {
      organizationId: row.organization_id,
      aggregateType: 'suspension',
      aggregateId: row.id,
      payload: {
        suspensionId: row.id,
        subjectPersonId: row.subject_person_id,
        status: next,
        previousStatus: row.status,
        matchesServed: row.matches_served,
        servedFixtureId: null,
      },
      correlationId,
    });
    return updated;
  }

  async getSuspension(principal: Principal, id: string): Promise<Suspension> {
    const organizationId = organizationOf(principal);
    const row = await this.loadSuspension(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('suspension');
    await this.authorizeSubjectRead(principal, 'suspension', id, row.subject_person_id);
    return toSuspension(row);
  }

  async listSuspensions(principal: Principal, query: ListSuspensionsQuery): Promise<Suspension[]> {
    const organizationId = organizationOf(principal);
    if (isStaffLike(principal)) {
      await this.authorization.require(principal, MatchActions.readDiscipline, {
        type: 'suspension',
        organizationId,
      });
    } else {
      // A customer lists suspensions about one person they have authority over (self or child with view).
      if (!query.subjectPersonId) throw errors.validation('subjectPersonId is required.');
      await this.authorization.require(principal, MatchActions.readOwnDiscipline, {
        type: 'suspension',
        organizationId,
        subjectPersonIds: [query.subjectPersonId],
        protected: true,
      });
    }
    let q = this.db
      .selectFrom('suspensions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id');
    if (query.subjectPersonId) q = q.where('subject_person_id', '=', query.subjectPersonId);
    if (query.status) q = q.where('status', '=', query.status);
    return (await q.execute()).map(toSuspension);
  }

  // -------------------------------------------------------------------------------------------
  // Appeals
  // -------------------------------------------------------------------------------------------
  async createAppeal(
    principal: Principal,
    input: CreateAppealInput,
    correlationId: string | null,
  ): Promise<Appeal> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      let subjectPersonId: string | null = input.subjectPersonId ?? null;
      if (input.decisionId) {
        const decision = await trx
          .selectFrom('disciplinary_decisions')
          .select(['id', 'subject_person_id', 'status'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.decisionId)
          .executeTakeFirst();
        if (!decision) throw errors.protectedNotFound('disciplinary_decision');
        subjectPersonId = decision.subject_person_id;
      } else if (input.suspensionId) {
        const suspension = await this.loadSuspension(trx, organizationId, input.suspensionId, {
          forUpdate: true,
        });
        if (!suspension) throw errors.protectedNotFound('suspension');
        subjectPersonId = suspension.subject_person_id;
      } else if (input.disputeId) {
        const dispute = await trx
          .selectFrom('disputes')
          .innerJoin('fixtures', (join) =>
            join
              .onRef('fixtures.organization_id', '=', 'disputes.organization_id')
              .onRef('fixtures.id', '=', 'disputes.fixture_id'),
          )
          .select([
            'disputes.id',
            'disputes.submitted_by_person_id',
            'disputes.status',
            'fixtures.home_entry_id',
            'fixtures.away_entry_id',
          ])
          .where('disputes.organization_id', '=', organizationId)
          .where('disputes.id', '=', input.disputeId)
          .executeTakeFirst();
        if (!dispute) throw errors.protectedNotFound('dispute');
        if (!isStaffLike(principal)) {
          // A dispute outcome is appealed by its submitter or by a captain of a competing entry.
          const isSubmitter =
            principal.personId !== null && dispute.submitted_by_person_id === principal.personId;
          let isCaptain = false;
          for (const entryId of [dispute.home_entry_id, dispute.away_entry_id]) {
            if (!entryId || isCaptain) continue;
            const decision = await this.authorization.decide(
              principal,
              MatchActions.submitDispute,
              {
                type: 'dispute',
                id: dispute.id,
                organizationId,
                teamEntryId: entryId,
                protected: true,
              },
            );
            isCaptain = decision.allowed;
          }
          if (!isSubmitter && !isCaptain) throw errors.protectedNotFound('dispute');
        }
        if (dispute.status !== 'decided') {
          throw errors.invalidTransition('Dispute', dispute.status, 'appeal');
        }
        subjectPersonId ??= principal.personId ?? dispute.submitted_by_person_id;
      }
      if (!subjectPersonId) throw errors.validation('subjectPersonId is required for this appeal.');
      await this.authorization.require(principal, MatchActions.submitAppeal, {
        type: 'appeal',
        organizationId,
        subjectPersonIds: [subjectPersonId],
        protected: !isStaffLike(principal),
      });
      // Early feedback; the partial unique indexes remain the guarantee (one open appeal per target).
      const open = await trx
        .selectFrom('appeals')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('status', 'in', ['submitted', 'under_review'])
        .where((eb) =>
          eb.or([
            ...(input.decisionId ? [eb('decision_id', '=', input.decisionId)] : []),
            ...(input.suspensionId ? [eb('suspension_id', '=', input.suspensionId)] : []),
            ...(input.disputeId ? [eb('dispute_id', '=', input.disputeId)] : []),
          ]),
        )
        .executeTakeFirst();
      if (open) {
        throw errors.resourceConflict('An appeal is already open for this record.', {
          appealId: open.id,
        });
      }
      const id = newId();
      const now = this.clock.now();
      const row = await trx
        .insertInto('appeals')
        .values({
          id,
          organization_id: organizationId,
          subject_person_id: subjectPersonId,
          decision_id: input.decisionId ?? null,
          suspension_id: input.suspensionId ?? null,
          dispute_id: input.disputeId ?? null,
          grounds: input.grounds,
          evidence_refs: json(input.evidence),
          submitted_by: json(snapshotActor(principal)),
          submitted_by_person_id: principal.personId,
          submitted_at: now,
          reviewer: null,
          reviewer_person_id: null,
          decided_at: null,
          decision_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (input.suspensionId) {
        await trx
          .updateTable('suspensions')
          .set({ appeal_status: 'pending', revision: sql`revision + 1` })
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.suspensionId)
          .execute();
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.submitAppeal.id,
        targetType: 'appeal',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          decisionId: input.decisionId ?? null,
          suspensionId: input.suspensionId ?? null,
          disputeId: input.disputeId ?? null,
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.appealSubmitted, {
        organizationId,
        aggregateType: 'appeal',
        aggregateId: id,
        payload: {
          appealId: id,
          subjectPersonId,
          decisionId: input.decisionId ?? null,
          suspensionId: input.suspensionId ?? null,
          disputeId: input.disputeId ?? null,
        },
        correlationId,
      });
      return toAppeal(row);
    });
  }

  async decideAppeal(
    principal: Principal,
    id: string,
    input: DecideAppealInput,
    correlationId: string | null,
  ): Promise<Appeal> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('appeals')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw errors.notFound('appeal', id);
      await this.authorization.require(principal, MatchActions.manageDiscipline, {
        type: 'appeal',
        id,
        organizationId,
        subjectPersonIds: [row.subject_person_id],
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const next = AppealMachine.next(row.status, input.action);
      const now = this.clock.now();
      const decided = next === 'granted' || next === 'denied';
      const updated = await trx
        .updateTable('appeals')
        .set({
          status: next,
          reviewer: json(snapshotActor(principal)),
          reviewer_person_id: principal.personId,
          decided_at: decided ? now : null,
          decision_reason: decided ? (input.reason ?? null) : null,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      // A granted appeal overturns what it appealed; a denied one records the outcome on it.
      if (row.suspension_id && decided) {
        const suspension = await this.loadSuspension(trx, organizationId, row.suspension_id, {
          forUpdate: true,
        });
        if (suspension) {
          if (next === 'granted' && SuspensionMachine.can(suspension.status, 'overturn')) {
            const overturned = await this.overturnSuspensionRow(
              trx,
              principal,
              suspension,
              `Appeal ${id} granted: ${input.reason ?? ''}`,
              correlationId,
            );
            await trx
              .updateTable('suspensions')
              .set({ appeal_status: 'granted', revision: overturned.revision + 1 })
              .where('organization_id', '=', organizationId)
              .where('id', '=', suspension.id)
              .where('revision', '=', overturned.revision)
              .execute();
          } else {
            await trx
              .updateTable('suspensions')
              .set({
                appeal_status: next === 'granted' ? 'granted' : 'denied',
                revision: suspension.revision + 1,
              })
              .where('organization_id', '=', organizationId)
              .where('id', '=', suspension.id)
              .where('revision', '=', suspension.revision)
              .execute();
          }
        }
      }
      if (row.decision_id && next === 'granted') {
        const decision = await trx
          .selectFrom('disciplinary_decisions')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', row.decision_id)
          .forUpdate()
          .executeTakeFirst();
        if (decision && DecisionMachine.can(decision.status, 'overturn')) {
          await this.overturnDecisionRow(
            trx,
            principal,
            decision,
            `Appeal ${id} granted: ${input.reason ?? ''}`,
            correlationId,
          );
        }
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.manageDiscipline.id,
        targetType: 'appeal',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: input.action, status: next },
      });
      await this.outbox.enqueue(trx, MatchEvents.appealChanged, {
        organizationId,
        aggregateType: 'appeal',
        aggregateId: id,
        payload: { appealId: id, subjectPersonId: row.subject_person_id, status: next },
        correlationId,
      });
      return toAppeal(updated);
    });
  }

  async getAppeal(principal: Principal, id: string): Promise<Appeal> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('appeals')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('appeal');
    await this.authorizeSubjectRead(principal, 'appeal', id, row.subject_person_id);
    return toAppeal(row);
  }

  /** The dispute's open appeal state, for the dispute view. */
  async appealStatusOfDispute(
    db: Reader,
    organizationId: string,
    disputeId: string,
  ): Promise<Appeal['status'] | null> {
    const row = await db
      .selectFrom('appeals')
      .select('status')
      .where('organization_id', '=', organizationId)
      .where('dispute_id', '=', disputeId)
      .orderBy('submitted_at', 'desc')
      .executeTakeFirst();
    return row?.status ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  private async loadSuspension(
    db: Reader,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<SuspensionRow | null> {
    let q = db
      .selectFrom('suspensions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (options.forUpdate) q = q.forUpdate();
    return (await q.executeTakeFirst()) ?? null;
  }

  /** League management reads everything; the subject (or a guardian with view) reads records about them; others NOT_FOUND. */
  private async authorizeSubjectRead(
    principal: Principal,
    type: string,
    id: string,
    subjectPersonId: string,
  ): Promise<void> {
    const organizationId = organizationOf(principal);
    if (isStaffLike(principal)) {
      await this.authorization.require(principal, MatchActions.readDiscipline, {
        type,
        id,
        organizationId,
        protected: true,
      });
      return;
    }
    await this.authorization.require(principal, MatchActions.readOwnDiscipline, {
      type,
      id,
      organizationId,
      subjectPersonIds: [subjectPersonId],
      protected: true,
    });
  }
}
