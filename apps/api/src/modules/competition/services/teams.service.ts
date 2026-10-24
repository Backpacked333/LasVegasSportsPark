import { Inject, Injectable } from '@nestjs/common';
import { errors, type Principal, type Team, type UpdateTeamInput } from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
} from '../../../kernel';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import { isStaffLike, organizationOf, toTeam } from '../competition.shared';
import { TeamMachine, eventTo } from '../competition.state-machines';
import type { Reader } from '../competition.queries';

/**
 * The continuing team identity (§4.5 "Team must separate continuing identity from season entry").
 * A team is created with its first season entry; its details carry across renewals. Customers act
 * on it through the captain role of one of its live entries (never by having created it alone).
 */
@Injectable()
export class TeamsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async get(principal: Principal, id: string): Promise<Team> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('teams')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('team');
    if (!(await this.mayRead(principal, organizationId, id))) {
      throw errors.protectedNotFound('team');
    }
    return toTeam(row);
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateTeamInput,
    correlationId: string | null,
  ): Promise<Team> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('teams')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.protectedNotFound('team');
      await this.requireManage(principal, organizationId, id, trx);
      assertExpectedRevision(input.expectedRevision, current.revision);
      let status = current.status;
      if (input.status !== undefined && input.status !== current.status) {
        if (input.status === 'archived' && !isStaffLike(principal)) {
          throw errors.accessDenied('Only staff may archive a team.');
        }
        status = TeamMachine.next(
          current.status,
          eventTo(TeamMachine, current.status, input.status),
        );
      }
      const colors = input.colors === undefined ? current.colors : input.colors;
      await trx
        .updateTable('teams')
        .set({
          name: input.name ?? current.name,
          colors: json(colors),
          status,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.manageTeam.id,
        targetType: 'team',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { fields: Object.keys(input).filter((k) => k !== 'expectedRevision'), status },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.teamUpdated, {
        organizationId,
        aggregateType: 'team',
        aggregateId: id,
        payload: { teamId: id, status, revision: current.revision + 1 },
        correlationId,
      });
      const row = await trx
        .selectFrom('teams')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toTeam(row);
    });
  }

  /** Staff, or a person with an effective role or playing membership on any entry of the team. */
  private async mayRead(
    principal: Principal,
    organizationId: string,
    teamId: string,
  ): Promise<boolean> {
    const decision = await this.authorization.decide(principal, CompetitionActions.readTeamEntry, {
      type: 'team',
      id: teamId,
      organizationId,
    });
    if (decision.allowed) return true;
    if (!principal.personId) return false;
    const now = this.clock.now();
    const entries = await this.db
      .selectFrom('team_entries')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('team_id', '=', teamId)
      .execute();
    if (entries.length === 0) return false;
    const entryIds = entries.map((e) => e.id);
    const role = await this.db
      .selectFrom('team_roles')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('team_entry_id', 'in', entryIds)
      .where('person_id', '=', principal.personId)
      .where('effective_from', '<=', now)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
      .executeTakeFirst();
    if (role) return true;
    const membership = await this.db
      .selectFrom('roster_memberships')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('team_entry_id', 'in', entryIds)
      .where('person_id', '=', principal.personId)
      .where('status', 'in', ['active', 'guest', 'substitute'])
      .where('effective_to', 'is', null)
      .executeTakeFirst();
    if (!membership) return false;
    const self = await this.authorization.decide(principal, CompetitionActions.readTeamEntry, {
      type: 'team',
      id: teamId,
      organizationId,
      subjectPersonIds: [principal.personId],
    });
    return self.allowed;
  }

  /** Staff by role; a customer must be captain of a live entry of the team. */
  private async requireManage(
    principal: Principal,
    organizationId: string,
    teamId: string,
    db: Reader,
  ): Promise<void> {
    if (isStaffLike(principal)) {
      await this.authorization.require(principal, CompetitionActions.manageTeam, {
        type: 'team',
        id: teamId,
        organizationId,
      });
      return;
    }
    const live = await db
      .selectFrom('team_entries')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('team_id', '=', teamId)
      .where('status', 'in', ['applied', 'approved'])
      .execute();
    for (const entry of live) {
      const decision = await this.authorization.decide(principal, CompetitionActions.manageTeam, {
        type: 'team',
        id: teamId,
        organizationId,
        teamEntryId: entry.id,
      });
      if (decision.allowed) return;
    }
    throw errors.protectedNotFound('team');
  }
}
