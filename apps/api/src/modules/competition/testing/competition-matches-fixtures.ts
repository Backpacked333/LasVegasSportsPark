import { newId, type ResultClassification, type ResultStatus } from '@sportspark/contracts';
import { json, type SuspensionScope, type SuspensionStatus } from '@sportspark/db';
import type { CompetitionFixtureContext } from './competition-fixtures';

/**
 * Part 2 fixtures for downstream module tests (workforce, finance, reporting, communications):
 * result revisions, suspensions and bracket nodes written directly through Kysely. Shapes mirror
 * what the services write; the database constraints still apply (one official result per
 * fixture, suspension terms, bracket slots).
 */

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

export async function createResultRevisionFixture(
  ctx: CompetitionFixtureContext,
  input: {
    fixtureId: string;
    status?: ResultStatus;
    classification?: ResultClassification;
    homeScore?: number | null;
    awayScore?: number | null;
    forfeitingEntryId?: string | null;
    revisionNo?: number;
    supersedesRevisionId?: string | null;
    reason?: string | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const status = input.status ?? 'official';
  const published = status === 'official' || status === 'superseded';
  await ctx.db
    .insertInto('result_revisions')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      fixture_id: input.fixtureId,
      revision_no: input.revisionNo ?? 1,
      status,
      classification: input.classification ?? 'completed',
      home_score: input.homeScore === undefined ? 1 : input.homeScore,
      away_score: input.awayScore === undefined ? 0 : input.awayScore,
      forfeiting_entry_id: input.forfeitingEntryId ?? null,
      details: json({
        cards: [],
        abandonment: null,
        incidentIds: [],
        notes: null,
        disputeId: null,
      }),
      submitted_by: json(FIXTURE_ACTOR),
      submitted_by_person_id: null,
      submitted_at: status === 'draft' ? null : now,
      returned_at: null,
      returned_by: null,
      return_reason: null,
      published_by: published ? json(FIXTURE_ACTOR) : null,
      published_by_person_id: null,
      published_at: published ? now : null,
      supersedes_revision_id: input.supersedesRevisionId ?? null,
      superseded_at: status === 'superseded' ? now : null,
      superseded_by: status === 'superseded' ? json(FIXTURE_ACTOR) : null,
      superseded_by_revision_id: null,
      reason: input.reason ?? null,
    })
    .execute();
  return id;
}

export async function createSuspensionFixture(
  ctx: CompetitionFixtureContext,
  input: {
    subjectPersonId: string;
    status?: SuspensionStatus;
    scope?: SuspensionScope;
    competitionIds?: string[];
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
    matchCount?: number | null;
    matchesServed?: number;
    basis?: string;
    decisionId?: string | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const status = input.status ?? 'active';
  const competitionIds = input.competitionIds ?? [];
  const matchCount = input.matchCount === undefined ? null : input.matchCount;
  await ctx.db
    .insertInto('suspensions')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      subject_person_id: input.subjectPersonId,
      decision_id: input.decisionId ?? null,
      basis: input.basis ?? 'fixture',
      scope: input.scope ?? (competitionIds.length > 0 ? 'competitions' : 'all'),
      competition_ids: competitionIds,
      effective_from:
        input.effectiveFrom === undefined
          ? matchCount === null
            ? now
            : null
          : input.effectiveFrom,
      effective_to: input.effectiveTo ?? null,
      match_count: matchCount,
      matches_served: input.matchesServed ?? 0,
      completion_criteria:
        matchCount === null ? 'period elapses' : `${matchCount} match(es) served`,
      status,
      approved_by: status === 'active' || status === 'served' ? json(FIXTURE_ACTOR) : null,
      approved_at: status === 'active' || status === 'served' ? now : null,
      overturned_at: status === 'overturned' ? now : null,
      overturned_by: status === 'overturned' ? json(FIXTURE_ACTOR) : null,
      overturn_reason: status === 'overturned' ? 'fixture' : null,
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}

export async function createBracketNodeFixture(
  ctx: CompetitionFixtureContext,
  input: {
    seasonId: string;
    divisionId?: string | null;
    round?: number;
    slot?: number;
    fixtureId?: string | null;
    homeEntryId?: string | null;
    awayEntryId?: string | null;
    home?: Record<string, unknown>;
    away?: Record<string, unknown>;
    published?: boolean;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('bracket_nodes')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      season_id: input.seasonId,
      division_id: input.divisionId ?? null,
      name: null,
      round: input.round ?? 1,
      slot: input.slot ?? 1,
      source_rule: json({
        home: input.home ?? { kind: 'seed', seed: 1 },
        away: input.away ?? { kind: 'seed', seed: 2 },
      }),
      home_entry_id: input.homeEntryId ?? null,
      away_entry_id: input.awayEntryId ?? null,
      fixture_id: input.fixtureId ?? null,
      winner_entry_id: null,
      published: input.published ?? false,
      published_at: input.published ? now : null,
      published_by: input.published ? json(FIXTURE_ACTOR) : null,
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}
