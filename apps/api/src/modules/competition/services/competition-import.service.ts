import { Inject, Injectable } from '@nestjs/common';
import {
  ImportRosterMembershipInputSchema,
  ImportSeasonInputSchema,
  ImportTeamEntryInputSchema,
  ImportTeamInputSchema,
  errors,
  newId,
  type ImportProvenance,
  type ImportRosterMembershipInput,
  type ImportSeasonInput,
  type ImportTeamEntryInput,
  type ImportTeamInput,
  type Principal,
  type RosterMember,
  type Season,
  type SeasonStatus,
  type Team,
  type TeamEntry,
  type TeamStatus,
  type z,
} from '@sportspark/contracts';
import {
  isCheckViolation,
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
} from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  UnitOfWork,
  assertImportPrincipal,
  importContentMismatch,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PeopleService } from '../../identity';
import { CompetitionActions } from '../competition.actions';
import {
  loadEntryContext,
  loadSeasonRow,
  peakRosterCounts,
  rosterRowsOverlapping,
} from '../competition.queries';
import {
  ROSTER_LIMIT_STATUSES,
  iso,
  isoOrNull,
  organizationOf,
  toSeason,
  toTeam,
} from '../competition.shared';
import { SeasonMachine, TeamEntryMachine, TeamMachine } from '../competition.state-machines';
import { assertJerseyInRange } from './roster.service';
import { TeamEntriesService } from './team-entries.service';

type WithProvenance<T> = T & { importProvenance: ImportProvenance };

/** The season lifecycle walked from `draft` to reach an imported status (SeasonMachine). */
const SEASON_PATH: Record<SeasonStatus, Array<'open' | 'activate' | 'complete' | 'archive'>> = {
  draft: [],
  open: ['open'],
  active: ['open', 'activate'],
  completed: ['open', 'activate', 'complete'],
  archived: ['archive'],
};
/** The team lifecycle walked from `active` (TeamMachine). */
const TEAM_PATH: Record<TeamStatus, Array<'deactivate' | 'archive'>> = {
  active: [],
  inactive: ['deactivate'],
  archived: ['archive'],
};
const ENDED_IMPORT_REASON = 'Imported: the membership ended in the source system.';

/**
 * Migration import commands (CMP-09, IF-40; §5.3 seasons, teams and rosters, §5.4 extraction
 * provenance, SPK-AT-024). In-process only (no route): each runs for the migration import
 * principal of one batch (`assertImportPrincipal`), joins the caller's unit of work, validates the
 * snapshot like the staff commands (rule set of the competition's format, one live entry per team
 * per season, division capacity, roster rules), and inserts once with `id = recordId` and source
 * `import`, audited with the import actor. The same record with equal content returns it with no
 * effect; different content is RESOURCE_CONFLICT IMPORT_CONTENT_MISMATCH. Lifecycles go through
 * their machines from the initial state (an approved entry is inserted `applied` and approved in
 * the same transaction with the snapshot's approval date). Imports publish no domain events:
 * migrated history must not start new obligations, notices or charges. They do not consult
 * RECORD_AUTHORITY_PORT (the batch is the sanctioned writer).
 */
@Injectable()
export class CompetitionImportService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly people: PeopleService,
    private readonly entries: TeamEntriesService,
  ) {}

  async importSeason(
    principal: Principal,
    raw: WithProvenance<ImportSeasonInput>,
    correlationId: string | null = null,
  ): Promise<Season> {
    const { importProvenance: provenance, ...rest } = raw;
    const input = parse(ImportSeasonInputSchema, rest, 'season');
    const organizationId = await this.begin(principal, provenance, 'season');
    return this.uow.run(async ({ trx }) => {
      const id = provenance.recordId;
      const existing = await loadSeasonRow(trx, organizationId, id);
      if (existing) {
        const same =
          (await this.sourceOf(trx, 'seasons', organizationId, id)) === 'import' &&
          existing.competition_id === input.competitionId &&
          existing.name === input.name &&
          existing.rule_set_id === input.ruleSetId &&
          existing.starts_on === input.startsOn &&
          existing.ends_on === input.endsOn &&
          existing.status === input.status &&
          existing.registration_offering_ref === input.registrationOfferingRef &&
          isoOrNull(existing.registration_opens_at) === isoOrNull(input.registrationOpensAt) &&
          isoOrNull(existing.registration_closes_at) === isoOrNull(input.registrationClosesAt);
        if (same) return toSeason(existing);
        throw importContentMismatch({ seasonId: id, batchId: provenance.batchId });
      }
      await this.assertNotTakenElsewhere(trx, 'seasons', id, provenance);
      const competition = await trx
        .selectFrom('competitions')
        .select(['id', 'sport_format'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.competitionId)
        .executeTakeFirst();
      if (!competition) throw errors.notFound('competition', input.competitionId);
      const ruleSet = await trx
        .selectFrom('rule_sets')
        .select(['id', 'format'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.ruleSetId)
        .executeTakeFirst();
      if (!ruleSet) throw errors.notFound('rule_set', input.ruleSetId);
      if (ruleSet.format !== competition.sport_format) {
        throw errors.validation("The rule set's format does not match the competition.", {
          ruleSetFormat: ruleSet.format,
          sportFormat: competition.sport_format,
        });
      }
      let status: SeasonStatus = SeasonMachine.initial;
      for (const event of SEASON_PATH[input.status]) status = SeasonMachine.next(status, event);
      try {
        await trx
          .insertInto('seasons')
          .values({
            id,
            organization_id: organizationId,
            competition_id: input.competitionId,
            name: input.name,
            rule_set_id: input.ruleSetId,
            starts_on: input.startsOn,
            ends_on: input.endsOn,
            registration_offering_ref: input.registrationOfferingRef,
            registration_opens_at: input.registrationOpensAt,
            registration_closes_at: input.registrationClosesAt,
            status,
            source: 'import',
            created_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict(
            'A season with this name already exists in the competition.',
          );
        }
        throw error;
      }
      await this.record(trx, principal, provenance, 'season', id, correlationId, {
        competitionId: input.competitionId,
        transitions: [SeasonMachine.initial, ...SEASON_PATH[input.status]],
        status,
      });
      const row = await loadSeasonRow(trx, organizationId, id);
      if (!row) throw errors.internal('imported season vanished');
      return toSeason(row);
    });
  }

  async importTeam(
    principal: Principal,
    raw: WithProvenance<ImportTeamInput>,
    correlationId: string | null = null,
  ): Promise<Team> {
    const { importProvenance: provenance, ...rest } = raw;
    const input = parse(ImportTeamInputSchema, rest, 'team');
    const organizationId = await this.begin(principal, provenance, 'team');
    return this.uow.run(async ({ trx }) => {
      const id = provenance.recordId;
      const existing = await trx
        .selectFrom('teams')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing) {
        const same =
          existing.source === 'import' &&
          existing.name === input.name &&
          existing.status === input.status &&
          sameJson(existing.colors, input.colors);
        if (same) return toTeam(existing);
        throw importContentMismatch({ teamId: id, batchId: provenance.batchId });
      }
      await this.assertNotTakenElsewhere(trx, 'teams', id, provenance);
      let status: TeamStatus = TeamMachine.initial;
      for (const event of TEAM_PATH[input.status]) status = TeamMachine.next(status, event);
      await trx
        .insertInto('teams')
        .values({
          id,
          organization_id: organizationId,
          name: input.name,
          colors: json(input.colors),
          status,
          source: 'import',
          created_by: json(snapshotActor(principal)),
          created_by_person_id: null,
        })
        .execute();
      await this.record(trx, principal, provenance, 'team', id, correlationId, { status });
      const row = await trx
        .selectFrom('teams')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toTeam(row);
    });
  }

  async importTeamEntry(
    principal: Principal,
    raw: WithProvenance<ImportTeamEntryInput>,
    correlationId: string | null = null,
  ): Promise<TeamEntry> {
    const { importProvenance: provenance, ...rest } = raw;
    const input = parse(ImportTeamEntryInputSchema, rest, 'team entry');
    const organizationId = await this.begin(principal, provenance, 'team_entry');
    if (input.status === 'withdrawn' || input.status === 'rejected') {
      // Withdrawn and rejected entries stay staged history in the migration batch.
      throw errors.validation(`A ${input.status} entry is not imported; it stays staged history.`, {
        code: 'IMPORT_STATUS_NOT_IMPORTABLE',
        status: input.status,
      });
    }
    if ((input.status === 'approved') !== (input.approvedAt !== null)) {
      throw errors.validation('An approved entry carries its approval date, and only then.', {
        code: 'IMPORT_APPROVAL_DATE',
        status: input.status,
      });
    }
    return this.uow.run(async ({ trx }) => {
      const id = provenance.recordId;
      const existing = await trx
        .selectFrom('team_entries')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing) {
        const same =
          existing.source === 'import' &&
          existing.season_id === input.seasonId &&
          existing.team_id === input.teamId &&
          existing.division_id === input.divisionId &&
          existing.status === input.status &&
          iso(existing.applied_at) === iso(input.appliedAt) &&
          isoOrNull(existing.approved_at) === isoOrNull(input.approvedAt);
        if (same) return this.entries.entryViewById(trx, organizationId, id, this.clock.now());
        throw importContentMismatch({ teamEntryId: id, batchId: provenance.batchId });
      }
      await this.assertNotTakenElsewhere(trx, 'team_entries', id, provenance);
      const season = await loadSeasonRow(trx, organizationId, input.seasonId);
      if (!season) throw errors.notFound('season', input.seasonId);
      const team = await trx
        .selectFrom('teams')
        .select(['id', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.teamId)
        .executeTakeFirst();
      if (!team) throw errors.notFound('team', input.teamId);
      if (input.divisionId) {
        const division = await trx
          .selectFrom('divisions')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('season_id', '=', input.seasonId)
          .where('id', '=', input.divisionId)
          .executeTakeFirst();
        if (!division) throw errors.notFound('division', input.divisionId);
      }
      if (input.captainPersonId) {
        const captain = await this.people.loadPerson(trx, organizationId, input.captainPersonId);
        if (!captain) throw errors.notFound('person', input.captainPersonId);
      }
      const actor = json(snapshotActor(principal));
      try {
        await trx
          .insertInto('team_entries')
          .values({
            id,
            organization_id: organizationId,
            season_id: input.seasonId,
            division_id: input.divisionId,
            team_id: input.teamId,
            status: TeamEntryMachine.initial,
            applied_by: actor,
            applied_by_person_id: null,
            applied_at: input.appliedAt,
            renewed_from_entry_id: null,
            source: 'import',
          })
          .execute();
      } catch (error) {
        throw entryConstraintError(error, input);
      }
      const transitions: string[] = [TeamEntryMachine.initial];
      if (input.status === 'approved') {
        const next = TeamEntryMachine.next(TeamEntryMachine.initial, 'approve');
        try {
          await trx
            .updateTable('team_entries')
            .set({
              status: next,
              approved_at: input.approvedAt,
              approved_by: json(snapshotActor(principal)),
              revision: 2,
            })
            .where('organization_id', '=', organizationId)
            .where('id', '=', id)
            .where('revision', '=', 1)
            .execute();
        } catch (error) {
          throw entryConstraintError(error, input);
        }
        transitions.push(next);
      }
      if (input.captainPersonId) {
        await trx
          .insertInto('team_roles')
          .values({
            id: newId(),
            organization_id: organizationId,
            team_entry_id: id,
            person_id: input.captainPersonId,
            role: 'captain',
            effective_from: input.appliedAt,
            effective_to: null,
            assigned_by: json(snapshotActor(principal)),
            ended_by: null,
            ended_reason: null,
          })
          .execute();
      }
      await this.record(trx, principal, provenance, 'team_entry', id, correlationId, {
        seasonId: input.seasonId,
        teamId: input.teamId,
        transitions,
        approvedAt: isoOrNull(input.approvedAt),
        captainPersonId: input.captainPersonId,
      });
      return this.entries.entryViewById(trx, organizationId, id, this.clock.now());
    });
  }

  async importRosterMembership(
    principal: Principal,
    raw: WithProvenance<ImportRosterMembershipInput>,
    correlationId: string | null = null,
  ): Promise<RosterMember> {
    const { importProvenance: provenance, ...rest } = raw;
    const input = parse(ImportRosterMembershipInputSchema, rest, 'roster membership');
    const organizationId = await this.begin(principal, provenance, 'roster_membership');
    return this.uow.run(async ({ trx }) => {
      const id = provenance.recordId;
      const existing = await trx
        .selectFrom('roster_memberships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      const context = await loadEntryContext(trx, organizationId, input.teamEntryId, {
        forUpdate: true,
      });
      if (existing) {
        const status =
          existing.status === 'removed' ? existing.status_before_removal : existing.status;
        const same =
          existing.source === 'import' &&
          existing.team_entry_id === input.teamEntryId &&
          existing.person_id === input.personId &&
          status === input.status &&
          iso(existing.effective_from) === iso(input.effectiveFrom) &&
          isoOrNull(existing.effective_to) === isoOrNull(input.effectiveTo) &&
          existing.jersey_number === input.jerseyNumber;
        if (same && context) return this.memberView(trx, context, existing);
        throw importContentMismatch({ rosterMembershipId: id, batchId: provenance.batchId });
      }
      await this.assertNotTakenElsewhere(trx, 'roster_memberships', id, provenance);
      if (!context) throw errors.notFound('team_entry', input.teamEntryId);
      if (context.entry.status !== 'applied' && context.entry.status !== 'approved') {
        throw errors.invalidTransition(
          'TeamEntry',
          context.entry.status,
          'import_roster_membership',
        );
      }
      const person = await this.people.loadPerson(trx, organizationId, input.personId);
      if (!person) throw errors.notFound('person', input.personId);
      // Roster rules of the season's rule set (SPK-COMP-002/005), at the membership's own dates.
      const { rules } = context;
      assertJerseyInRange(rules, input.jerseyNumber);
      if (input.status === 'guest' && !rules.roster.guestPlayersAllowed) {
        throw errors.validation('The rule set does not allow guest players.', {
          code: 'guests_not_allowed',
        });
      }
      if (input.status === 'substitute' && !rules.roster.substitutesAllowed) {
        throw errors.validation('The rule set does not allow substitute memberships.', {
          code: 'substitutes_not_allowed',
        });
      }
      const from = new Date(input.effectiveFrom);
      const peak = peakRosterCounts(
        await rosterRowsOverlapping(trx, organizationId, input.teamEntryId, from),
        from,
      );
      if (ROSTER_LIMIT_STATUSES.includes(input.status) && peak.limited >= rules.rosterMax) {
        throw errors.validation(
          `The roster already has ${peak.limited} of ${rules.rosterMax} players at that date.`,
          { code: 'roster_full' },
        );
      }
      const ended = input.effectiveTo !== null;
      try {
        await trx
          .insertInto('roster_memberships')
          .values({
            id,
            organization_id: organizationId,
            team_entry_id: input.teamEntryId,
            person_id: input.personId,
            status: ended ? 'removed' : input.status,
            status_before_removal: ended ? input.status : null,
            effective_from: input.effectiveFrom,
            effective_to: input.effectiveTo,
            jersey_number: input.jerseyNumber,
            source: 'import',
            added_by: json(snapshotActor(principal)),
            added_by_person_id: null,
            removed_at: ended ? input.effectiveTo : null,
            removed_by: ended ? json(snapshotActor(principal)) : null,
            removal_reason: ended ? ENDED_IMPORT_REASON : null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          const constraint = pgConstraintName(error);
          throw errors.resourceConflict(
            constraint === 'roster_memberships_jersey_idx'
              ? 'That jersey number is already in use on this roster.'
              : 'The person already has an open roster row on this entry.',
            { constraint },
          );
        }
        throw error;
      }
      await this.record(trx, principal, provenance, 'roster_membership', id, correlationId, {
        teamEntryId: input.teamEntryId,
        personId: input.personId,
        status: input.status,
        effectiveFrom: iso(input.effectiveFrom),
        effectiveTo: isoOrNull(input.effectiveTo),
      });
      const row = await trx
        .selectFrom('roster_memberships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return this.memberView(trx, context, row);
    });
  }

  // -------------------------------------------------------------------------------------------
  private async begin(
    principal: Principal,
    provenance: ImportProvenance,
    type: string,
  ): Promise<string> {
    assertImportPrincipal(principal, provenance);
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.importRecords, {
      type,
      organizationId,
    });
    return organizationId;
  }

  /** A record id another organization already uses is never reused (§4.3). */
  private async assertNotTakenElsewhere(
    trx: Trx,
    table: 'seasons' | 'teams' | 'team_entries' | 'roster_memberships',
    id: string,
    provenance: ImportProvenance,
  ): Promise<void> {
    const taken = await trx.selectFrom(table).select('id').where('id', '=', id).executeTakeFirst();
    if (taken) throw importContentMismatch({ recordId: id, batchId: provenance.batchId });
  }

  private async sourceOf(
    trx: Trx,
    table: 'seasons',
    organizationId: string,
    id: string,
  ): Promise<string | null> {
    const row = await trx
      .selectFrom(table)
      .select('source')
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.source ?? null;
  }

  private async record(
    trx: Trx,
    principal: Principal,
    provenance: ImportProvenance,
    targetType: string,
    targetId: string,
    correlationId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId: organizationOf(principal),
      actor: principal,
      action: `competition.import_${targetType}`,
      targetType,
      targetId,
      afterRevision: 1,
      correlationId,
      details: {
        source: 'import',
        batchId: provenance.batchId,
        externalKey: provenance.externalKey,
        ...details,
      },
    });
  }

  private async memberView(
    trx: Trx,
    context: NonNullable<Awaited<ReturnType<typeof loadEntryContext>>>,
    row: Parameters<TeamEntriesService['rosterMembers']>[2][number],
  ): Promise<RosterMember> {
    const [member] = await this.entries.rosterMembers(trx, context, [row], this.clock.now(), {
      evaluate: false,
    });
    return member as RosterMember;
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown, label: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw errors.validation(
      `The imported ${label} is invalid.`,
      parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
        code: i.code,
      })),
    );
  }
  return parsed.data;
}

function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string =>
    JSON.stringify(v, (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)),
          )
        : value,
    );
  return canonical(a) === canonical(b);
}

function entryConstraintError(
  error: unknown,
  input: { teamId: string; seasonId: string; divisionId: string | null },
) {
  if (isUniqueViolation(error)) {
    return errors.duplicateEntitlement('This team already has a live entry in the season.', {
      teamId: input.teamId,
      seasonId: input.seasonId,
    });
  }
  if (isCheckViolation(error) && pgConstraintName(error) === 'team_entries_division_capacity') {
    return errors.capacityUnavailable('The division is full.', { divisionId: input.divisionId });
  }
  return error;
}
