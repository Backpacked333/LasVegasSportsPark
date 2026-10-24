import type {
  Appeal,
  BracketNode,
  BracketSource,
  CompletenessReport,
  DisciplinaryDecision,
  Dispute,
  EvidenceRef,
  FixtureSpecification,
  Incident,
  ProposedGame,
  ResultDetails,
  ResultRevision,
  SearchSettings,
  SolverExplanation,
  SolverRun,
  Standings,
  StandingsRow,
  StaffRole,
  Suspension,
  TiebreakExplanation,
} from '@sportspark/contracts';
import type {
  AppealsTable,
  BracketNodesTable,
  DisciplinaryDecisionsTable,
  DisputesTable,
  FixtureSpecificationsTable,
  IncidentsTable,
  ResultRevisionsTable,
  SolverRunsTable,
  StandingsProjectionsTable,
  SuspensionsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { ActionDefinition } from '../../kernel';
import { iso, isoOrNull } from './competition.shared';

/** Row mapping for part 2 records. Narratives are mapped only by the restricted incident view. */

interface ActorJson {
  kind?: string;
  accountId?: string | null;
  personId?: string | null;
  actorLabel?: string;
}

export function actorOf(value: Record<string, unknown> | null): Incident['reportedBy'] | null {
  if (!value) return null;
  const a = value as ActorJson;
  return {
    kind: a.kind ?? 'unknown',
    accountId: a.accountId ?? null,
    personId: a.personId ?? null,
    actorLabel: a.actorLabel ?? '',
  };
}

function requiredActor(value: Record<string, unknown>): Incident['reportedBy'] {
  return actorOf(value) ?? { kind: 'unknown', accountId: null, personId: null, actorLabel: '' };
}

export function evidenceOf(value: unknown[]): EvidenceRef[] {
  return value as EvidenceRef[];
}

/** An action definition widened with the roles a rule set names (publication/submission authority, DEC-065). */
export function withRuleSetRoles(
  definition: ActionDefinition,
  roles: readonly StaffRole[],
): ActionDefinition {
  return { ...definition, staffRoles: [...new Set([...definition.staffRoles, ...roles])] };
}

export function detailsOf(row: { details: Record<string, unknown> }): ResultDetails {
  const d = row.details as Partial<ResultDetails>;
  return {
    cards: d.cards ?? [],
    abandonment: d.abandonment ?? null,
    incidentIds: d.incidentIds ?? [],
    notes: d.notes ?? null,
    disputeId: d.disputeId ?? null,
  };
}

export function toResultRevision(row: Selectable<ResultRevisionsTable>): ResultRevision {
  return {
    id: row.id,
    fixtureId: row.fixture_id,
    revisionNo: row.revision_no,
    status: row.status,
    classification: row.classification,
    homeScore: row.home_score,
    awayScore: row.away_score,
    forfeitingEntryId: row.forfeiting_entry_id,
    details: detailsOf(row),
    submittedBy: requiredActor(row.submitted_by),
    submittedAt: isoOrNull(row.submitted_at),
    returnedAt: isoOrNull(row.returned_at),
    returnReason: row.return_reason,
    publishedBy: actorOf(row.published_by),
    publishedAt: isoOrNull(row.published_at),
    supersedesRevisionId: row.supersedes_revision_id,
    supersededAt: isoOrNull(row.superseded_at),
    supersededByRevisionId: row.superseded_by_revision_id,
    reason: row.reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toStandings(row: Selectable<StandingsProjectionsTable>): Standings {
  return {
    id: row.id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    ruleSetId: row.rule_set_id,
    ruleSetVersion: row.rule_set_version,
    computedAt: iso(row.computed_at),
    sourceResultIds: row.source_result_ids,
    rows: row.rows as StandingsRow[],
    tiebreakExplanations: row.tiebreak_explanations as TiebreakExplanation[],
  };
}

export function toBracketNode(row: Selectable<BracketNodesTable>): BracketNode {
  const rule = row.source_rule as { home: BracketSource; away: BracketSource };
  return {
    id: row.id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    name: row.name,
    round: row.round,
    slot: row.slot,
    sourceRule: { home: rule.home, away: rule.away },
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
    fixtureId: row.fixture_id,
    winnerEntryId: row.winner_entry_id,
    published: row.published,
    publishedAt: isoOrNull(row.published_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface SpecificationRow extends Omit<
  Selectable<FixtureSpecificationsTable>,
  'starts_on' | 'ends_on'
> {
  starts_on: string;
  ends_on: string;
}

export function toFixtureSpecification(
  row: SpecificationRow,
  teamEntryIds: string[],
): FixtureSpecification {
  return {
    id: row.id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    facilityId: row.facility_id,
    name: row.name,
    teamEntryIds,
    gamesPerTeam: row.games_per_team,
    opponentFrequency: row.opponent_frequency,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    blackouts: row.blackouts as FixtureSpecification['blackouts'],
    byesAllowed: row.byes_allowed,
    minimumRestMinutes: row.minimum_rest_minutes,
    allowedStartTimes: row.allowed_start_times as FixtureSpecification['allowedStartTimes'],
    matchDurationMinutes: row.match_duration_minutes,
    requiredResourceIds: row.required_resource_ids,
    playoffStructure: (row.playoff_structure as FixtureSpecification['playoffStructure']) ?? null,
    fairnessPreferences: row.fairness_preferences as FixtureSpecification['fairnessPreferences'],
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toSolverRun(row: Selectable<SolverRunsTable>): SolverRun {
  return {
    id: row.id,
    specificationId: row.specification_id,
    ruleSetId: row.rule_set_id,
    searchSettings: row.search_settings as unknown as SearchSettings,
    outcome: row.outcome,
    proposal: (row.proposal as { games: ProposedGame[] } | null) ?? null,
    completenessReport: row.completeness_report as unknown as CompletenessReport,
    explanation: row.explanation as unknown as SolverExplanation,
    dryRun: row.dry_run,
    scheduleDraftId: row.schedule_draft_id,
    fixtureIds: row.fixture_ids,
    operationId: row.operation_id,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at),
  };
}

export function toDispute(
  row: Selectable<DisputesTable>,
  appealStatus: Dispute['appealStatus'],
): Dispute {
  return {
    id: row.id,
    fixtureId: row.fixture_id,
    resultRevisionId: row.result_revision_id,
    submittingTeamEntryId: row.submitting_team_entry_id,
    submittingRole: row.submitting_role,
    submittedBy: requiredActor(row.submitted_by),
    submittedAt: iso(row.submitted_at),
    submissionDeadlineAt: iso(row.submission_deadline_at),
    reason: row.reason,
    evidence: evidenceOf(row.evidence_refs),
    status: row.status,
    reviewer: actorOf(row.reviewer),
    decision: row.decision,
    decidedAt: isoOrNull(row.decided_at),
    decisionReason: row.decision_reason,
    publicationConsequence: row.publication_consequence,
    appealStatus,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Restricted view: includes the narrative (SPK-DISC-004). Never used for public or team views. */
export function toIncident(row: Selectable<IncidentsTable>): Incident {
  return {
    id: row.id,
    kind: row.kind,
    fixtureId: row.fixture_id,
    seasonId: row.season_id,
    competitionId: row.competition_id,
    subjectPersonId: row.subject_person_id,
    teamEntryId: row.team_entry_id,
    resultRevisionId: row.result_revision_id,
    occurredAt: iso(row.occurred_at),
    minute: row.minute,
    cardKind: row.card_kind,
    severity: row.severity,
    summary: row.summary,
    narrative: row.narrative,
    evidence: evidenceOf(row.evidence_refs),
    reportedBy: requiredActor(row.reported_by),
    status: row.status,
    closedAt: isoOrNull(row.closed_at),
    closureNote: row.closure_note,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toDecision(
  row: Selectable<DisciplinaryDecisionsTable>,
  suspensionId: string | null,
): DisciplinaryDecision {
  return {
    id: row.id,
    incidentId: row.incident_id,
    subjectPersonId: row.subject_person_id,
    ruleSetId: row.rule_set_id,
    basis: row.basis,
    decision: row.decision,
    details: row.details,
    decidedBy: requiredActor(row.decided_by),
    decidedAt: iso(row.decided_at),
    status: row.status,
    overturnedAt: isoOrNull(row.overturned_at),
    overturnReason: row.overturn_reason,
    suspensionId,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toSuspension(row: Selectable<SuspensionsTable>): Suspension {
  return {
    id: row.id,
    subjectPersonId: row.subject_person_id,
    decisionId: row.decision_id,
    basis: row.basis,
    scope: row.scope,
    competitionIds: row.competition_ids,
    effectiveFrom: isoOrNull(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    matchCount: row.match_count,
    matchesServed: row.matches_served,
    servedFixtureIds: row.served_fixture_ids,
    completionCriteria: row.completion_criteria,
    sourceKind: row.source_kind,
    sourceFixtureId: row.source_fixture_id,
    sourceResultRevisionId: row.source_result_revision_id,
    status: row.status,
    approvedBy: actorOf(row.approved_by),
    approvedAt: isoOrNull(row.approved_at),
    appealStatus: row.appeal_status,
    overturnedAt: isoOrNull(row.overturned_at),
    overturnReason: row.overturn_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toAppeal(row: Selectable<AppealsTable>): Appeal {
  return {
    id: row.id,
    subjectPersonId: row.subject_person_id,
    decisionId: row.decision_id,
    suspensionId: row.suspension_id,
    disputeId: row.dispute_id,
    grounds: row.grounds,
    evidence: evidenceOf(row.evidence_refs),
    submittedBy: requiredActor(row.submitted_by),
    submittedAt: iso(row.submitted_at),
    status: row.status,
    reviewer: actorOf(row.reviewer),
    decidedAt: isoOrNull(row.decided_at),
    decisionReason: row.decision_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export const specificationColumns = [
  'fixture_specifications.id',
  'fixture_specifications.organization_id',
  'fixture_specifications.season_id',
  'fixture_specifications.division_id',
  'fixture_specifications.facility_id',
  'fixture_specifications.name',
  'fixture_specifications.games_per_team',
  'fixture_specifications.opponent_frequency',
  'fixture_specifications.blackouts',
  'fixture_specifications.byes_allowed',
  'fixture_specifications.minimum_rest_minutes',
  'fixture_specifications.allowed_start_times',
  'fixture_specifications.match_duration_minutes',
  'fixture_specifications.required_resource_ids',
  'fixture_specifications.playoff_structure',
  'fixture_specifications.fairness_preferences',
  'fixture_specifications.created_by',
  'fixture_specifications.revision',
  'fixture_specifications.created_at',
  'fixture_specifications.updated_at',
] as const;
