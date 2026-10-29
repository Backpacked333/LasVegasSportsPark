import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AddPoolEntryInput,
  type CreatePoolInput,
  type Pool,
  type Principal,
  type RemovePoolEntryInput,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type PoolsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  databaseConstraintOf,
  executorFor,
  snapshotActor,
  type Trx,
} from '../../../kernel';
import { MatchActions } from '../competition-matches.actions';
import { MatchEvents } from '../competition-matches.events';
import { loadSeasonRow, teamNamesOf, type Reader } from '../competition.queries';
import { iso, organizationOf } from '../competition.shared';
import { readTarget } from './competitions.service';

/**
 * Tournament pools (CMP-15; §3.16 Tournaments: pools, seeding, brackets; DEC-016, DEC-078). A
 * pool splits a division's entries; its standings (StandingsService.poolTable) seed bracket nodes.
 * Creating a pool and placing an entry are new commitments of the `tournaments` capability: they
 * are refused (ACCESS_DENIED CAPABILITY_DISABLED) while the organization has not enabled it.
 * Removing an entry unwinds and is never gated; reads and seeding from existing pools are never
 * gated either. The database keeps a pool entry inside its pool's season and division and an
 * entry in at most one pool of its division (migration 0459).
 */
@Injectable()
export class PoolsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: CapabilityService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async create(
    principal: Principal,
    divisionId: string,
    input: CreatePoolInput,
    correlationId: string | null,
  ): Promise<Pool> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const division = await trx
        .selectFrom('divisions')
        .select(['id', 'season_id', 'facility_id'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', divisionId)
        .executeTakeFirst();
      if (!division) throw errors.notFound('division', divisionId);
      await this.authorization.require(principal, MatchActions.managePools, {
        type: 'pool',
        organizationId,
        facilityId: division.facility_id,
      });
      await this.capabilities.require(organizationId, 'tournaments', trx);
      const id = newId();
      try {
        await trx
          .insertInto('pools')
          .values({
            id,
            organization_id: organizationId,
            season_id: division.season_id,
            division_id: divisionId,
            name: input.name,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A pool with this name already exists in the division.', {
            constraint: pgConstraintName(error),
          });
        }
        throw error;
      }
      await this.recordChange(trx, principal, {
        poolId: id,
        seasonId: division.season_id,
        divisionId,
        change: 'created',
        teamEntryId: null,
        beforeRevision: null,
        revision: 1,
        reason: input.reason ?? null,
        correlationId,
      });
      return this.view(trx, organizationId, id);
    });
  }

  async addEntry(
    principal: Principal,
    poolId: string,
    input: AddPoolEntryInput,
    correlationId: string | null,
  ): Promise<Pool> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const pool = await this.lockPool(trx, organizationId, poolId);
      await this.authorization.require(principal, MatchActions.managePools, {
        type: 'pool',
        id: poolId,
        organizationId,
        facilityId: await this.facilityOf(trx, organizationId, pool.division_id),
      });
      await this.capabilities.require(organizationId, 'tournaments', trx);
      assertExpectedRevision(input.expectedRevision, pool.revision);
      const entry = await trx
        .selectFrom('team_entries')
        .select(['id', 'status', 'season_id', 'division_id'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.teamEntryId)
        .executeTakeFirst();
      if (!entry) throw errors.notFound('team_entry', input.teamEntryId);
      if (entry.status !== 'applied' && entry.status !== 'approved') {
        throw errors.invalidTransition('TeamEntry', entry.status, 'join_pool');
      }
      try {
        await trx
          .insertInto('pool_entries')
          .values({
            organization_id: organizationId,
            pool_id: poolId,
            season_id: pool.season_id,
            division_id: pool.division_id,
            team_entry_id: input.teamEntryId,
            seed: input.seed ?? null,
            added_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        const constraint = databaseConstraintOf(error);
        if (constraint?.code === '23505') {
          throw errors.resourceConflict('The entry is already in a pool of this division.', {
            code: 'ENTRY_ALREADY_POOLED',
            teamEntryId: input.teamEntryId,
          });
        }
        if (constraint?.code === '23503') {
          throw errors.validation("The entry is not in the pool's season and division.", {
            code: 'ENTRY_OUTSIDE_POOL_DIVISION',
            teamEntryId: input.teamEntryId,
            divisionId: pool.division_id,
          });
        }
        throw error;
      }
      const revision = await this.bump(trx, pool);
      await this.recordChange(trx, principal, {
        poolId,
        seasonId: pool.season_id,
        divisionId: pool.division_id,
        change: 'entry_added',
        teamEntryId: input.teamEntryId,
        beforeRevision: pool.revision,
        revision,
        reason: input.reason ?? null,
        correlationId,
        seed: input.seed ?? null,
      });
      return this.view(trx, organizationId, poolId);
    });
  }

  /** Unwinding: never gated by the capability (IF-30). */
  async removeEntry(
    principal: Principal,
    poolId: string,
    teamEntryId: string,
    input: RemovePoolEntryInput,
    correlationId: string | null,
  ): Promise<Pool> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const pool = await this.lockPool(trx, organizationId, poolId);
      await this.authorization.require(principal, MatchActions.managePools, {
        type: 'pool',
        id: poolId,
        organizationId,
        facilityId: await this.facilityOf(trx, organizationId, pool.division_id),
      });
      assertExpectedRevision(input.expectedRevision, pool.revision);
      const removed = await trx
        .deleteFrom('pool_entries')
        .where('organization_id', '=', organizationId)
        .where('pool_id', '=', poolId)
        .where('team_entry_id', '=', teamEntryId)
        .executeTakeFirst();
      if (Number(removed.numDeletedRows) === 0) throw errors.notFound('pool_entry', teamEntryId);
      const revision = await this.bump(trx, pool);
      await this.recordChange(trx, principal, {
        poolId,
        seasonId: pool.season_id,
        divisionId: pool.division_id,
        change: 'entry_removed',
        teamEntryId,
        beforeRevision: pool.revision,
        revision,
        reason: input.reason,
        correlationId,
      });
      return this.view(trx, organizationId, poolId);
    });
  }

  /** `GET /v1/pools/{id}`: read with the season's read action, never gated. */
  async get(principal: Principal, poolId: string): Promise<Pool> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const pool = await db
      .selectFrom('pools')
      .select(['id', 'season_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', poolId)
      .executeTakeFirst();
    if (!pool) throw errors.notFound('pool', poolId);
    const season = await loadSeasonRow(db, organizationId, pool.season_id);
    if (!season) throw errors.notFound('pool', poolId);
    await this.authorization.require(
      principal,
      MatchActions.readBrackets,
      readTarget(principal, 'season', pool.season_id, organizationId),
    );
    return this.view(db, organizationId, poolId);
  }

  private async lockPool(
    trx: Trx,
    organizationId: string,
    poolId: string,
  ): Promise<Selectable<PoolsTable>> {
    const pool = await trx
      .selectFrom('pools')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', poolId)
      .forUpdate()
      .executeTakeFirst();
    if (!pool) throw errors.notFound('pool', poolId);
    return pool;
  }

  private async facilityOf(
    db: Reader,
    organizationId: string,
    divisionId: string,
  ): Promise<string | null> {
    const division = await db
      .selectFrom('divisions')
      .select('facility_id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', divisionId)
      .executeTakeFirst();
    return division?.facility_id ?? null;
  }

  private async bump(trx: Trx, pool: Selectable<PoolsTable>): Promise<number> {
    const updated = await trx
      .updateTable('pools')
      .set({ revision: pool.revision + 1 })
      .where('organization_id', '=', pool.organization_id)
      .where('id', '=', pool.id)
      .where('revision', '=', pool.revision)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      throw errors.staleRevision(pool.revision, pool.revision + 1);
    }
    return pool.revision + 1;
  }

  private async recordChange(
    trx: Trx,
    principal: Principal,
    input: {
      poolId: string;
      seasonId: string;
      divisionId: string;
      change: 'created' | 'entry_added' | 'entry_removed';
      teamEntryId: string | null;
      beforeRevision: number | null;
      revision: number;
      reason: string | null;
      correlationId: string | null;
      seed?: number | null;
    },
  ): Promise<void> {
    const organizationId = organizationOf(principal);
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: MatchActions.managePools.id,
      targetType: 'pool',
      targetId: input.poolId,
      beforeRevision: input.beforeRevision,
      afterRevision: input.revision,
      reason: input.reason,
      correlationId: input.correlationId,
      details: {
        change: input.change,
        divisionId: input.divisionId,
        teamEntryId: input.teamEntryId,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      },
    });
    await this.outbox.enqueue(trx, MatchEvents.poolChanged, {
      organizationId,
      aggregateType: 'pool',
      aggregateId: input.poolId,
      payload: {
        poolId: input.poolId,
        seasonId: input.seasonId,
        divisionId: input.divisionId,
        change: input.change,
        teamEntryId: input.teamEntryId,
        revision: input.revision,
      },
      correlationId: input.correlationId,
    });
  }

  private async view(db: Reader, organizationId: string, poolId: string): Promise<Pool> {
    const pool = await db
      .selectFrom('pools')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();
    const entries = await db
      .selectFrom('pool_entries')
      .select(['team_entry_id', 'seed'])
      .where('organization_id', '=', organizationId)
      .where('pool_id', '=', poolId)
      .execute();
    const names = await teamNamesOf(
      db,
      organizationId,
      entries.map((e) => e.team_entry_id),
    );
    return {
      id: pool.id,
      seasonId: pool.season_id,
      divisionId: pool.division_id,
      name: pool.name,
      entries: entries
        .map((e) => ({
          teamEntryId: e.team_entry_id,
          teamName: names.get(e.team_entry_id) ?? 'Unknown team',
          seed: e.seed,
        }))
        .sort(
          (a, b) =>
            (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER) ||
            a.teamName.localeCompare(b.teamName) ||
            a.teamEntryId.localeCompare(b.teamEntryId),
        ),
      revision: pool.revision,
      createdAt: iso(pool.created_at),
      updatedAt: iso(pool.updated_at),
    };
  }
}
