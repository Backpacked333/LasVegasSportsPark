import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type Appeal,
  type CreateAppealInput,
  type CreateDisciplinaryDecisionInput,
  type CreateIncidentInput,
  type CreateSuspensionInput,
  type DecideAppealInput,
  type DisciplinaryDecision,
  type Incident,
  type ListAppealsQuery,
  type ListDisciplinaryDecisionsQuery,
  type ListIncidentsQuery,
  type ListSuspensionsQuery,
  type Page,
  type OverturnDecisionInput,
  type Principal,
  type ResultCard,
  type RuleSetContent,
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
import { sql, type Selectable, type SqlBool } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  currentTransaction,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { MatchActions } from '../competition-matches.actions';
import { MatchEvents } from '../competition-matches.events';
import { ASSIGNMENT_CHECK_PORT, type AssignmentCheckPort } from '../competition-matches.ports';
import { toAppeal, toDecision, toIncident, toSuspension } from '../competition-matches.shared';
import {
  AppealMachine,
  DecisionMachine,
  IncidentMachine,
  SuspensionMachine,
} from '../competition-matches.state-machines';
import type { Reader } from '../competition.queries';
import { isStaffLike, iso, organizationOf } from '../competition.shared';
import {
  CARD_REMOVED_OVERTURN_REASON,
  DISCIPLINE_MANAGER_ROLES,
  SUSPENSION_CARD_REMOVED,
} from '../competition-matches.policy';
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
    @Inject(ASSIGNMENT_CHECK_PORT) private readonly assignments: AssignmentCheckPort,
    @Inject(PERSON_DIRECTORY_PORT) private readonly directory: PersonDirectoryPort,
    private readonly exceptions: OperationalExceptions,
  ) {}

  /**
   * CMP-08 (SPK-IAM-007, IF-09): the ids a person's discipline is recorded under, the person and
   * everyone merged into them, so a suspension recorded against a merged person binds the survivor.
   */
  private async idsOf(organizationId: string, personId: string, trx?: Trx): Promise<string[]> {
    const ids = await this.directory.personIdsResolvingTo(organizationId, personId, trx);
    return ids.length > 0 ? [...new Set([personId, ...ids])] : [personId];
  }

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
    const subjectIds = await this.idsOf(organizationId, personId, trx);
    const rows = await db
      .selectFrom('suspensions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_person_id', 'in', subjectIds)
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
   * A published result of a match that took place serves one match of every active match-count
   * suspension, approved before kickoff, of the people on the fixture's rosters within scope
   * (SPK-DISC-002 completion criteria). Idempotent per fixture (`served_fixture_ids`).
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
      // A match played before the suspension was approved does not serve it.
      .where('approved_at', '<=', input.at)
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

  /**
   * SPK-DISC-003 "discipline may affect event eligibility only through the approved rule set": the
   * cards of a newly official result propose (never activate) the suspensions the season's
   * rule-set version prescribes. A sending-off (red, or a second yellow when the rule set treats it
   * as red) proposes `redCardSuspensionMatches`; reaching a multiple of
   * `yellowAccumulationThreshold` yellow cards in the season proposes
   * `yellowAccumulationSuspensionMatches`, once per threshold crossing in the season (the
   * crossings reached are compared with the accumulation proposals the season already holds, so a
   * correction of an earlier fixture never proposes a crossing again). Each proposal names the
   * fixture and result revision it came from and exists at most once per person, fixture and rule
   * (partial unique index), so a replay or a re-published correction never duplicates it. A league
   * manager approves or overturns it with history (authorized review). Scope: the competition the
   * card was shown in (proposed default, DEC-010 pending).
   */
  async proposeFromRuleSet(
    trx: Trx,
    principal: Principal,
    input: {
      organizationId: string;
      fixtureId: string;
      resultRevisionId: string;
      seasonId: string;
      competitionId: string;
      ruleSet: { id: string; name: string; version: number; cards: RuleSetContent['cards'] };
      resultCards: ResultCard[];
      correlationId: string | null;
      operationId: string | null;
    },
  ): Promise<string[]> {
    const rules = input.ruleSet.cards;
    const label = `${input.ruleSet.name} v${input.ruleSet.version}`;
    const proposals: Array<{
      personId: string;
      kind: 'red_card' | 'yellow_accumulation';
      matches: number;
      basis: string;
    }> = [];
    const sentOff = new Set<string>();
    for (const card of input.resultCards) {
      if (card.kind === 'red' || (card.kind === 'second_yellow' && rules.secondYellowIsRed)) {
        sentOff.add(card.personId);
      }
    }
    if (rules.redCardSuspensionMatches > 0) {
      for (const personId of sentOff) {
        proposals.push({
          personId,
          kind: 'red_card',
          matches: rules.redCardSuspensionMatches,
          basis: `Sent off in fixture ${input.fixtureId}: rule set ${label} prescribes ${rules.redCardSuspensionMatches} match(es).`,
        });
      }
    }
    const threshold = rules.yellowAccumulationThreshold;
    const countsAsYellow = (card: ResultCard) =>
      card.kind === 'yellow' || (card.kind === 'second_yellow' && !rules.secondYellowIsRed);
    const here = new Map<string, number>();
    for (const card of input.resultCards) {
      if (countsAsYellow(card)) here.set(card.personId, (here.get(card.personId) ?? 0) + 1);
    }
    if (threshold !== null && rules.yellowAccumulationSuspensionMatches > 0 && here.size > 0) {
      // Official results of the season, this one included (it is official in this transaction).
      const official = await trx
        .selectFrom('result_revisions as r')
        .innerJoin('fixtures as f', (join) =>
          join
            .onRef('f.organization_id', '=', 'r.organization_id')
            .onRef('f.id', '=', 'r.fixture_id'),
        )
        .select(['r.details'])
        .where('r.organization_id', '=', input.organizationId)
        .where('f.season_id', '=', input.seasonId)
        .where('r.status', '=', 'official')
        .execute();
      const totals = new Map<string, number>();
      for (const row of official) {
        const cards = ((row.details as { cards?: ResultCard[] }).cards ?? []).filter(
          countsAsYellow,
        );
        for (const card of cards) {
          totals.set(card.personId, (totals.get(card.personId) ?? 0) + 1);
        }
      }
      // One proposal per threshold crossing in the season: a correction re-runs this with the
      // fixture's whole card list, so the crossings the season's official results reach are
      // compared with the accumulation proposals the season already holds for the person, from
      // whichever fixture (overturned ones included: a crossing already decided on is not
      // proposed again) (SPK-DISC-003, SPK-RESULT-004).
      const proposedBefore = await trx
        .selectFrom('suspensions as s')
        .innerJoin('fixtures as sf', (join) =>
          join
            .onRef('sf.organization_id', '=', 's.organization_id')
            .onRef('sf.id', '=', 's.source_fixture_id'),
        )
        .select((eb) => ['s.subject_person_id', eb.fn.countAll<string>().as('n')])
        .where('s.organization_id', '=', input.organizationId)
        .where('sf.season_id', '=', input.seasonId)
        .where('s.source_kind', '=', 'yellow_accumulation')
        .where('s.subject_person_id', 'in', [...here.keys()])
        .groupBy('s.subject_person_id')
        .execute();
      const alreadyProposed = new Map(
        proposedBefore.map((row) => [row.subject_person_id, Number(row.n)]),
      );
      for (const [personId, count] of here) {
        const total = totals.get(personId) ?? count;
        if (Math.floor(total / threshold) > (alreadyProposed.get(personId) ?? 0)) {
          proposals.push({
            personId,
            kind: 'yellow_accumulation',
            matches: rules.yellowAccumulationSuspensionMatches,
            basis: `${total} yellow card(s) this season reached the accumulation threshold of ${threshold}: rule set ${label} prescribes ${rules.yellowAccumulationSuspensionMatches} match(es).`,
          });
        }
      }
    }
    const created: string[] = [];
    for (const proposal of proposals) {
      const id = newId();
      const inserted = await trx
        .insertInto('suspensions')
        .values({
          id,
          organization_id: input.organizationId,
          subject_person_id: proposal.personId,
          decision_id: null,
          basis: proposal.basis,
          scope: 'competitions',
          competition_ids: [input.competitionId],
          effective_from: null,
          effective_to: null,
          match_count: proposal.matches,
          completion_criteria: `${proposal.matches} match(es) of the subject's team in the competition, played after approval, are served.`,
          source_kind: proposal.kind,
          source_fixture_id: input.fixtureId,
          source_result_revision_id: input.resultRevisionId,
          approved_by: null,
          approved_at: null,
          overturned_at: null,
          overturned_by: null,
          overturn_reason: null,
          created_by: json(snapshotActor(principal)),
        })
        .onConflict((oc) =>
          oc
            .columns(['organization_id', 'subject_person_id', 'source_fixture_id', 'source_kind'])
            .where(sql<SqlBool>`source_kind <> 'manual'`)
            .doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (!inserted) continue;
      created.push(id);
      await this.audit.record(trx, {
        organizationId: input.organizationId,
        actor: principal,
        action: MatchActions.manageDiscipline.id,
        targetType: 'suspension',
        targetId: id,
        afterRevision: 1,
        correlationId: input.correlationId,
        operationId: input.operationId,
        details: {
          operation: 'propose_from_rule_set',
          sourceKind: proposal.kind,
          fixtureId: input.fixtureId,
          resultRevisionId: input.resultRevisionId,
          ruleSetId: input.ruleSet.id,
          matchCount: proposal.matches,
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.suspensionChanged, {
        organizationId: input.organizationId,
        aggregateType: 'suspension',
        aggregateId: id,
        payload: {
          suspensionId: id,
          subjectPersonId: proposal.personId,
          status: 'proposed',
          previousStatus: null,
          matchesServed: 0,
          servedFixtureId: null,
        },
        correlationId: input.correlationId,
        operationId: input.operationId,
      });
    }
    return created;
  }

  /**
   * CMP-12 (SPK-DISC-001, SPK-RESULT-004): after an official correction of a fixture, the
   * rule-set suspensions proposed from that fixture whose card is gone are followed up in the same
   * transaction. A sending-off suspension whose person is no longer sent off, or an accumulation
   * suspension the season's yellow cards no longer reach, is overturned while `proposed`
   * (SuspensionMachine 'overturn', reason "card removed by correction"); an `active` one is never
   * lifted silently: it raises competition.suspension_card_removed for the league manager, once.
   */
  async reconcileRemovedCards(
    trx: Trx,
    principal: Principal,
    input: {
      organizationId: string;
      fixtureId: string;
      seasonId: string;
      cards: RuleSetContent['cards'];
      resultCards: ResultCard[];
      correlationId: string | null;
      operationId: string | null;
    },
  ): Promise<{ overturned: string[]; flagged: string[] }> {
    const rules = input.cards;
    const rows = await trx
      .selectFrom('suspensions')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('source_fixture_id', '=', input.fixtureId)
      .where('source_kind', 'in', ['red_card', 'yellow_accumulation'])
      .where('status', 'in', ['proposed', 'active'])
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .execute();
    if (rows.length === 0) return { overturned: [], flagged: [] };
    const sentOff = new Set(
      input.resultCards
        .filter((c) => c.kind === 'red' || (c.kind === 'second_yellow' && rules.secondYellowIsRed))
        .map((c) => c.personId),
    );
    const removed: SuspensionRow[] = [];
    for (const row of rows) {
      if (row.source_kind === 'red_card') {
        if (!sentOff.has(row.subject_person_id)) removed.push(row);
        continue;
      }
      if (await this.accumulationGone(trx, input, row)) removed.push(row);
    }
    const overturned: string[] = [];
    const flagged: string[] = [];
    for (const row of removed) {
      if (row.status === 'proposed') {
        await this.overturnSuspensionRow(
          trx,
          principal,
          row,
          CARD_REMOVED_OVERTURN_REASON,
          input.correlationId,
        );
        overturned.push(row.id);
        continue;
      }
      await this.exceptions.raise(trx, {
        organizationId: input.organizationId,
        category: SUSPENSION_CARD_REMOVED.category,
        severity: SUSPENSION_CARD_REMOVED.severity,
        title: 'A correction removed the card an active suspension rests on',
        affectedType: 'suspension',
        affectedId: row.id,
        ownerQueue: SUSPENSION_CARD_REMOVED.ownerQueue,
        dedupeKey: `suspension_card_removed:${row.id}`,
        details: {
          suspensionId: row.id,
          fixtureId: input.fixtureId,
          sourceKind: row.source_kind,
          subjectPersonId: row.subject_person_id,
        },
      });
      flagged.push(row.id);
    }
    return { overturned, flagged };
  }

  /**
   * Whether an accumulation suspension sourced from the corrected fixture lost its basis: the
   * season's official yellow cards of the person now reach fewer threshold crossings than the
   * accumulation suspensions still standing for them (newest first gives way).
   */
  private async accumulationGone(
    trx: Trx,
    input: { organizationId: string; seasonId: string; cards: RuleSetContent['cards'] },
    row: SuspensionRow,
  ): Promise<boolean> {
    const rules = input.cards;
    const threshold = rules.yellowAccumulationThreshold;
    if (threshold === null) return true;
    const countsAsYellow = (card: ResultCard) =>
      card.kind === 'yellow' || (card.kind === 'second_yellow' && !rules.secondYellowIsRed);
    const official = await trx
      .selectFrom('result_revisions as r')
      .innerJoin('fixtures as f', (join) =>
        join
          .onRef('f.organization_id', '=', 'r.organization_id')
          .onRef('f.id', '=', 'r.fixture_id'),
      )
      .select(['r.details'])
      .where('r.organization_id', '=', input.organizationId)
      .where('f.season_id', '=', input.seasonId)
      .where('r.status', '=', 'official')
      .execute();
    let total = 0;
    for (const result of official) {
      for (const card of (result.details as { cards?: ResultCard[] }).cards ?? []) {
        if (card.personId === row.subject_person_id && countsAsYellow(card)) total += 1;
      }
    }
    const crossings = Math.floor(total / threshold);
    const standing = await trx
      .selectFrom('suspensions as s')
      .innerJoin('fixtures as sf', (join) =>
        join
          .onRef('sf.organization_id', '=', 's.organization_id')
          .onRef('sf.id', '=', 's.source_fixture_id'),
      )
      .select(['s.id'])
      .where('s.organization_id', '=', input.organizationId)
      .where('sf.season_id', '=', input.seasonId)
      .where('s.source_kind', '=', 'yellow_accumulation')
      .where('s.subject_person_id', '=', row.subject_person_id)
      .where('s.status', '<>', 'overturned')
      .orderBy('s.created_at', 'desc')
      .orderBy('s.id', 'desc')
      .execute();
    const excess = standing.length - crossings;
    if (excess <= 0) return false;
    return standing.slice(0, excess).some((s) => s.id === row.id);
  }

  // -------------------------------------------------------------------------------------------
  // Staff lists (CMP-05; SPK-DISC-003/005): keyset created_at desc, id desc
  // -------------------------------------------------------------------------------------------
  async listDecisions(
    principal: Principal,
    query: ListDisciplinaryDecisionsQuery,
  ): Promise<Page<DisciplinaryDecision>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MatchActions.readDiscipline, {
      type: 'disciplinary_decision',
      organizationId,
    });
    const cursor = decodeCursor(query.cursor, ListCursor);
    if (query.cursor && !cursor) throw errors.validation('The cursor is not valid.');
    let q = this.db
      .selectFrom('disciplinary_decisions as d')
      .selectAll('d')
      .where('d.organization_id', '=', organizationId);
    if (query.personId) q = q.where('d.subject_person_id', '=', query.personId);
    if (query.status) q = q.where('d.status', '=', query.status);
    if (query.competitionId) {
      const competitionId = query.competitionId;
      q = q.where(({ or, exists, selectFrom }) =>
        or([
          exists(
            selectFrom('incidents as i')
              .select('i.id')
              .whereRef('i.organization_id', '=', 'd.organization_id')
              .whereRef('i.id', '=', 'd.incident_id')
              .where('i.competition_id', '=', competitionId),
          ),
          exists(
            selectFrom('suspensions as s')
              .select('s.id')
              .whereRef('s.organization_id', '=', 'd.organization_id')
              .whereRef('s.decision_id', '=', 'd.id')
              .where(sql<boolean>`s.competition_ids @> array[${competitionId}]::uuid[]`),
          ),
        ]),
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
    const suspensions =
      page.length === 0
        ? []
        : await this.db
            .selectFrom('suspensions')
            .select(['id', 'decision_id'])
            .where('organization_id', '=', organizationId)
            .where(
              'decision_id',
              'in',
              page.map((r) => r.id),
            )
            .execute();
    const byDecision = new Map(suspensions.map((r) => [r.decision_id, r.id]));
    return {
      items: page.map((row) => toDecision(row, byDecision.get(row.id) ?? null)),
      nextCursor: nextCursorOf(rows, page, query.limit),
    };
  }

  async listAppeals(principal: Principal, query: ListAppealsQuery): Promise<Page<Appeal>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MatchActions.readDiscipline, {
      type: 'appeal',
      organizationId,
    });
    const cursor = decodeCursor(query.cursor, ListCursor);
    if (query.cursor && !cursor) throw errors.validation('The cursor is not valid.');
    let q = this.db.selectFrom('appeals').selectAll().where('organization_id', '=', organizationId);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.decisionId) q = q.where('decision_id', '=', query.decisionId);
    if (cursor) {
      const at = new Date(cursor.at);
      q = q.where((eb) =>
        eb.or([
          eb('created_at', '<', at),
          eb.and([eb('created_at', '=', at), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    return { items: page.map(toAppeal), nextCursor: nextCursorOf(rows, page, query.limit) };
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
      // SPK-STAFF-005: an official reports incidents of a fixture they hold an accepted
      // assignment for (proposed assignments do not count); league management reports any.
      if (
        principal.kind === 'staff' &&
        !principal.staffRoles.some((r) => DISCIPLINE_MANAGER_ROLES.includes(r))
      ) {
        const assigned =
          input.fixtureId !== undefined &&
          principal.personId !== null &&
          (await this.assignments.isAcceptedOfficial(
            organizationId,
            input.fixtureId,
            principal.personId,
            trx,
          ));
        if (!assigned) {
          throw errors.accessDenied(
            'An official reports incidents only for a fixture they are assigned to and have accepted.',
            { action: MatchActions.reportIncident.id, fixtureId: input.fixtureId ?? null },
          );
        }
      }
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
        source_kind: 'manual',
        source_fixture_id: null,
        source_result_revision_id: null,
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
      // SPK-DISC-002 "appeal status": the appealed suspension, or every live suspension the
      // appealed decision created, shows the pending appeal.
      await this.setAppealStatus(
        trx,
        organizationId,
        { suspensionId: input.suspensionId ?? null, decisionId: input.decisionId ?? null },
        'pending',
      );
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
      // A granted appeal overturns what it appealed; a denied one records the outcome on it; a
      // withdrawn one leaves no pending appeal.
      if (next === 'withdrawn') {
        await this.setAppealStatus(
          trx,
          organizationId,
          { suspensionId: row.suspension_id, decisionId: row.decision_id },
          'none',
        );
      }
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
      if (row.decision_id && decided) {
        await this.setAppealStatus(
          trx,
          organizationId,
          { suspensionId: null, decisionId: row.decision_id, includeClosed: true },
          next === 'granted' ? 'granted' : 'denied',
        );
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
  private async setAppealStatus(
    trx: Trx,
    organizationId: string,
    target: { suspensionId: string | null; decisionId: string | null; includeClosed?: boolean },
    status: Suspension['appealStatus'],
  ): Promise<void> {
    if (!target.suspensionId && !target.decisionId) return;
    let q = trx
      .updateTable('suspensions')
      .set({ appeal_status: status, revision: sql`revision + 1` })
      .where('organization_id', '=', organizationId);
    q = target.suspensionId
      ? q.where('id', '=', target.suspensionId)
      : q.where('decision_id', '=', target.decisionId as string);
    if (!target.suspensionId && !target.includeClosed) {
      q = q.where('status', 'in', ['proposed', 'active']);
    }
    await q.execute();
  }

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

const ListCursor = z.object({ at: z.string(), id: z.uuid() });

/** The keyset cursor after the page, or null on the last page. */
export function nextCursorOf(
  rows: ReadonlyArray<{ created_at: Date | string; id: string }>,
  page: ReadonlyArray<{ created_at: Date | string; id: string }>,
  limit: number,
): string | null {
  const last = page[page.length - 1];
  return rows.length > limit && last
    ? encodeCursor({ at: iso(last.created_at), id: last.id })
    : null;
}
