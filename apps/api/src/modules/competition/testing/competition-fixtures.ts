import {
  newId,
  type CompetitionKind,
  type DivisionCriteria,
  type RuleSetContent,
  type SportFormat,
} from '@sportspark/contracts';
import {
  json,
  type Db,
  type FixtureStatus,
  type RosterPlayingStatus,
  type RosterSource,
  type SeasonStatus,
  type TeamEntryStatus,
  type TeamRoleValue,
} from '@sportspark/db';
import type { Clock } from '../../../kernel';
import { proposedRuleSetContent } from '../competition.policy';

/**
 * Competition fixtures for downstream module tests (workforce, enrollment, finance, entry,
 * reporting, competition part 2). Rows are written directly through Kysely so they are fast and
 * need no HTTP; the shapes mirror what the services write. People come from the identity
 * fixtures (`createPersonFixture`); the context is structural, a `TestApp` satisfies it.
 */
export interface CompetitionFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
  facilityId: string;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

let counter = 0;
const next = (): number => (counter += 1);

export async function createRuleSetFixture(
  ctx: CompetitionFixtureContext,
  input: {
    format?: SportFormat;
    name?: string;
    /** Deep overrides applied over the proposed defaults for the format. */
    content?: Partial<RuleSetContent>;
    version?: number;
    supersedesRuleSetId?: string | null;
    organizationId?: string;
  } = {},
): Promise<{ id: string; content: RuleSetContent; format: SportFormat }> {
  const id = newId();
  const format = input.format ?? 'small_sided_other';
  const content: RuleSetContent = { ...proposedRuleSetContent(format), ...(input.content ?? {}) };
  await ctx.db
    .insertInto('rule_sets')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      name: input.name ?? `Rules ${next()}`,
      format,
      version: input.version ?? 1,
      content: json(content),
      supersedes_rule_set_id: input.supersedesRuleSetId ?? null,
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return { id, content, format };
}

export async function createCompetitionFixture(
  ctx: CompetitionFixtureContext,
  input: {
    name?: string;
    kind?: CompetitionKind;
    sportFormat?: SportFormat;
    status?: 'draft' | 'active' | 'archived';
    organizationId?: string;
  } = {},
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('competitions')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      name: input.name ?? `Competition ${next()}`,
      kind: input.kind ?? 'league',
      sport_format: input.sportFormat ?? 'small_sided_other',
      description: null,
      status: input.status ?? 'active',
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}

export interface SeasonFixture {
  seasonId: string;
  competitionId: string;
  ruleSetId: string;
  ruleSet: RuleSetContent;
}

/** A season of an active competition under one rule-set version; defaults to an open registration. */
export async function createSeasonFixture(
  ctx: CompetitionFixtureContext,
  input: {
    competitionId?: string;
    ruleSetId?: string;
    ruleSet?: Partial<RuleSetContent>;
    sportFormat?: SportFormat;
    name?: string;
    startsOn?: string;
    endsOn?: string;
    status?: SeasonStatus;
    registrationOfferingRef?: string | null;
    registrationOpensAt?: Date | null;
    registrationClosesAt?: Date | null;
    organizationId?: string;
  } = {},
): Promise<SeasonFixture> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  const format = input.sportFormat ?? 'small_sided_other';
  const competitionId =
    input.competitionId ??
    (await createCompetitionFixture(ctx, { sportFormat: format, organizationId }));
  let ruleSetId = input.ruleSetId;
  let ruleSet: RuleSetContent;
  if (ruleSetId) {
    const row = await ctx.db
      .selectFrom('rule_sets')
      .select('content')
      .where('id', '=', ruleSetId)
      .executeTakeFirstOrThrow();
    ruleSet = row.content as unknown as RuleSetContent;
  } else {
    const created = await createRuleSetFixture(ctx, {
      format,
      content: input.ruleSet,
      organizationId,
    });
    ruleSetId = created.id;
    ruleSet = created.content;
  }
  const seasonId = newId();
  await ctx.db
    .insertInto('seasons')
    .values({
      id: seasonId,
      organization_id: organizationId,
      competition_id: competitionId,
      name: input.name ?? `Season ${next()}`,
      rule_set_id: ruleSetId,
      starts_on: input.startsOn ?? '2027-01-10',
      ends_on: input.endsOn ?? '2027-04-10',
      registration_offering_ref: input.registrationOfferingRef ?? null,
      registration_opens_at: input.registrationOpensAt ?? null,
      registration_closes_at: input.registrationClosesAt ?? null,
      status: input.status ?? 'open',
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return { seasonId, competitionId, ruleSetId, ruleSet };
}

export async function createDivisionFixture(
  ctx: CompetitionFixtureContext,
  input: {
    seasonId: string;
    name?: string;
    criteria?: Partial<DivisionCriteria>;
    facilityId?: string | null;
    capacityTeamEntries?: number | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const criteria: DivisionCriteria = {
    ageBand: null,
    level: null,
    category: null,
    format: null,
    ...(input.criteria ?? {}),
  };
  await ctx.db
    .insertInto('divisions')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      season_id: input.seasonId,
      name: input.name ?? `Division ${next()}`,
      criteria: json(criteria),
      facility_id: input.facilityId === undefined ? ctx.facilityId : input.facilityId,
      capacity_team_entries: input.capacityTeamEntries ?? null,
    })
    .execute();
  return id;
}

export interface TeamEntryFixture {
  teamId: string;
  teamEntryId: string;
  captainRoleId: string;
}

/** A continuing team (unless given), its entry in the season and the captain's effective role. */
export async function createTeamEntryFixture(
  ctx: CompetitionFixtureContext,
  input: {
    seasonId: string;
    captainPersonId: string;
    teamId?: string;
    teamName?: string;
    divisionId?: string | null;
    status?: TeamEntryStatus;
    financialStatusRef?: string | null;
    renewedFromEntryId?: string | null;
    organizationId?: string;
  },
): Promise<TeamEntryFixture> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  const now = ctx.clock.now();
  let teamId = input.teamId;
  if (!teamId) {
    teamId = newId();
    await ctx.db
      .insertInto('teams')
      .values({
        id: teamId,
        organization_id: organizationId,
        name: input.teamName ?? `Team ${next()}`,
        colors: json({}),
        created_by: json(FIXTURE_ACTOR),
        created_by_person_id: input.captainPersonId,
      })
      .execute();
  }
  const teamEntryId = newId();
  const status = input.status ?? 'approved';
  await ctx.db
    .insertInto('team_entries')
    .values({
      id: teamEntryId,
      organization_id: organizationId,
      season_id: input.seasonId,
      division_id: input.divisionId ?? null,
      team_id: teamId,
      status,
      applied_by: json(FIXTURE_ACTOR),
      applied_by_person_id: input.captainPersonId,
      applied_at: now,
      approved_at: status === 'approved' ? now : null,
      approved_by: status === 'approved' ? json(FIXTURE_ACTOR) : null,
      rejected_at: status === 'rejected' ? now : null,
      rejected_by: status === 'rejected' ? json(FIXTURE_ACTOR) : null,
      rejection_reason: status === 'rejected' ? 'fixture' : null,
      withdrawn_at: status === 'withdrawn' ? now : null,
      withdrawn_by: status === 'withdrawn' ? json(FIXTURE_ACTOR) : null,
      withdrawal_reason: status === 'withdrawn' ? 'fixture' : null,
      financial_status_ref: input.financialStatusRef ?? null,
      renewed_from_entry_id: input.renewedFromEntryId ?? null,
    })
    .execute();
  const captainRoleId = await assignTeamRoleFixture(ctx, {
    teamEntryId,
    personId: input.captainPersonId,
    role: 'captain',
    organizationId,
  });
  return { teamId, teamEntryId, captainRoleId };
}

export async function assignTeamRoleFixture(
  ctx: CompetitionFixtureContext,
  input: {
    teamEntryId: string;
    personId: string;
    role: TeamRoleValue;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('team_roles')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      team_entry_id: input.teamEntryId,
      person_id: input.personId,
      role: input.role,
      effective_from: input.effectiveFrom ?? ctx.clock.now(),
      effective_to: input.effectiveTo ?? null,
      assigned_by: json(FIXTURE_ACTOR),
      ended_by: null,
      ended_reason: null,
    })
    .execute();
  return id;
}

/** An effective (open) roster row; no eligibility evaluation, so tests set up exactly the state they need. */
export async function addRosterMemberFixture(
  ctx: CompetitionFixtureContext,
  input: {
    teamEntryId: string;
    personId: string;
    status?: RosterPlayingStatus;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    jerseyNumber?: number | null;
    source?: RosterSource;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('roster_memberships')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      team_entry_id: input.teamEntryId,
      person_id: input.personId,
      status: input.status ?? 'active',
      status_before_removal: null,
      effective_from: input.effectiveFrom ?? ctx.clock.now(),
      effective_to: input.effectiveTo ?? null,
      jersey_number: input.jerseyNumber ?? null,
      source: input.source ?? 'staff',
      added_by: json(FIXTURE_ACTOR),
      added_by_person_id: null,
      removed_at: null,
      removed_by: null,
      removal_reason: null,
    })
    .execute();
  return id;
}

/**
 * A fixture row. `scheduled` requires a scheduling event id and instants (database check);
 * schedule through FixturesService or the scheduling fixtures when the event must be real.
 */
export async function createFixtureFixture(
  ctx: CompetitionFixtureContext,
  input: {
    seasonId: string;
    homeEntryId: string;
    awayEntryId?: string | null;
    divisionId?: string | null;
    round?: number | null;
    status?: FixtureStatus;
    schedulingEventId?: string | null;
    scheduledStart?: Date | string | null;
    scheduledEnd?: Date | string | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('fixtures')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      season_id: input.seasonId,
      division_id: input.divisionId ?? null,
      round: input.round ?? null,
      home_entry_id: input.homeEntryId,
      away_entry_id: input.awayEntryId ?? null,
      scheduling_event_id: input.schedulingEventId ?? null,
      scheduled_start: input.scheduledStart ?? null,
      scheduled_end: input.scheduledEnd ?? null,
      status: input.status ?? 'unscheduled',
      notes: null,
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}
