import { Inject, Injectable } from '@nestjs/common';
import {
  HoldMachine,
  errors,
  newId,
  type AdjustCapacityPoolInput,
  type CapacityPool,
  type CapacityUnit,
  type CreateCapacityPoolInput,
  type Hold,
  type ListCapacityPoolsQuery,
  type OfferingSession,
  type Principal,
  type RegistrationIntent,
  type SyncOfferingPoolsInput,
} from '@sportspark/contracts';
import {
  json,
  type CapacityConstraintKind,
  type CapacityPoolsTable,
  type CapacityPoolUnit,
  type Db,
  type HoldsTable,
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
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  type OfferingLookupPort,
  type OfferingSnapshot,
} from '../../catalog';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import { INTENT_CAPACITY_UNITS } from '../enrollment.policy';
import type { AcquireHoldInput, CapacityPort } from '../enrollment.ports';
import {
  enrollmentSystem,
  organizationOf,
  toCapacityPool,
  toHold,
  type Reader,
} from '../enrollment.shared';

export type PoolRow = Selectable<CapacityPoolsTable>;
export type HoldRow = Selectable<HoldsTable>;

export interface AllocationTarget {
  enrollmentId?: string | null;
  sessionBookingId?: string | null;
  placementRequestId?: string | null;
}

/**
 * Capacity pools, holds and allocations (§4.4 Capacity, SPK-REG-005/006, §4.7 invariant 3,
 * SPK-YOUTH-002). Capacity includes active holds and accepted commitments: `committed + held`
 * can never exceed `capacity` because the database check refuses it and every acquisition is a
 * conditional UPDATE that re-evaluates the row under its lock (SPK-AT-005). Several pools of one
 * offering (commercial, staffing, space) are several simultaneous constraints acquired in id order.
 */
@Injectable()
export class CapacityService implements CapacityPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async poolsForOffering(
    organizationId: string,
    offeringId: string,
    trx?: Trx,
  ): Promise<CapacityPool[]> {
    const rows = await this.poolRowsForOffering(
      trx ?? this.uow.reader(),
      organizationId,
      offeringId,
    );
    return rows.map(toCapacityPool);
  }

  async getPool(organizationId: string, poolId: string, trx?: Trx): Promise<CapacityPool | null> {
    const row = await this.loadPool(trx ?? this.uow.reader(), organizationId, poolId);
    return row ? toCapacityPool(row) : null;
  }

  async listPools(principal: Principal, query: ListCapacityPoolsQuery): Promise<CapacityPool[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EnrollmentActions.readCapacity, {
      type: 'capacity_pool',
      organizationId,
    });
    let q = this.db
      .selectFrom('capacity_pools')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('created_at')
      .orderBy('id');
    if (query.offeringId) q = q.where('offering_id', '=', query.offeringId);
    if (query.scopeType) q = q.where('scope_type', '=', query.scopeType);
    if (query.scopeId) q = q.where('scope_id', '=', query.scopeId);
    return (await q.execute()).map(toCapacityPool);
  }

  async poolRowsForOffering(
    db: Reader,
    organizationId: string,
    offeringId: string,
  ): Promise<PoolRow[]> {
    return db
      .selectFrom('capacity_pools')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .orderBy('id')
      .execute();
  }

  async loadPool(
    db: Reader,
    organizationId: string,
    poolId: string,
    forUpdate = false,
  ): Promise<PoolRow | undefined> {
    let q = db
      .selectFrom('capacity_pools')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', poolId);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async loadHold(
    db: Reader,
    organizationId: string,
    holdId: string,
    forUpdate = false,
  ): Promise<HoldRow | undefined> {
    let q = db
      .selectFrom('holds')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', holdId);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async holdsOfBasket(db: Reader, organizationId: string, basketId: string): Promise<HoldRow[]> {
    return db
      .selectFrom('holds')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('basket_id', '=', basketId)
      .orderBy('acquired_at')
      .orderBy('id')
      .execute();
  }

  async holdsOfOwner(
    db: Reader,
    organizationId: string,
    ownerKind: HoldRow['owner_kind'],
    ownerId: string,
  ): Promise<HoldRow[]> {
    return db
      .selectFrom('holds')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('owner_kind', '=', ownerKind)
      .where('owner_id', '=', ownerId)
      .orderBy('id')
      .execute();
  }

  /**
   * SPK-REG-005 / SPK-PLACE-003: the roster-place pools staff configured for a team entry (every
   * constraint kind), in lock order. A join_team registration naming the team and a placement
   * assignment onto it hold the same pools, so they share one roster constraint (§4.7 invariant 3).
   */
  async teamEntryPools(
    db: Reader,
    organizationId: string,
    teamEntryId: string,
  ): Promise<PoolRow[]> {
    return db
      .selectFrom('capacity_pools')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('scope_type', '=', 'team_entry')
      .where('scope_id', '=', teamEntryId)
      .where('unit', '=', 'roster_places')
      .where('status', '=', 'active')
      .orderBy('id')
      .execute();
  }

  /** The offering-level pools an intent must hold (commercial and staffing constraints alike). */
  poolsForIntent(pools: readonly PoolRow[], intent: RegistrationIntent): PoolRow[] {
    const units: readonly string[] = INTENT_CAPACITY_UNITS[intent];
    return pools.filter(
      (p) => p.scope_type === 'offering' && p.status === 'active' && units.includes(p.unit),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Pool creation and sizing
  // -------------------------------------------------------------------------------------------

  /**
   * Creates the pools of an offering from its catalog capacity units: one commercial pool per
   * unit and, for units with a staffing ratio, a staffing pool sized from the staff count the
   * ratio implies (SPK-YOUTH-002). Session seats are per session (ensureSessionPool).
   */
  async ensurePoolsForOffering(
    trx: Trx,
    organizationId: string,
    snapshot: OfferingSnapshot,
    actor: Principal,
  ): Promise<PoolRow[]> {
    const offeringId = snapshot.offering.id;
    const existing = await this.poolRowsForOffering(trx, organizationId, offeringId);
    const wanted = this.offeringPoolSpecs(
      snapshot.capacityUnits.filter((u) => u.unit !== 'session_seats'),
    );
    let missing = false;
    for (const spec of wanted) {
      const present = existing.some(
        (p) =>
          p.scope_type === 'offering' &&
          p.unit === spec.unit &&
          p.constraint_kind === spec.constraintKind,
      );
      if (present) continue;
      missing = true;
      await this.insertPool(trx, organizationId, {
        offeringId,
        scopeType: 'offering',
        scopeId: offeringId,
        ...spec,
        actor,
      });
    }
    // Re-read whenever a pool was missing: a concurrent creator may have won the insert, and its
    // committed row (not this transaction's earlier read) is the pool to hold.
    return missing ? this.poolRowsForOffering(trx, organizationId, offeringId) : existing;
  }

  /** The session pool for pickup/trial/makeup seats; null when the catalog configures no session capacity. */
  async ensureSessionPool(
    trx: Trx,
    organizationId: string,
    snapshot: OfferingSnapshot,
    session: OfferingSession,
    actor: Principal,
  ): Promise<PoolRow[]> {
    const units = session.capacityOverride ?? snapshot.capacityUnits;
    const unit =
      units.find((u) => u.unit === 'session_seats') ??
      units.find((u) => u.unit === 'seats') ??
      snapshot.capacityUnits.find((u) => u.unit === 'session_seats') ??
      snapshot.capacityUnits.find((u) => u.unit === 'seats');
    const rows = await trx
      .selectFrom('capacity_pools')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('scope_type', '=', 'session')
      .where('scope_id', '=', session.id)
      .orderBy('id')
      .execute();
    if (!unit) return rows;
    const specs = this.offeringPoolSpecs([{ ...unit, unit: 'session_seats' }]);
    let missing = false;
    for (const spec of specs) {
      if (rows.some((p) => p.constraint_kind === spec.constraintKind)) continue;
      missing = true;
      await this.insertPool(trx, organizationId, {
        offeringId: snapshot.offering.id,
        scopeType: 'session',
        scopeId: session.id,
        ...spec,
        actor,
      });
    }
    return missing
      ? trx
          .selectFrom('capacity_pools')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('scope_type', '=', 'session')
          .where('scope_id', '=', session.id)
          .orderBy('id')
          .execute()
      : rows;
  }

  private offeringPoolSpecs(units: readonly CapacityUnit[]): Array<{
    unit: CapacityPoolUnit;
    constraintKind: CapacityConstraintKind;
    capacity: number;
    participantsPerStaff: number | null;
    staffCount: number | null;
  }> {
    const specs: Array<{
      unit: CapacityPoolUnit;
      constraintKind: CapacityConstraintKind;
      capacity: number;
      participantsPerStaff: number | null;
      staffCount: number | null;
    }> = [];
    for (const unit of units) {
      specs.push({
        unit: unit.unit,
        constraintKind: 'commercial',
        capacity: unit.limit,
        participantsPerStaff: null,
        staffCount: null,
      });
      if (unit.staffingRatio) {
        const ratio = unit.staffingRatio.participantsPerStaff;
        const staffCount = Math.ceil(unit.limit / ratio);
        specs.push({
          unit: unit.unit,
          constraintKind: 'staffing',
          capacity: staffCount * ratio,
          participantsPerStaff: ratio,
          staffCount,
        });
      }
    }
    return specs;
  }

  private async insertPool(
    trx: Trx,
    organizationId: string,
    input: {
      offeringId: string | null;
      scopeType: PoolRow['scope_type'];
      scopeId: string;
      unit: CapacityPoolUnit;
      constraintKind: CapacityConstraintKind;
      capacity: number;
      participantsPerStaff: number | null;
      staffCount: number | null;
      actor: Principal;
    },
  ): Promise<string | null> {
    const id = newId();
    // One pool per scope, unit and constraint: a concurrent creator wins and this insert becomes a
    // no-op (ON CONFLICT keeps the surrounding transaction usable, unlike a caught violation).
    const inserted = await trx
      .insertInto('capacity_pools')
      .values({
        id,
        organization_id: organizationId,
        offering_id: input.offeringId,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        unit: input.unit,
        constraint_kind: input.constraintKind,
        capacity: input.capacity,
        participants_per_staff: input.participantsPerStaff,
        staff_count: input.staffCount,
        created_by: json(snapshotActor(input.actor)),
      })
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'scope_type', 'scope_id', 'unit', 'constraint_kind'])
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    return inserted ? id : null;
  }

  async createPool(
    principal: Principal,
    input: CreateCapacityPoolInput,
    correlationId: string | null,
  ): Promise<CapacityPool> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, EnrollmentActions.manageCapacity, {
        type: 'capacity_pool',
        organizationId,
      });
      if (input.offeringId) {
        const snapshot = await this.offerings.getOffering(
          organizationId,
          input.offeringId,
          this.clock.now(),
          trx,
        );
        if (!snapshot) throw errors.notFound('offering', input.offeringId);
      }
      const staffCount = input.constraintKind === 'staffing' ? (input.staffCount ?? 0) : null;
      const ratio = input.constraintKind === 'staffing' ? (input.participantsPerStaff ?? 1) : null;
      const capacity =
        input.constraintKind === 'staffing' ? (staffCount ?? 0) * (ratio ?? 1) : input.capacity;
      const id = await this.insertPool(trx, organizationId, {
        offeringId: input.offeringId ?? null,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        unit: input.unit,
        constraintKind: input.constraintKind,
        capacity,
        participantsPerStaff: ratio,
        staffCount,
        actor: principal,
      });
      if (!id)
        throw errors.resourceConflict('A pool for this scope, unit and constraint already exists.');
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageCapacity.id,
        targetType: 'capacity_pool',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: { scopeType: input.scopeType, scopeId: input.scopeId, unit: input.unit, capacity },
      });
      const row = await this.loadPool(trx, organizationId, id);
      if (!row) throw errors.internal('pool vanished');
      return toCapacityPool(row);
    });
  }

  /**
   * SPK-YOUTH-002: a staffing pool grows only through an explicit staff count with a reason;
   * capacity never drops below what is already committed and held.
   */
  async adjustPool(
    principal: Principal,
    poolId: string,
    input: AdjustCapacityPoolInput,
    correlationId: string | null,
  ): Promise<CapacityPool> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadPool(trx, organizationId, poolId, true);
      if (!row) throw errors.notFound('capacity_pool', poolId);
      await this.authorization.require(principal, EnrollmentActions.manageCapacity, {
        type: 'capacity_pool',
        id: poolId,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      let capacity: number;
      let staffCount = row.staff_count;
      if (row.constraint_kind === 'staffing') {
        if (input.staffCount === undefined) {
          throw errors.validation(
            'A staffing pool is adjusted through its staff count, not its capacity.',
          );
        }
        staffCount = input.staffCount;
        capacity = staffCount * (row.participants_per_staff ?? 1);
      } else {
        if (input.capacity === undefined) throw errors.validation('capacity is required.');
        capacity = input.capacity;
      }
      const used = row.committed + row.held;
      if (capacity < used) {
        throw errors.resourceConflict(
          `Capacity cannot drop below the ${used} places already committed or held.`,
          { code: 'CAPACITY_BELOW_COMMITMENTS', committed: row.committed, held: row.held },
        );
      }
      await trx
        .updateTable('capacity_pools')
        .set({ capacity, staff_count: staffCount, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', poolId)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageCapacity.id,
        targetType: 'capacity_pool',
        targetId: poolId,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason,
        correlationId,
        details: {
          capacityBefore: row.capacity,
          capacityAfter: capacity,
          staffCountBefore: row.staff_count,
          staffCountAfter: staffCount,
        },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.capacityPoolChanged, {
        organizationId,
        aggregateType: 'capacity_pool',
        aggregateId: poolId,
        correlationId,
        payload: {
          organizationId,
          poolId,
          offeringId: row.offering_id,
          constraintKind: row.constraint_kind,
          capacityBefore: row.capacity,
          capacityAfter: capacity,
          reason: input.reason,
        },
      });
      if (capacity > row.capacity) {
        await this.outbox.enqueue(trx, EnrollmentEvents.capacityReleased, {
          organizationId,
          aggregateType: 'capacity_pool',
          aggregateId: poolId,
          correlationId,
          payload: {
            organizationId,
            poolId,
            quantity: capacity - row.capacity,
            cause: 'capacity_raised',
          },
        });
      }
      const updated = await this.loadPool(trx, organizationId, poolId);
      if (!updated) throw errors.internal('pool vanished');
      return toCapacityPool(updated);
    });
  }

  /** Staff command: create or resize the pools of an offering from its current catalog units. */
  async syncOfferingPools(
    principal: Principal,
    offeringId: string,
    _input: SyncOfferingPoolsInput,
    correlationId: string | null,
  ): Promise<CapacityPool[]> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, EnrollmentActions.manageCapacity, {
        type: 'offering',
        id: offeringId,
        organizationId,
      });
      const snapshot = await this.offerings.getOffering(
        organizationId,
        offeringId,
        this.clock.now(),
        trx,
      );
      if (!snapshot) throw errors.notFound('offering', offeringId);
      await this.ensurePoolsForOffering(trx, organizationId, snapshot, principal);
      await this.syncFromCatalog(
        trx,
        organizationId,
        offeringId,
        snapshot.capacityUnits,
        correlationId,
      );
      return (await this.poolRowsForOffering(trx, organizationId, offeringId)).map(toCapacityPool);
    });
  }

  /**
   * Outbox handler for `catalog.offering_updated`: commercial pools follow the catalog limit;
   * staffing pools keep their staff count, so a raised commercial limit never silently bypasses
   * the staffing requirement (SPK-YOUTH-002). A limit below the places already committed or held
   * is kept at the used quantity and raised as an operational exception. Idempotent under replay.
   */
  async syncFromCatalog(
    trx: Trx,
    organizationId: string,
    offeringId: string,
    units: readonly CapacityUnit[],
    correlationId: string | null,
  ): Promise<void> {
    const pools = await this.poolRowsForOffering(trx, organizationId, offeringId);
    if (pools.length === 0) return; // pools are created lazily on the first hold
    for (const unit of units) {
      if (unit.unit === 'session_seats') continue;
      const commercial = pools.find(
        (p) =>
          p.scope_type === 'offering' && p.unit === unit.unit && p.constraint_kind === 'commercial',
      );
      if (!commercial) {
        await this.insertPool(trx, organizationId, {
          offeringId,
          scopeType: 'offering',
          scopeId: offeringId,
          unit: unit.unit,
          constraintKind: 'commercial',
          capacity: unit.limit,
          participantsPerStaff: null,
          staffCount: null,
          actor: enrollmentSystem(organizationId, 'enrollment.capacity_sync'),
        });
      } else if (commercial.capacity !== unit.limit) {
        const used = commercial.committed + commercial.held;
        const capacity = Math.max(unit.limit, used);
        await trx
          .updateTable('capacity_pools')
          .set({ capacity, revision: commercial.revision + 1 })
          .where('organization_id', '=', organizationId)
          .where('id', '=', commercial.id)
          .where('revision', '=', commercial.revision)
          .execute();
        if (capacity > commercial.capacity) {
          await this.outbox.enqueue(trx, EnrollmentEvents.capacityReleased, {
            organizationId,
            aggregateType: 'capacity_pool',
            aggregateId: commercial.id,
            correlationId,
            payload: {
              organizationId,
              poolId: commercial.id,
              quantity: capacity - commercial.capacity,
              cause: 'catalog_capacity_raised',
            },
          });
        }
        if (unit.limit < used) {
          await this.exceptions.raise(trx, {
            organizationId,
            category: 'enrollment.capacity_below_commitments',
            severity: 'high',
            title: `Offering capacity (${unit.unit}) lowered below ${used} committed or held places`,
            affectedType: 'capacity_pool',
            affectedId: commercial.id,
            ownerQueue: 'program_manager',
            dedupeKey: `capacity_below:${commercial.id}`,
            details: {
              offeringId,
              unit: unit.unit,
              requestedLimit: unit.limit,
              committed: commercial.committed,
              held: commercial.held,
            },
          });
        }
      }
      const staffing = pools.find(
        (p) =>
          p.scope_type === 'offering' && p.unit === unit.unit && p.constraint_kind === 'staffing',
      );
      if (unit.staffingRatio) {
        const ratio = unit.staffingRatio.participantsPerStaff;
        if (!staffing) {
          const staffCount = Math.ceil(unit.limit / ratio);
          await this.insertPool(trx, organizationId, {
            offeringId,
            scopeType: 'offering',
            scopeId: offeringId,
            unit: unit.unit,
            constraintKind: 'staffing',
            capacity: staffCount * ratio,
            participantsPerStaff: ratio,
            staffCount,
            actor: enrollmentSystem(organizationId, 'enrollment.capacity_sync'),
          });
        } else if (staffing.participants_per_staff !== ratio) {
          // The ratio changed; the staff count is a staffing fact that only staff may raise.
          const capacity = Math.max(
            (staffing.staff_count ?? 0) * ratio,
            staffing.committed + staffing.held,
          );
          await trx
            .updateTable('capacity_pools')
            .set({ participants_per_staff: ratio, capacity, revision: staffing.revision + 1 })
            .where('organization_id', '=', organizationId)
            .where('id', '=', staffing.id)
            .where('revision', '=', staffing.revision)
            .execute();
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Holds (SPK-REG-006): acquire, commit, release, expire — exactly one terminal outcome
  // -------------------------------------------------------------------------------------------

  async acquireHolds(trx: Trx, organizationId: string, input: AcquireHoldInput): Promise<Hold[]> {
    const now = this.clock.now();
    if (input.expiresAt.getTime() <= now.getTime())
      throw errors.validation('A hold must expire in the future.');
    const requests = [...input.pools].sort((a, b) =>
      a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0,
    );
    const rows: HoldRow[] = [];
    for (const request of requests) {
      await this.reserve(trx, organizationId, request.poolId, request.quantity, 'held');
      const id = newId();
      await trx
        .insertInto('holds')
        .values({
          id,
          organization_id: organizationId,
          pool_id: request.poolId,
          quantity: request.quantity,
          owner_kind: input.ownerKind,
          owner_id: input.ownerId,
          basket_id: input.basketId ?? null,
          actor: json(snapshotActor(input.actor)),
          acquired_at: now,
          expires_at: input.expiresAt,
        })
        .execute();
      const row = await this.loadHold(trx, organizationId, id);
      if (!row) throw errors.internal('hold vanished');
      rows.push(row);
      // Server-owned expiry: a timer the worker runs at expiresAt releases the held quantity.
      await this.outbox.enqueue(trx, EnrollmentEvents.holdExpiryDue, {
        organizationId,
        aggregateType: 'hold',
        aggregateId: id,
        correlationId: input.correlationId ?? null,
        availableAt: input.expiresAt,
        payload: {
          organizationId,
          holdId: id,
          poolId: request.poolId,
          expiresAt: input.expiresAt.toISOString(),
        },
      });
    }
    return rows.map(toHold);
  }

  /**
   * Counter movements (held/committed) never bump the pool revision: the revision guards staff
   * configuration edits (capacity, staff count), while the counters are guarded by the row lock,
   * this conditional update and the check constraint.
   *
   * The conditional UPDATE that enforces §4.7 invariant 3 together with the check constraint:
   * the row lock serializes contenders and the WHERE clause is re-evaluated after the lock, so
   * on a pool with one free place exactly one of fifty concurrent attempts succeeds (SPK-AT-005).
   */
  private async reserve(
    trx: Trx,
    organizationId: string,
    poolId: string,
    quantity: number,
    mode: 'held' | 'committed',
  ): Promise<void> {
    const result = await trx
      .updateTable('capacity_pools')
      .set((eb) => ({
        held: mode === 'held' ? eb('held', '+', quantity) : eb.ref('held'),
        committed: mode === 'committed' ? eb('committed', '+', quantity) : eb.ref('committed'),
      }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', poolId)
      .where('status', '=', 'active')
      .where(sql<SqlBool>`committed + held + ${quantity} <= capacity`)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) > 0) return;
    const pool = await this.loadPool(trx, organizationId, poolId);
    if (!pool) throw errors.notFound('capacity_pool', poolId);
    throw errors.capacityUnavailable(
      pool.status === 'closed'
        ? 'This capacity pool is closed.'
        : `No ${pool.unit.replaceAll('_', ' ')} capacity is available${pool.constraint_kind === 'staffing' ? ' within the staffing requirement' : ''}.`,
      {
        poolId,
        unit: pool.unit,
        constraintKind: pool.constraint_kind,
        requested: quantity,
        available: Math.max(0, pool.capacity - pool.committed - pool.held),
      },
    );
  }

  /**
   * True when an active hold has passed its server-owned expiry (SPK-REG-006): it no longer
   * reserves anything even if the expiry timer has not run yet, so it can never be committed.
   */
  isLapsed(hold: HoldRow, now: Date = this.clock.now()): boolean {
    return hold.status === 'active' && new Date(hold.expires_at).getTime() <= now.getTime();
  }

  /**
   * Converts an active hold to an allocation; throws CAPACITY_UNAVAILABLE (writing nothing) when
   * it is no longer active or has passed its server-owned expiry.
   */
  async commitHold(
    trx: Trx,
    organizationId: string,
    holdId: string,
    target: AllocationTarget,
    correlationId: string | null,
  ): Promise<HoldRow> {
    const now = this.clock.now();
    const hold = await this.loadHold(trx, organizationId, holdId, true);
    if (!hold) throw errors.notFound('hold', holdId);
    if (!HoldMachine.can(hold.status, 'commit') || this.isLapsed(hold, now)) {
      throw errors.capacityUnavailable(
        `The hold is ${this.isLapsed(hold, now) ? 'expired' : hold.status}; the place is no longer reserved.`,
        {
          holdId,
          status: this.isLapsed(hold, now) ? 'expired' : hold.status,
          poolId: hold.pool_id,
        },
      );
    }
    const result = await trx
      .updateTable('holds')
      .set({
        status: HoldMachine.next(hold.status, 'commit'),
        committed_at: now,
        revision: hold.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', holdId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw errors.capacityUnavailable(
        `The hold is ${hold.status}; the place is no longer reserved.`,
        {
          holdId,
          status: hold.status,
          poolId: hold.pool_id,
        },
      );
    }
    await trx
      .updateTable('capacity_pools')
      .set((eb) => ({
        held: eb('held', '-', hold.quantity),
        committed: eb('committed', '+', hold.quantity),
      }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', hold.pool_id)
      .execute();
    await this.insertAllocation(
      trx,
      organizationId,
      hold.pool_id,
      holdId,
      hold.quantity,
      target,
      now,
    );
    await this.outbox.enqueue(trx, EnrollmentEvents.holdCommitted, {
      organizationId,
      aggregateType: 'hold',
      aggregateId: holdId,
      correlationId,
      payload: { organizationId, holdId, poolId: hold.pool_id, quantity: hold.quantity },
    });
    const updated = await this.loadHold(trx, organizationId, holdId);
    if (!updated) throw errors.internal('hold vanished');
    return updated;
  }

  /** Commits capacity directly (no hold): transfers and re-acquisition after a hold expired (SPK-AT-006). */
  async acquireCommitted(
    trx: Trx,
    organizationId: string,
    pools: ReadonlyArray<{ poolId: string; quantity: number }>,
    target: AllocationTarget,
  ): Promise<string[]> {
    const now = this.clock.now();
    const ids: string[] = [];
    const sorted = [...pools].sort((a, b) =>
      a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0,
    );
    for (const request of sorted) {
      await this.reserve(trx, organizationId, request.poolId, request.quantity, 'committed');
      ids.push(
        await this.insertAllocation(
          trx,
          organizationId,
          request.poolId,
          null,
          request.quantity,
          target,
          now,
        ),
      );
    }
    return ids;
  }

  private async insertAllocation(
    trx: Trx,
    organizationId: string,
    poolId: string,
    holdId: string | null,
    quantity: number,
    target: AllocationTarget,
    now: Date,
  ): Promise<string> {
    const id = newId();
    await trx
      .insertInto('allocations')
      .values({
        id,
        organization_id: organizationId,
        pool_id: poolId,
        hold_id: holdId,
        enrollment_id: target.enrollmentId ?? null,
        session_booking_id: target.sessionBookingId ?? null,
        placement_request_id: target.placementRequestId ?? null,
        quantity,
        allocated_at: now,
      })
      .execute();
    return id;
  }

  /** Releases the active allocations of a record; returns the pools and quantities freed. */
  async releaseAllocationsFor(
    trx: Trx,
    organizationId: string,
    target: AllocationTarget,
    reason: string,
  ): Promise<Array<{ poolId: string; quantity: number }>> {
    let q = trx
      .selectFrom('allocations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active');
    if (target.enrollmentId) q = q.where('enrollment_id', '=', target.enrollmentId);
    else if (target.sessionBookingId)
      q = q.where('session_booking_id', '=', target.sessionBookingId);
    else if (target.placementRequestId)
      q = q.where('placement_request_id', '=', target.placementRequestId);
    else return [];
    const rows = await q.forUpdate().execute();
    const now = this.clock.now();
    const freed: Array<{ poolId: string; quantity: number }> = [];
    for (const row of rows) {
      await trx
        .updateTable('allocations')
        .set({ status: 'released', released_at: now, release_reason: reason })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .where('status', '=', 'active')
        .execute();
      await trx
        .updateTable('capacity_pools')
        .set((eb) => ({ committed: eb('committed', '-', row.quantity) }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.pool_id)
        .execute();
      freed.push({ poolId: row.pool_id, quantity: row.quantity });
    }
    return freed;
  }

  async releaseHold(
    trx: Trx,
    organizationId: string,
    holdId: string,
    reason: string,
    actor: Principal,
    correlationId: string | null = null,
  ): Promise<Hold> {
    const before = await this.loadHold(trx, organizationId, holdId);
    const row = await this.releaseHoldRow(trx, organizationId, holdId, reason, correlationId);
    if (!row || !before) throw errors.notFound('hold', holdId);
    if (before.status === 'active') {
      await this.audit.record(trx, {
        organizationId,
        actor,
        action: 'enrollment.release_hold',
        targetType: 'hold',
        targetId: holdId,
        beforeRevision: before.revision,
        afterRevision: row.revision,
        reason,
        correlationId,
        details: { poolId: row.pool_id, quantity: row.quantity },
      });
    }
    return toHold(row);
  }

  /** Releases an active hold (idempotent: a non-active hold is returned unchanged). */
  async releaseHoldRow(
    trx: Trx,
    organizationId: string,
    holdId: string,
    reason: string,
    correlationId: string | null,
  ): Promise<HoldRow | undefined> {
    const now = this.clock.now();
    const hold = await this.loadHold(trx, organizationId, holdId, true);
    if (!hold) return undefined;
    if (hold.status !== 'active') return hold;
    await trx
      .updateTable('holds')
      .set({
        status: HoldMachine.next(hold.status, 'release'),
        released_at: now,
        release_reason: reason,
        revision: hold.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', holdId)
      .where('status', '=', 'active')
      .execute();
    await this.giveBack(trx, organizationId, hold.pool_id, hold.quantity);
    await this.outbox.enqueue(trx, EnrollmentEvents.holdReleased, {
      organizationId,
      aggregateType: 'hold',
      aggregateId: holdId,
      correlationId,
      payload: { organizationId, holdId, poolId: hold.pool_id, quantity: hold.quantity, reason },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.capacityReleased, {
      organizationId,
      aggregateType: 'capacity_pool',
      aggregateId: hold.pool_id,
      correlationId,
      payload: {
        organizationId,
        poolId: hold.pool_id,
        quantity: hold.quantity,
        cause: 'hold_released',
      },
    });
    return this.loadHold(trx, organizationId, holdId);
  }

  /**
   * Timer handler body: marks an active hold expired once its server-owned expiry has passed and
   * gives the quantity back. Returns the hold when it expired now, null when nothing changed
   * (already terminal, or extended to a later instant — the later timer handles it).
   */
  async expireHoldIfDue(
    trx: Trx,
    organizationId: string,
    holdId: string,
    correlationId: string | null,
  ): Promise<HoldRow | null> {
    const now = this.clock.now();
    const hold = await this.loadHold(trx, organizationId, holdId, true);
    if (!hold || hold.status !== 'active') return null;
    if (new Date(hold.expires_at).getTime() > now.getTime()) return null;
    await trx
      .updateTable('holds')
      .set({
        status: HoldMachine.next(hold.status, 'expire'),
        expired_at: now,
        revision: hold.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', holdId)
      .where('status', '=', 'active')
      .execute();
    await this.giveBack(trx, organizationId, hold.pool_id, hold.quantity);
    await this.outbox.enqueue(trx, EnrollmentEvents.holdExpired, {
      organizationId,
      aggregateType: 'hold',
      aggregateId: holdId,
      correlationId,
      payload: { organizationId, holdId, poolId: hold.pool_id, quantity: hold.quantity },
    });
    // The expired place goes back to the pool; waitlist offers follow (SPK-REG-008, SPK-AT-006).
    await this.outbox.enqueue(trx, EnrollmentEvents.capacityReleased, {
      organizationId,
      aggregateType: 'capacity_pool',
      aggregateId: hold.pool_id,
      correlationId,
      payload: {
        organizationId,
        poolId: hold.pool_id,
        quantity: hold.quantity,
        cause: 'hold_expired',
      },
    });
    return (await this.loadHold(trx, organizationId, holdId)) ?? null;
  }

  /** Moves an active hold to a new owner and expiry (a waitlist offer accepted into a basket). */
  async reassignHold(
    trx: Trx,
    organizationId: string,
    holdId: string,
    owner: { ownerKind: HoldRow['owner_kind']; ownerId: string; basketId: string | null },
    expiresAt: Date,
    correlationId: string | null,
  ): Promise<HoldRow> {
    const hold = await this.loadHold(trx, organizationId, holdId, true);
    if (!hold) throw errors.notFound('hold', holdId);
    if (hold.status !== 'active' || this.isLapsed(hold)) {
      throw errors.capacityUnavailable(
        `The hold is ${hold.status === 'active' ? 'expired' : hold.status}; the place is no longer reserved.`,
        { holdId, status: hold.status === 'active' ? 'expired' : hold.status },
      );
    }
    await trx
      .updateTable('holds')
      .set({
        owner_kind: owner.ownerKind,
        owner_id: owner.ownerId,
        basket_id: owner.basketId,
        expires_at: expiresAt,
        revision: hold.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', holdId)
      .where('revision', '=', hold.revision)
      .execute();
    if (expiresAt.getTime() !== new Date(hold.expires_at).getTime()) {
      // A timer for the new instant; the earlier timer finds the hold not yet due and does nothing.
      await this.outbox.enqueue(trx, EnrollmentEvents.holdExpiryDue, {
        organizationId,
        aggregateType: 'hold',
        aggregateId: holdId,
        correlationId,
        availableAt: expiresAt,
        payload: {
          organizationId,
          holdId,
          poolId: hold.pool_id,
          expiresAt: expiresAt.toISOString(),
        },
      });
    }
    const updated = await this.loadHold(trx, organizationId, holdId);
    if (!updated) throw errors.internal('hold vanished');
    return updated;
  }

  private async giveBack(
    trx: Trx,
    organizationId: string,
    poolId: string,
    quantity: number,
  ): Promise<void> {
    await trx
      .updateTable('capacity_pools')
      .set((eb) => ({ held: eb('held', '-', quantity) }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', poolId)
      .execute();
  }

  /**
   * DEC-006 (proposed default `waitlistFirst`): while participants wait for an offering or session,
   * freed places go to them through offers, not to a new registrant who skipped the queue.
   */
  async othersWaiting(
    db: Reader,
    organizationId: string,
    scope: { offeringId: string; sessionId: string | null },
    participantPersonId: string,
  ): Promise<number> {
    let q = db
      .selectFrom('waitlist_entries')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', scope.offeringId)
      .where('status', '=', 'waiting')
      .where('participant_person_id', '<>', participantPersonId);
    q = scope.sessionId
      ? q.where('session_id', '=', scope.sessionId)
      : q.where('session_id', 'is', null);
    const row = await q.executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async enqueueCapacityReleased(
    trx: Trx,
    organizationId: string,
    freed: ReadonlyArray<{ poolId: string; quantity: number }>,
    cause: string,
    correlationId: string | null,
  ): Promise<void> {
    for (const item of freed) {
      await this.outbox.enqueue(trx, EnrollmentEvents.capacityReleased, {
        organizationId,
        aggregateType: 'capacity_pool',
        aggregateId: item.poolId,
        correlationId,
        payload: { organizationId, poolId: item.poolId, quantity: item.quantity, cause },
      });
    }
  }
}
