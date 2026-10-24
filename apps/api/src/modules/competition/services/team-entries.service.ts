import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ApproveTeamEntryInput,
  type AvailabilitySummary,
  type CreateTeamEntryInput,
  type EligibilityEvaluation,
  type ListTeamEntriesQuery,
  type Principal,
  type RejectTeamEntryInput,
  type RosterMember,
  type RuleSetContent,
  type TeamEntry,
  type TeamEntryCreated,
  type TeamEntryWorkspace,
  type WithdrawTeamEntryInput,
} from '@sportspark/contracts';
import {
  isCheckViolation,
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type RosterPlayingStatus,
  type TeamEntriesTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PeopleService } from '../../identity';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import { WORKSPACE_UPCOMING_FIXTURES } from '../competition.policy';
import {
  countRoster,
  divisionEntryCount,
  effectiveRoles,
  loadEntryContext,
  loadSeasonRow,
  rolesByPerson,
  rosterRowsEffectiveAt,
  statusAt,
  type EntryContext,
  type Reader,
  type RosterRow,
} from '../competition.queries';
import {
  emptySummary,
  isStaffLike,
  organizationOf,
  toFixture,
  toJoinRequest,
  toRosterMember,
  toTeam,
  toTeamEntry,
  toTeamEntrySummary,
  toTeamInvitation,
  toTeamRole,
  type RosterFacts,
} from '../competition.shared';
import { TeamEntryMachine } from '../competition.state-machines';
import type { PersonEntryMembership, TeamEntryQueryPort, TeamEntrySummary } from '../ports';
import { EligibilityService } from './eligibility.service';
import { TeamAuthority } from './team-authority.service';

const CAPACITY_CONSTRAINT = 'team_entries_division_capacity';

export interface EntryViewer {
  /** Staff in scope, or a captain/co-captain: may see pending invitations and requests. */
  canManage: boolean;
}

/**
 * Season team entries (SPK-COMP-004, SPK-CAP-001/005, SPK-AT-002/003). An entry is one team's
 * participation in one season. Creating or renewing never charges: finance reacts to the event
 * and later records `financialStatusRef`. Approval, financial status, roster completion and
 * eligibility stay distinct fields; roster completion is derived on every read.
 */
@Injectable()
export class TeamEntriesService implements TeamEntryQueryPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly people: PeopleService,
    private readonly eligibility: EligibilityService,
    private readonly teamAuthority: TeamAuthority,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Create or renew (SPK-CAP-001, SPK-CAP-005)
  // -------------------------------------------------------------------------------------------
  async create(
    principal: Principal,
    input: CreateTeamEntryInput,
    correlationId: string | null,
  ): Promise<TeamEntryCreated> {
    const organizationId = organizationOf(principal);
    const staff = isStaffLike(principal);
    if (!staff && (input.teamId || input.captainPersonId || input.divisionId)) {
      throw errors.accessDenied(
        'Only staff may enter an existing team by id, name another captain or place an entry.',
      );
    }
    const now = this.clock.now();
    const entryId = newId();
    return this.uow.run(async ({ trx }) => {
      const season = await loadSeasonRow(trx, organizationId, input.seasonId);
      if (!season) throw errors.notFound('season', input.seasonId);
      if (season.status === 'completed' || season.status === 'archived') {
        throw errors.invalidTransition('Season', season.status, 'accept_entry');
      }
      if (!staff) {
        if (season.status !== 'open') {
          throw errors.eligibility('Registration for this season is not open.', {
            seasonStatus: season.status,
          });
        }
        const opens = season.registration_opens_at ? new Date(season.registration_opens_at) : null;
        const closes = season.registration_closes_at
          ? new Date(season.registration_closes_at)
          : null;
        if ((opens && now < opens) || (closes && now >= closes)) {
          throw errors.eligibility('The registration window for this season is closed.', {
            registrationOpensAt: opens?.toISOString() ?? null,
            registrationClosesAt: closes?.toISOString() ?? null,
          });
        }
      }

      let teamId: string;
      let teamCreated = false;
      let priorEntry: Selectable<TeamEntriesTable> | null = null;
      if (input.renewFromEntryId) {
        priorEntry =
          (await trx
            .selectFrom('team_entries')
            .selectAll()
            .where('organization_id', '=', organizationId)
            .where('id', '=', input.renewFromEntryId)
            .executeTakeFirst()) ?? null;
        if (!priorEntry) throw errors.protectedNotFound('team_entry');
        await this.authorization.require(principal, CompetitionActions.renewTeamEntry, {
          type: 'team_entry',
          id: priorEntry.id,
          organizationId,
          teamEntryId: priorEntry.id,
          protected: true,
        });
        teamId = priorEntry.team_id;
      } else if (input.teamId) {
        await this.authorization.require(principal, CompetitionActions.createTeamEntry, {
          type: 'team_entry',
          organizationId,
        });
        teamId = input.teamId;
      } else {
        if (!staff && !principal.personId) {
          throw errors.accessDenied('Link your account to a person before creating a team.');
        }
        await this.authorization.require(principal, CompetitionActions.createTeamEntry, {
          type: 'team_entry',
          organizationId,
          subjectPersonIds: staff ? [] : [principal.personId as string],
        });
        teamId = newId();
        teamCreated = true;
      }

      const captainPersonId = staff
        ? (input.captainPersonId ?? principal.personId)
        : principal.personId;
      if (!captainPersonId) {
        throw errors.validation('captainPersonId is required when the actor has no person.');
      }
      const captain = await this.people.loadPerson(trx, organizationId, captainPersonId);
      if (!captain || captain.status !== 'active') throw errors.notFound('person', captainPersonId);
      if (captain.kind !== 'adult') {
        // Proposed default pending the guardian/child-account policy decision (§6.6).
        throw errors.validation('A team captain must be an adult.');
      }

      if (teamCreated) {
        const team = input.team as NonNullable<CreateTeamEntryInput['team']>;
        await trx
          .insertInto('teams')
          .values({
            id: teamId,
            organization_id: organizationId,
            name: team.name,
            colors: json(team.colors ?? {}),
            created_by: json(snapshotActor(principal)),
            created_by_person_id: captainPersonId,
          })
          .execute();
      } else {
        const team = await trx
          .selectFrom('teams')
          .select(['id', 'status'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', teamId)
          .forUpdate()
          .executeTakeFirst();
        if (!team) throw errors.notFound('team', teamId);
        if (team.status === 'archived')
          throw errors.invalidTransition('Team', 'archived', 'enter_season');
      }

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

      try {
        await trx
          .insertInto('team_entries')
          .values({
            id: entryId,
            organization_id: organizationId,
            season_id: input.seasonId,
            division_id: input.divisionId ?? null,
            team_id: teamId,
            applied_by: json(snapshotActor(principal)),
            applied_by_person_id: principal.personId,
            applied_at: now,
            renewed_from_entry_id: priorEntry?.id ?? null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.duplicateEntitlement('This team already has a live entry in the season.', {
            teamId,
            seasonId: input.seasonId,
          });
        }
        if (isCheckViolation(error) && pgConstraintName(error) === CAPACITY_CONSTRAINT) {
          throw errors.capacityUnavailable('The division is full.', {
            divisionId: input.divisionId,
          });
        }
        throw error;
      }
      const roleId = newId();
      await trx
        .insertInto('team_roles')
        .values({
          id: roleId,
          organization_id: organizationId,
          team_entry_id: entryId,
          person_id: captainPersonId,
          role: 'captain',
          effective_from: now,
          effective_to: null,
          assigned_by: json(snapshotActor(principal)),
          ended_by: null,
          ended_reason: null,
        })
        .execute();

      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: priorEntry ? 'competition.renew_team_entry' : 'competition.create_team_entry',
        requestedBy: principal,
        correlationId,
        input: {
          seasonId: input.seasonId,
          teamId,
          renewFromEntryId: priorEntry?.id ?? null,
        },
        status: 'running',
      });
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: { teamEntryId: entryId, teamId, captainPersonId },
      });

      if (teamCreated) {
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: CompetitionActions.createTeamEntry.id,
          targetType: 'team',
          targetId: teamId,
          afterRevision: 1,
          correlationId,
          operationId,
          details: { operation: 'create_team' },
        });
        await this.outbox.enqueue(trx, CompetitionEvents.teamCreated, {
          organizationId,
          aggregateType: 'team',
          aggregateId: teamId,
          payload: { teamId, createdByPersonId: captainPersonId },
          correlationId,
          operationId,
        });
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: priorEntry
          ? CompetitionActions.renewTeamEntry.id
          : CompetitionActions.createTeamEntry.id,
        targetType: 'team_entry',
        targetId: entryId,
        afterRevision: 1,
        correlationId,
        operationId,
        details: {
          seasonId: input.seasonId,
          teamId,
          renewedFromEntryId: priorEntry?.id ?? null,
          divisionId: input.divisionId ?? null,
          captainRoleId: roleId,
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.teamEntryCreated, {
        organizationId,
        aggregateType: 'team_entry',
        aggregateId: entryId,
        payload: {
          teamEntryId: entryId,
          seasonId: input.seasonId,
          teamId,
          captainPersonId,
          renewedFromEntryId: priorEntry?.id ?? null,
          registrationOfferingRef: season.registration_offering_ref,
          operationId,
        },
        correlationId,
        operationId,
      });
      await this.outbox.enqueue(trx, CompetitionEvents.teamRoleChanged, {
        organizationId,
        aggregateType: 'team_entry',
        aggregateId: entryId,
        payload: {
          teamEntryId: entryId,
          personId: captainPersonId,
          role: 'captain',
          change: 'assigned',
        },
        correlationId,
        operationId,
      });

      const context = await loadEntryContext(trx, organizationId, entryId);
      if (!context) throw errors.internal('team entry vanished after insert');
      return {
        entry: await this.entryView(trx, context, now),
        team: toTeam(context.team),
        operationId,
        renewedFromEntryId: priorEntry?.id ?? null,
        suggestedPlayers: priorEntry
          ? await this.suggestedPlayers(trx, organizationId, priorEntry.id)
          : [],
      };
    });
  }

  /** Prior players as suggestions only (SPK-CAP-005): each is re-evaluated when the captain adds them. */
  private async suggestedPlayers(
    db: Reader,
    organizationId: string,
    priorEntryId: string,
  ): Promise<TeamEntryCreated['suggestedPlayers']> {
    const rows = await db
      .selectFrom('roster_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('team_entry_id', '=', priorEntryId)
      .where('status', 'in', ['active', 'guest', 'substitute', 'removed'])
      .orderBy('effective_from', 'desc')
      .execute();
    const seen = new Map<string, RosterRow>();
    for (const row of rows) if (!seen.has(row.person_id)) seen.set(row.person_id, row);
    const out: TeamEntryCreated['suggestedPlayers'] = [];
    for (const row of seen.values()) {
      const status = statusAt(row);
      const person = await this.people.loadPerson(db, organizationId, row.person_id);
      if (!status || !person || person.status !== 'active') continue;
      out.push({
        personId: row.person_id,
        displayName: `${person.given_name} ${person.family_name}`,
        lastStatus: status,
        lastEffectiveTo: row.effective_to ? new Date(row.effective_to).toISOString() : null,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Approval lifecycle (SPK-COMP-004)
  // -------------------------------------------------------------------------------------------
  async approve(
    principal: Principal,
    id: string,
    input: ApproveTeamEntryInput,
    correlationId: string | null,
  ): Promise<TeamEntry> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, id, { forUpdate: true });
      if (!context) throw errors.protectedNotFound('team_entry');
      const { entry } = context;
      await this.authorization.require(principal, CompetitionActions.approveTeamEntry, {
        type: 'team_entry',
        id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, entry.revision);
      const next = TeamEntryMachine.next(entry.status, 'approve');
      const divisionId = input.divisionId ?? entry.division_id;
      if (input.divisionId && input.divisionId !== entry.division_id) {
        await this.assertDivisionHasRoom(trx, organizationId, entry, input.divisionId);
      }
      try {
        await trx
          .updateTable('team_entries')
          .set({
            status: next,
            division_id: divisionId,
            approved_at: now,
            approved_by: json(snapshotActor(principal)),
            approval_note: input.note ?? null,
            revision: entry.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .where('revision', '=', entry.revision)
          .execute();
      } catch (error) {
        if (isCheckViolation(error) && pgConstraintName(error) === CAPACITY_CONSTRAINT) {
          throw errors.capacityUnavailable('The division is full.', { divisionId });
        }
        throw error;
      }
      await this.recordStatusChange(
        trx,
        principal,
        context,
        next,
        divisionId,
        input.reason ?? input.note ?? null,
        correlationId,
        CompetitionActions.approveTeamEntry.id,
      );
      return this.entryViewById(trx, organizationId, id, now);
    });
  }

  async reject(
    principal: Principal,
    id: string,
    input: RejectTeamEntryInput,
    correlationId: string | null,
  ): Promise<TeamEntry> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, id, { forUpdate: true });
      if (!context) throw errors.protectedNotFound('team_entry');
      const { entry } = context;
      await this.authorization.require(principal, CompetitionActions.approveTeamEntry, {
        type: 'team_entry',
        id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, entry.revision);
      const next = TeamEntryMachine.next(entry.status, 'reject');
      await trx
        .updateTable('team_entries')
        .set({
          status: next,
          rejected_at: now,
          rejected_by: json(snapshotActor(principal)),
          rejection_reason: input.reason,
          revision: entry.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', entry.revision)
        .execute();
      await this.recordStatusChange(
        trx,
        principal,
        context,
        next,
        entry.division_id,
        input.reason,
        correlationId,
        CompetitionActions.approveTeamEntry.id,
      );
      return this.entryViewById(trx, organizationId, id, now);
    });
  }

  async withdraw(
    principal: Principal,
    id: string,
    input: WithdrawTeamEntryInput,
    correlationId: string | null,
  ): Promise<TeamEntry> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, id, { forUpdate: true });
      if (!context) throw errors.protectedNotFound('team_entry');
      const { entry } = context;
      await this.authorization.require(principal, CompetitionActions.withdrawTeamEntry, {
        type: 'team_entry',
        id,
        organizationId,
        teamEntryId: id,
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, entry.revision);
      const next = TeamEntryMachine.next(entry.status, 'withdraw');
      await trx
        .updateTable('team_entries')
        .set({
          status: next,
          withdrawn_at: now,
          withdrawn_by: json(snapshotActor(principal)),
          withdrawal_reason: input.reason,
          revision: entry.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', entry.revision)
        .execute();
      await this.recordStatusChange(
        trx,
        principal,
        context,
        next,
        entry.division_id,
        input.reason,
        correlationId,
        CompetitionActions.withdrawTeamEntry.id,
      );
      return this.entryViewById(trx, organizationId, id, now);
    });
  }

  private async assertDivisionHasRoom(
    trx: Trx,
    organizationId: string,
    entry: Selectable<TeamEntriesTable>,
    divisionId: string,
  ): Promise<void> {
    const division = await trx
      .selectFrom('divisions')
      .select(['id', 'capacity_team_entries'])
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', entry.season_id)
      .where('id', '=', divisionId)
      .forUpdate()
      .executeTakeFirst();
    if (!division) throw errors.notFound('division', divisionId);
    if (division.capacity_team_entries === null) return;
    const occupied = await divisionEntryCount(trx, organizationId, divisionId);
    if (occupied >= division.capacity_team_entries) {
      throw errors.capacityUnavailable('The division is full.', {
        divisionId,
        capacity: division.capacity_team_entries,
        occupied,
      });
    }
  }

  private async recordStatusChange(
    trx: Trx,
    principal: Principal,
    context: EntryContext,
    status: TeamEntry['status'],
    divisionId: string | null,
    reason: string | null,
    correlationId: string | null,
    action: string,
  ): Promise<void> {
    const { entry } = context;
    await this.audit.record(trx, {
      organizationId: entry.organization_id,
      actor: principal,
      action,
      targetType: 'team_entry',
      targetId: entry.id,
      beforeRevision: entry.revision,
      afterRevision: entry.revision + 1,
      reason,
      correlationId,
      details: { status, previousStatus: entry.status, divisionId },
    });
    await this.outbox.enqueue(trx, CompetitionEvents.teamEntryStatusChanged, {
      organizationId: entry.organization_id,
      aggregateType: 'team_entry',
      aggregateId: entry.id,
      payload: {
        teamEntryId: entry.id,
        seasonId: entry.season_id,
        teamId: entry.team_id,
        status,
        previousStatus: entry.status,
        divisionId,
        reason,
      },
      correlationId,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------
  async list(principal: Principal, query: ListTeamEntriesQuery): Promise<TeamEntry[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.listTeamEntries, {
      type: 'team_entry',
      organizationId,
    });
    const now = this.clock.now();
    let q = this.db
      .selectFrom('team_entries')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', query.seasonId)
      .orderBy('applied_at')
      .orderBy('id');
    if (query.divisionId) q = q.where('division_id', '=', query.divisionId);
    if (query.status) q = q.where('status', '=', query.status);
    const rows = await q.execute();
    const out: TeamEntry[] = [];
    for (const row of rows) {
      const context = await loadEntryContext(this.db, organizationId, row.id);
      if (context) out.push(await this.entryView(this.db, context, now));
    }
    return out;
  }

  /** Captain workspace (SPK-CAP-001/002): readiness indicators, never private family details. */
  async getWorkspace(principal: Principal, id: string): Promise<TeamEntryWorkspace> {
    const organizationId = organizationOf(principal);
    const db = this.db;
    const context = await loadEntryContext(db, organizationId, id);
    if (!context) throw errors.protectedNotFound('team_entry');
    const now = this.clock.now();
    const playing = await rosterRowsEffectiveAt(db, organizationId, id, now);
    const roleRows = await effectiveRoles(db, organizationId, id, now);
    const viewer = await this.viewerOf(principal, context, playing, roleRows, now);

    const pending = await db
      .selectFrom('roster_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('team_entry_id', '=', id)
      .where('status', 'in', ['invited', 'requested'])
      .where('effective_to', 'is', null)
      .orderBy('effective_from')
      .execute();
    const roster = await this.rosterMembers(db, context, [...playing, ...pending], now);
    const counts = countRoster(playing);
    const { rules } = context;
    const eligiblePlayers = roster.filter(
      (m) => statusOf(m) !== null && m.eligibility?.status === 'eligible',
    ).length;
    const ineligible = roster.filter(
      (m) => statusOf(m) !== null && m.eligibility?.status === 'ineligible',
    );
    const unknown = roster.filter(
      (m) => statusOf(m) !== null && m.eligibility?.status === 'unknown',
    );

    const [pendingInvitations, pendingJoinRequests] = await Promise.all([
      db
        .selectFrom('team_invitations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('team_entry_id', '=', id)
        .where('status', '=', 'pending')
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('join_requests')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('team_entry_id', '=', id)
        .where('status', '=', 'pending')
        .orderBy('created_at')
        .execute(),
    ]);

    const issues: TeamEntryWorkspace['readiness']['issues'] = [];
    if (context.entry.status !== 'approved') {
      issues.push({
        code: context.entry.status === 'applied' ? 'entry_not_approved' : 'entry_not_active',
        severity: 'blocking',
        message: `The entry is ${context.entry.status}.`,
        responsibleRole: 'league_manager',
        requiredAction:
          context.entry.status === 'applied' ? 'Approve the entry.' : 'Create a new entry.',
      });
    }
    if (context.entry.financial_status_ref === null) {
      issues.push({
        code: 'financial_status_unknown',
        severity: 'unknown',
        message: 'No financial obligation has been recorded for this entry yet.',
        responsibleRole: 'finance_operator',
        requiredAction: 'Finance records the entry obligation.',
      });
    }
    if (counts.limited < rules.rosterMin) {
      issues.push({
        code: 'roster_below_minimum',
        severity: 'blocking',
        message: `${counts.limited} of the required ${rules.rosterMin} players are on the roster.`,
        responsibleRole: 'captain',
        requiredAction: `Add ${rules.rosterMin - counts.limited} more eligible player(s).`,
      });
    }
    if (ineligible.length > 0) {
      issues.push({
        code: 'ineligible_players',
        severity: 'warning',
        message: `${ineligible.length} roster player(s) are currently ineligible.`,
        responsibleRole: 'captain',
        requiredAction: 'Resolve the listed reasons or remove the players.',
      });
    }
    if (unknown.length > 0) {
      issues.push({
        code: 'eligibility_unknown',
        severity: 'unknown',
        message: `${unknown.length} roster player(s) have incomplete records for eligibility.`,
        responsibleRole: 'front_desk',
        requiredAction: 'Complete the person records (for example the date of birth).',
      });
    }
    if (pendingJoinRequests.length > 0) {
      issues.push({
        code: 'join_requests_pending',
        severity: 'info',
        message: `${pendingJoinRequests.length} join request(s) await a decision.`,
        responsibleRole: 'captain',
        requiredAction: 'Approve or decline the requests.',
      });
    }

    return {
      entry: await this.entryView(db, context, now),
      team: toTeam(context.team),
      season: {
        id: context.season.id,
        name: context.season.name,
        status: context.season.status,
        startsOn: context.season.starts_on,
        endsOn: context.season.ends_on,
      },
      division: context.division ? { id: context.division.id, name: context.division.name } : null,
      ruleSet: {
        id: context.ruleSet.id,
        name: context.ruleSet.name,
        version: context.ruleSet.version,
      },
      roles: roleRows.map(toTeamRole),
      roster,
      readiness: {
        approval: context.entry.status,
        financialStatusRef: context.entry.financial_status_ref,
        rosterCount: counts.limited,
        rosterMin: rules.rosterMin,
        rosterMax: rules.rosterMax,
        rosterComplete: counts.limited >= rules.rosterMin && counts.limited <= rules.rosterMax,
        eligiblePlayers,
        pendingInvitations: pendingInvitations.length,
        pendingJoinRequests: pendingJoinRequests.length,
        issues,
      },
      pendingInvitations: viewer.canManage ? pendingInvitations.map(toTeamInvitation) : [],
      pendingJoinRequests: viewer.canManage ? pendingJoinRequests.map(toJoinRequest) : [],
      upcomingFixtures: await this.upcomingFixtures(db, context, principal, counts.total, now),
    };
  }

  /**
   * Who may see an entry: staff in scope, an effective role holder, a current roster player, or a
   * guardian holding `view` over a child on the roster. Anyone else gets not-found (§4.10).
   */
  async viewerOf(
    principal: Principal,
    context: EntryContext,
    playing: RosterRow[],
    roleRows: Awaited<ReturnType<typeof effectiveRoles>>,
    now: Date,
  ): Promise<EntryViewer> {
    const organizationId = context.entry.organization_id;
    const id = context.entry.id;
    const base = { type: 'team_entry', id, organizationId, teamEntryId: id, protected: true };
    const direct = await this.authorization.decide(
      principal,
      CompetitionActions.readTeamEntry,
      base,
    );
    if (direct.allowed) {
      const canManage = isStaffLike(principal)
        ? true
        : principal.personId !== null &&
          (await this.teamAuthority.hasTeamRole(
            organizationId,
            principal.personId,
            id,
            'co_captain',
          ));
      return { canManage };
    }
    if (!principal.personId) throw errors.protectedNotFound('team_entry');
    const personId = principal.personId;
    const rosterPersons = new Set<string>([
      ...playing.map((r) => r.person_id),
      ...roleRows.filter((r) => isEffective(r, now)).map((r) => r.person_id),
    ]);
    if (rosterPersons.has(personId)) {
      const self = await this.authorization.decide(principal, CompetitionActions.readTeamEntry, {
        ...base,
        subjectPersonIds: [personId],
      });
      if (self.allowed) return { canManage: false };
    }
    for (const subject of rosterPersons) {
      if (subject === personId) continue;
      const person = await this.people.loadPerson(this.db, organizationId, subject);
      if (!person || person.kind !== 'child') continue;
      const guardian = await this.authorization.decide(
        principal,
        CompetitionActions.readTeamEntry,
        {
          ...base,
          subjectPersonIds: [subject],
        },
      );
      if (guardian.allowed) return { canManage: false };
    }
    throw errors.protectedNotFound('team_entry');
  }

  /** Roster rows as members with readiness indicators (codes only, no private details). */
  async rosterMembers(
    db: Reader,
    context: EntryContext,
    rows: RosterRow[],
    at: Date,
    options: { evaluate?: boolean } = {},
  ): Promise<RosterMember[]> {
    const evaluate = options.evaluate ?? true;
    const out: RosterMember[] = [];
    for (const row of rows) {
      const person = await this.people.loadPerson(db, context.entry.organization_id, row.person_id);
      const status = statusAt(row);
      let indicator: RosterMember['eligibility'] = null;
      if (evaluate && status && person) {
        const evaluation = await this.eligibility.evaluateInContext(
          db,
          context,
          row.person_id,
          at,
          {
            membershipStatus: status,
            existingMembership: true,
            actorIsStaff: true,
          },
        );
        indicator = indicatorOf(evaluation);
      }
      out.push(
        toRosterMember(
          row,
          person ?? { given_name: 'Unknown', family_name: 'person', kind: 'adult' },
          indicator,
        ),
      );
    }
    return out;
  }

  private async upcomingFixtures(
    db: Reader,
    context: EntryContext,
    principal: Principal,
    rosterSize: number,
    now: Date,
  ): Promise<TeamEntryWorkspace['upcomingFixtures']> {
    const organizationId = context.entry.organization_id;
    const id = context.entry.id;
    const rows = await db
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where((eb) => eb.or([eb('home_entry_id', '=', id), eb('away_entry_id', '=', id)]))
      .where('status', 'in', ['unscheduled', 'scheduled', 'postponed'])
      .where((eb) => eb.or([eb('scheduled_start', 'is', null), eb('scheduled_start', '>=', now)]))
      .orderBy(sql`scheduled_start asc nulls last`)
      .orderBy('id')
      .limit(WORKSPACE_UPCOMING_FIXTURES)
      .execute();
    const out: TeamEntryWorkspace['upcomingFixtures'] = [];
    for (const row of rows) {
      const side = row.home_entry_id === id ? 'home' : 'away';
      const opponentId = side === 'home' ? row.away_entry_id : row.home_entry_id;
      let opponent: { entryId: string; teamName: string } | null = null;
      if (opponentId) {
        const team = await db
          .selectFrom('team_entries')
          .innerJoin('teams', (join) =>
            join
              .onRef('teams.organization_id', '=', 'team_entries.organization_id')
              .onRef('teams.id', '=', 'team_entries.team_id'),
          )
          .select('teams.name')
          .where('team_entries.organization_id', '=', organizationId)
          .where('team_entries.id', '=', opponentId)
          .executeTakeFirst();
        opponent = { entryId: opponentId, teamName: team?.name ?? 'Unknown team' };
      }
      const { summary, mine } = await this.availabilityOf(
        db,
        organizationId,
        row.id,
        id,
        rosterSize,
        principal.personId,
      );
      out.push({
        fixture: toFixture(row),
        side,
        opponent,
        availability: summary,
        myResponse: mine,
      });
    }
    return out;
  }

  /** RSVP summary for one side of a fixture (SPK-CAP-003): responses plus the players who have not answered. */
  async availabilityOf(
    db: Reader,
    organizationId: string,
    fixtureId: string,
    teamEntryId: string,
    rosterSize: number,
    personId: string | null,
  ): Promise<{
    summary: AvailabilitySummary;
    mine: TeamEntryWorkspace['upcomingFixtures'][number]['myResponse'];
  }> {
    const responses = await db
      .selectFrom('availability_responses')
      .select(['person_id', 'state'])
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .where('team_entry_id', '=', teamEntryId)
      .execute();
    const summary = emptySummary();
    let mine: TeamEntryWorkspace['upcomingFixtures'][number]['myResponse'] = null;
    for (const r of responses) {
      if (r.state === 'available') summary.available += 1;
      else if (r.state === 'unavailable') summary.unavailable += 1;
      else if (r.state === 'tentative') summary.tentative += 1;
      if (personId && r.person_id === personId) mine = r.state;
    }
    const answered = summary.available + summary.unavailable + summary.tentative;
    summary.noResponse = Math.max(0, rosterSize - answered);
    return { summary, mine };
  }

  async entryView(db: Reader, context: EntryContext, at: Date): Promise<TeamEntry> {
    return toTeamEntry(context.entry, await this.rosterFacts(db, context, at));
  }

  async entryViewById(
    db: Reader,
    organizationId: string,
    id: string,
    at: Date,
  ): Promise<TeamEntry> {
    const context = await loadEntryContext(db, organizationId, id);
    if (!context) throw errors.protectedNotFound('team_entry');
    return this.entryView(db, context, at);
  }

  async rosterFacts(db: Reader, context: EntryContext, at: Date): Promise<RosterFacts> {
    const rows = await rosterRowsEffectiveAt(
      db,
      context.entry.organization_id,
      context.entry.id,
      at,
    );
    const counts = countRoster(rows);
    return rosterFactsOf(counts.limited, context.rules);
  }

  // -------------------------------------------------------------------------------------------
  // Finance hook: the obligation reference is recorded by finance (SPK-COMP-004 "financial status").
  // -------------------------------------------------------------------------------------------
  async recordFinancialStatusRef(
    trx: Trx,
    principal: Principal,
    teamEntryId: string,
    financialStatusRef: string,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = organizationOf(principal);
    const entry = await trx
      .selectFrom('team_entries')
      .select(['id', 'revision', 'financial_status_ref'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', teamEntryId)
      .forUpdate()
      .executeTakeFirst();
    if (!entry) throw errors.notFound('team_entry', teamEntryId);
    if (entry.financial_status_ref === financialStatusRef) return;
    await trx
      .updateTable('team_entries')
      .set({ financial_status_ref: financialStatusRef, revision: entry.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', teamEntryId)
      .where('revision', '=', entry.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: 'competition.record_financial_status',
      targetType: 'team_entry',
      targetId: teamEntryId,
      beforeRevision: entry.revision,
      afterRevision: entry.revision + 1,
      correlationId,
      details: { financialStatusRef },
    });
  }

  // -------------------------------------------------------------------------------------------
  // TeamEntryQueryPort
  // -------------------------------------------------------------------------------------------
  async findTeamEntry(
    organizationId: string,
    teamEntryId: string,
    trx?: Trx,
  ): Promise<TeamEntrySummary | null> {
    const context = await loadEntryContext(trx ?? this.db, organizationId, teamEntryId);
    if (!context) return null;
    return toTeamEntrySummary(context.entry, context.team, context.season.competition_id);
  }

  async listSeasonEntries(
    organizationId: string,
    seasonId: string,
    trx?: Trx,
  ): Promise<TeamEntrySummary[]> {
    const db = trx ?? this.db;
    const rows = await db
      .selectFrom('team_entries')
      .innerJoin('teams', (join) =>
        join
          .onRef('teams.organization_id', '=', 'team_entries.organization_id')
          .onRef('teams.id', '=', 'team_entries.team_id'),
      )
      .innerJoin('seasons', (join) =>
        join
          .onRef('seasons.organization_id', '=', 'team_entries.organization_id')
          .onRef('seasons.id', '=', 'team_entries.season_id'),
      )
      .selectAll('team_entries')
      .select(['teams.name as team_name', 'seasons.competition_id as competition_id'])
      .where('team_entries.organization_id', '=', organizationId)
      .where('team_entries.season_id', '=', seasonId)
      .orderBy('team_entries.applied_at')
      .execute();
    return rows.map((r) => toTeamEntrySummary(r, { name: r.team_name }, r.competition_id));
  }

  async entriesOfPerson(
    organizationId: string,
    personId: string,
    at: Date,
    trx?: Trx,
  ): Promise<PersonEntryMembership[]> {
    const db = trx ?? this.db;
    const memberships = await db
      .selectFrom('roster_memberships as rm')
      .innerJoin('team_entries as te', (join) =>
        join
          .onRef('te.organization_id', '=', 'rm.organization_id')
          .onRef('te.id', '=', 'rm.team_entry_id'),
      )
      .select(['rm.team_entry_id', 'te.season_id', 'rm.status', 'rm.status_before_removal'])
      .where('rm.organization_id', '=', organizationId)
      .where('rm.person_id', '=', personId)
      .where('rm.status', 'in', ['active', 'guest', 'substitute', 'removed'])
      .where('rm.effective_from', '<=', at)
      .where((eb) => eb.or([eb('rm.effective_to', 'is', null), eb('rm.effective_to', '>', at)]))
      .execute();
    const roles = await db
      .selectFrom('team_roles as tr')
      .innerJoin('team_entries as te', (join) =>
        join
          .onRef('te.organization_id', '=', 'tr.organization_id')
          .onRef('te.id', '=', 'tr.team_entry_id'),
      )
      .select(['tr.team_entry_id', 'te.season_id', 'tr.role'])
      .where('tr.organization_id', '=', organizationId)
      .where('tr.person_id', '=', personId)
      .where('tr.effective_from', '<=', at)
      .where((eb) => eb.or([eb('tr.effective_to', 'is', null), eb('tr.effective_to', '>', at)]))
      .execute();
    const byEntry = new Map<string, PersonEntryMembership>();
    for (const m of memberships) {
      const status =
        m.status === 'removed' ? m.status_before_removal : (m.status as RosterPlayingStatus);
      byEntry.set(m.team_entry_id, {
        teamEntryId: m.team_entry_id,
        seasonId: m.season_id,
        membershipStatus: status,
        roles: [],
      });
    }
    for (const r of roles) {
      const existing = byEntry.get(r.team_entry_id) ?? {
        teamEntryId: r.team_entry_id,
        seasonId: r.season_id,
        membershipStatus: null,
        roles: [],
      };
      existing.roles.push(r.role);
      byEntry.set(r.team_entry_id, existing);
    }
    return [...byEntry.values()];
  }
}

export function rosterFactsOf(count: number, rules: RuleSetContent): RosterFacts {
  return { rosterCount: count, rosterMin: rules.rosterMin, rosterMax: rules.rosterMax };
}

export function indicatorOf(
  evaluation: EligibilityEvaluation,
): NonNullable<RosterMember['eligibility']> {
  const blocking = evaluation.reasons.filter((r) => r.severity === 'blocking').length;
  const unknown = evaluation.reasons.filter((r) => r.severity === 'unknown').length;
  const warnings = evaluation.reasons.filter((r) => r.severity === 'warning').length;
  return {
    status: evaluation.eligible
      ? 'eligible'
      : blocking === 0 && unknown > 0
        ? 'unknown'
        : 'ineligible',
    blocking,
    warnings,
    codes: evaluation.reasons.map((r) => r.code),
  };
}

function statusOf(member: RosterMember): RosterPlayingStatus | null {
  if (member.status === 'removed') return member.statusBeforeRemoval;
  if (member.status === 'active' || member.status === 'guest' || member.status === 'substitute') {
    return member.status;
  }
  return null;
}

function isEffective(
  row: { effective_from: Date | string; effective_to: Date | string | null },
  at: Date,
): boolean {
  const from = new Date(row.effective_from).getTime();
  const to =
    row.effective_to === null ? Number.POSITIVE_INFINITY : new Date(row.effective_to).getTime();
  return from <= at.getTime() && at.getTime() < to;
}

export { rolesByPerson };
