import { createHash, randomBytes } from 'node:crypto';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  errors,
  type AvailabilitySummary,
  type Competition,
  type Division,
  type DivisionCriteria,
  type EligibilityReason,
  type EligibilityReferenceDate,
  type Fixture,
  type FixtureAvailabilityResponse,
  type JoinRequest,
  type Principal,
  type RosterMember,
  type RuleSet,
  type RuleSetContent,
  type Season,
  type Team,
  type TeamEntry,
  type TeamInvitation,
  type TeamRoleRecord,
} from '@sportspark/contracts';
import type {
  AvailabilityResponsesTable,
  CompetitionsTable,
  DivisionsTable,
  FixturesTable,
  JoinRequestsTable,
  RosterMembershipsTable,
  RosterPlayingStatus,
  RuleSetsTable,
  TeamEntriesTable,
  TeamInvitationsTable,
  TeamRolesTable,
  TeamsTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import type { RequestWithContext } from '../../kernel';
import type { FixtureSummary, TeamEntrySummary } from './ports';

/** Correlation id assigned by the kernel middleware, for audit and outbox records (§4.10). */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().correlationId ?? null,
);

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

/**
 * Source records customers (captains, players, guardians) may learn about only through the issue
 * itself: their ids are restricted (SPK-DISC-004, SPK-CAP-002, §4.10).
 */
export const RESTRICTED_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'suspension',
  'dispute',
  'audit_record',
  'incident',
]);

export function isStaffLike(principal: Principal): boolean {
  return principal.kind === 'staff' || principal.kind === 'system';
}

export const iso = (value: Date | string): string => new Date(value).toISOString();
export const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : iso(value);

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface Effectivity {
  effective_from: Date | string;
  effective_to: Date | string | null;
}

/** Half-open effectivity [from, to). */
export function isEffectiveAt(row: Effectivity, at: Date): boolean {
  const from = new Date(row.effective_from).getTime();
  const to =
    row.effective_to === null ? Number.POSITIVE_INFINITY : new Date(row.effective_to).getTime();
  const t = at.getTime();
  return from <= t && t < to;
}

export const PLAYING_STATUSES: readonly RosterPlayingStatus[] = ['active', 'guest', 'substitute'];
/** Statuses that count toward the rule set's roster maximum (guests have their own limit). */
export const ROSTER_LIMIT_STATUSES: readonly RosterPlayingStatus[] = ['active', 'substitute'];

/**
 * Date on which age eligibility is evaluated (SPK-COMP-002 "Eligibility reference dates", §4.5:
 * never a stored age). Returned as a `YYYY-MM-DD` string.
 */
export function referenceDateFor(
  rule: EligibilityReferenceDate,
  season: { starts_on: string },
  at: Date,
): string {
  switch (rule.rule) {
    case 'season_start':
      return season.starts_on;
    case 'calendar_year_start':
      return `${at.getUTCFullYear()}-01-01`;
    case 'match_date':
      return at.toISOString().slice(0, 10);
    case 'fixed_date':
      return rule.date;
  }
}

/** Whole years between a date of birth and a reference date (both `YYYY-MM-DD`). */
export function ageOn(dateOfBirth: string, referenceDate: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ry, rm, rd] = referenceDate.split('-').map(Number) as [number, number, number];
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

export function ruleSetContentOf(row: { content: Record<string, unknown> }): RuleSetContent {
  return row.content as unknown as RuleSetContent;
}

export function criteriaOf(row: { criteria: Record<string, unknown> }): DivisionCriteria {
  const c = row.criteria as Partial<DivisionCriteria>;
  return {
    ageBand: c.ageBand ?? null,
    level: c.level ?? null,
    category: c.category ?? null,
    format: c.format ?? null,
  };
}

/** Columns for seasons with the date cast both drivers return as `YYYY-MM-DD`. */
export const seasonColumns = [
  'seasons.id',
  'seasons.organization_id',
  'seasons.competition_id',
  'seasons.name',
  'seasons.rule_set_id',
  sql<string>`seasons.starts_on::text`.as('starts_on'),
  sql<string>`seasons.ends_on::text`.as('ends_on'),
  'seasons.registration_offering_ref',
  'seasons.registration_opens_at',
  'seasons.registration_closes_at',
  'seasons.status',
  'seasons.revision',
  'seasons.created_at',
  'seasons.updated_at',
] as const;

export interface SeasonRow {
  id: string;
  organization_id: string;
  competition_id: string;
  name: string;
  rule_set_id: string;
  starts_on: string;
  ends_on: string;
  registration_offering_ref: string | null;
  registration_opens_at: Date | string | null;
  registration_closes_at: Date | string | null;
  status: Season['status'];
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------
export function toCompetition(row: Selectable<CompetitionsTable>): Competition {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    sportFormat: row.sport_format,
    description: row.description,
    status: row.status,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toRuleSet(row: Selectable<RuleSetsTable>): RuleSet {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    version: row.version,
    content: ruleSetContentOf(row),
    supersedesRuleSetId: row.supersedes_rule_set_id,
    createdAt: iso(row.created_at),
  };
}

export function toSeason(row: SeasonRow): Season {
  return {
    id: row.id,
    competitionId: row.competition_id,
    name: row.name,
    ruleSetId: row.rule_set_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    registrationOfferingRef: row.registration_offering_ref,
    registrationOpensAt: isoOrNull(row.registration_opens_at),
    registrationClosesAt: isoOrNull(row.registration_closes_at),
    status: row.status,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toDivision(row: Selectable<DivisionsTable>, entryCount: number): Division {
  return {
    id: row.id,
    seasonId: row.season_id,
    name: row.name,
    criteria: criteriaOf(row),
    facilityId: row.facility_id,
    capacityTeamEntries: row.capacity_team_entries,
    entryCount,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toTeam(row: Selectable<TeamsTable>): Team {
  const colors = row.colors as { primary?: string; secondary?: string };
  return {
    id: row.id,
    name: row.name,
    colors: {
      ...(colors.primary ? { primary: colors.primary } : {}),
      ...(colors.secondary ? { secondary: colors.secondary } : {}),
    },
    createdByPersonId: row.created_by_person_id,
    status: row.status,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface RosterFacts {
  rosterCount: number;
  rosterMin: number;
  rosterMax: number;
}

export function toTeamEntry(
  row: Selectable<TeamEntriesTable>,
  roster: RosterFacts,
  teamName: string,
): TeamEntry {
  return {
    id: row.id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    teamId: row.team_id,
    teamName,
    status: row.status,
    appliedByPersonId: row.applied_by_person_id,
    appliedAt: iso(row.applied_at),
    approvedAt: isoOrNull(row.approved_at),
    approvalNote: row.approval_note,
    rejectedAt: isoOrNull(row.rejected_at),
    rejectionReason: row.rejection_reason,
    withdrawnAt: isoOrNull(row.withdrawn_at),
    withdrawalReason: row.withdrawal_reason,
    financialStatusRef: row.financial_status_ref,
    eligibilityStatus: row.eligibility_status,
    eligibilityReasons: row.eligibility_reasons as EligibilityReason[],
    renewedFromEntryId: row.renewed_from_entry_id,
    // Derived, never stored (SPK-COMP-004): enough eligible players within the rule set's limits.
    rosterComplete:
      roster.rosterCount >= roster.rosterMin && roster.rosterCount <= roster.rosterMax,
    rosterCount: roster.rosterCount,
    rosterMin: roster.rosterMin,
    rosterMax: roster.rosterMax,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toTeamEntrySummary(
  row: Selectable<TeamEntriesTable>,
  team: { name: string },
  competitionId: string,
): TeamEntrySummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    seasonId: row.season_id,
    competitionId,
    divisionId: row.division_id,
    teamId: row.team_id,
    teamName: team.name,
    status: row.status,
    financialStatusRef: row.financial_status_ref,
    eligibilityStatus: row.eligibility_status,
    revision: row.revision,
  };
}

export function toTeamRole(row: Selectable<TeamRolesTable>): TeamRoleRecord {
  return {
    id: row.id,
    teamEntryId: row.team_entry_id,
    personId: row.person_id,
    role: row.role,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
  };
}

export interface RosterPerson {
  given_name: string;
  family_name: string;
  kind: 'adult' | 'child';
}

export function toRosterMember(
  row: Selectable<RosterMembershipsTable>,
  person: RosterPerson,
  eligibility: RosterMember['eligibility'],
): RosterMember {
  return {
    id: row.id,
    teamEntryId: row.team_entry_id,
    personId: row.person_id,
    // Teammates see a display name only: no date of birth, contacts or family details (SPK-CAP-002).
    displayName: `${person.given_name} ${person.family_name}`.trim(),
    personKind: person.kind,
    status: row.status,
    statusBeforeRemoval: row.status_before_removal,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    jerseyNumber: row.jersey_number,
    source: row.source,
    removedAt: isoOrNull(row.removed_at),
    removalReason: row.removal_reason,
    eligibility,
  };
}

export function toTeamInvitation(row: Selectable<TeamInvitationsTable>): TeamInvitation {
  return {
    id: row.id,
    teamEntryId: row.team_entry_id,
    invitedByPersonId: row.invited_by_person_id,
    recipientPersonId: row.recipient_person_id,
    recipientContact:
      row.recipient_contact_kind && row.recipient_contact_value
        ? { kind: row.recipient_contact_kind, value: row.recipient_contact_value }
        : null,
    message: row.message,
    status: row.status,
    expiresAt: iso(row.expires_at),
    acceptedAt: isoOrNull(row.accepted_at),
    acceptedByPersonId: row.accepted_by_person_id,
    revokedAt: isoOrNull(row.revoked_at),
    rosterMembershipId: row.roster_membership_id,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toJoinRequest(row: Selectable<JoinRequestsTable>): JoinRequest {
  return {
    id: row.id,
    teamEntryId: row.team_entry_id,
    personId: row.person_id,
    requestedByPersonId: row.requested_by_person_id,
    message: row.message,
    status: row.status,
    decidedByPersonId: row.decided_by_person_id,
    decidedAt: isoOrNull(row.decided_at),
    decisionNote: row.decision_note,
    rosterMembershipId: row.roster_membership_id,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toFixture(row: Selectable<FixturesTable>): Fixture {
  return {
    id: row.id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    round: row.round,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
    schedulingEventId: row.scheduling_event_id,
    scheduledStart: isoOrNull(row.scheduled_start),
    scheduledEnd: isoOrNull(row.scheduled_end),
    status: row.status,
    notes: row.notes,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toFixtureSummary(row: Selectable<FixturesTable>): FixtureSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    round: row.round,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
    schedulingEventId: row.scheduling_event_id,
    scheduledStart: row.scheduled_start ? new Date(row.scheduled_start) : null,
    scheduledEnd: row.scheduled_end ? new Date(row.scheduled_end) : null,
    status: row.status,
    revision: row.revision,
  };
}

export function toAvailabilityResponse(
  row: Selectable<AvailabilityResponsesTable>,
): FixtureAvailabilityResponse {
  return {
    id: row.id,
    fixtureId: row.fixture_id,
    teamEntryId: row.team_entry_id,
    personId: row.person_id,
    state: row.state,
    respondedAt: isoOrNull(row.responded_at),
    note: row.note,
    revision: row.revision,
  };
}

export function emptySummary(): AvailabilitySummary {
  return { available: 0, unavailable: 0, tentative: 0, noResponse: 0 };
}

export function hoursFromNow(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * 3600_000);
}
