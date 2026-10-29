import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Closure,
  type ClosureImpact,
  type ClosureStatus,
  type Interval,
  type PartyCommitment,
  type Principal,
} from '@sportspark/contracts';
import { json, tstzrange, type ClosuresTable, type Db } from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  executorFor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import type {
  ApplyClosureInput,
  ClosurePort,
  CreateClosureInput,
  LiftClosureInput,
  PreviewClosureInput,
  WithdrawClosureInput,
} from '../ports';
import { SchedulingActions } from '../scheduling.actions';
import { ClosureApplied, ClosureLifted, ClosureWithdrawn } from '../scheduling.events';
import { ClosureMachine } from '../scheduling.state-machines';
import { ClosureImpactContributors } from './closure-impact-contributors';
import { ClosureLiftGuards } from './closure-lift-guards';
import { EventWriter } from './event-writer';
import { organizationOf } from './organization';

type ClosureRow = Selectable<ClosuresTable> & { start: string; end: string };

/** A preview stored before customers, obligations and messages were identified (SPK-SCHED-009). */
function withImpactDefaults(impact: ClosureImpact | null): ClosureImpact | null {
  if (!impact) return null;
  return {
    ...impact,
    customers: impact.customers ?? [],
    obligations: impact.obligations ?? [],
    messages: impact.messages ?? [],
    summary: {
      ...impact.summary,
      customers: impact.summary.customers ?? 0,
      obligations: impact.summary.obligations ?? 0,
      messages: impact.summary.messages ?? 0,
    },
  };
}

const PROGRAM_KINDS = new Set(['session', 'practice', 'pickup']);
const RENTAL_KINDS = new Set(['rental', 'party']);

/**
 * Closures (SPK-SCHED-009, SPK-FAC-003/004/005). A closure is created with its impact preview
 * (affected events with their owning records and committed parties), applied by cancelling the
 * affected events or leaving them for staff resolution (an operational exception owned by the
 * scheduler queue), and lifted by an authorized release. Active closures block validation.
 */
@Injectable()
export class ClosuresService implements ClosurePort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly writer: EventWriter,
    private readonly liftGuards: ClosureLiftGuards,
    private readonly impactContributors: ClosureImpactContributors,
  ) {}

  /**
   * SPK-SCHED-009 (SCH-01 `GET /v1/closure-impact`): the impact a closure of this area and
   * interval would have — affected events with their owning records and parties, and the
   * customers, obligations and messages the owning modules contribute — computed without creating
   * anything.
   */
  async previewImpact(principal: Principal, input: PreviewClosureInput): Promise<ClosureImpact> {
    const organizationId = organizationOf(principal);
    if (!(new Date(input.interval.start).getTime() < new Date(input.interval.end).getTime())) {
      throw errors.validation('start must be before end.');
    }
    await this.authorization.require(principal, SchedulingActions.manageClosures, {
      type: 'closure',
      organizationId,
      facilityId: input.facilityId,
    });
    await this.writer.loadFacility(executorFor(this.db), organizationId, input.facilityId);
    if (input.resourceId) {
      await this.writer.loadResources(executorFor(this.db), organizationId, input.facilityId, [
        input.resourceId,
      ]);
    }
    return this.computeImpact(
      executorFor(this.db),
      organizationId,
      input.facilityId,
      input.resourceId ?? null,
      input.interval,
    );
  }

  async createClosure(principal: Principal, input: CreateClosureInput): Promise<Closure> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, input.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageClosures, {
        type: 'closure',
        organizationId,
        facilityId: facility.id,
      });
      if (input.resourceId) {
        await this.writer.loadResources(trx, organizationId, facility.id, [input.resourceId]);
      }
      const impact = await this.computeImpact(
        trx,
        organizationId,
        facility.id,
        input.resourceId ?? null,
        input.interval,
      );
      const id = newId();
      await trx
        .insertInto('closures')
        .values({
          id,
          organization_id: organizationId,
          facility_id: facility.id,
          resource_id: input.resourceId ?? null,
          during: tstzrange(input.interval.start, input.interval.end),
          reason: input.reason,
          source: input.source ?? 'manual',
          created_by: json(this.writer.snapshotActor(principal)),
          impact: json(impact),
          resolution: null,
          applied_at: null,
          lifted_at: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.closure_created',
        targetType: 'closure',
        targetId: id,
        afterRevision: 1,
        reason: input.reason,
        correlationId: input.correlationId ?? null,
        details: { affectedEvents: impact.affectedEvents.length },
      });
      return this.view((await this.load(trx, organizationId, id)) as ClosureRow);
    });
  }

  async applyClosure(
    principal: Principal,
    closureId: string,
    input: ApplyClosureInput,
  ): Promise<Closure> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const closure = await this.load(trx, organizationId, closureId, true);
      if (!closure) throw errors.notFound('closure', closureId);
      await this.authorization.require(principal, SchedulingActions.manageClosures, {
        type: 'closure',
        id: closureId,
        organizationId,
        facilityId: closure.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, closure.revision);
      const next = ClosureMachine.next(closure.status, 'apply');
      const facility = await this.writer.loadFacility(trx, organizationId, closure.facility_id);
      const interval = { start: closure.start, end: closure.end };
      await this.lockClosedUnits(trx, organizationId, closure.facility_id, closure.resource_id);
      const impact = await this.computeImpact(
        trx,
        organizationId,
        closure.facility_id,
        closure.resource_id,
        interval,
      );
      const canceled: string[] = [];
      const unresolved: string[] = [];
      for (const affected of impact.affectedEvents) {
        if (input.mode === 'cancel_affected' && affected.status === 'published') {
          const event = await this.writer.loadEvent(trx, organizationId, affected.eventId, {
            forUpdate: true,
          });
          if (!event || event.status !== 'published') continue;
          const before = await this.writer.details(trx, event);
          const reason = input.reason ?? `Closure: ${closure.reason}`;
          const row = await this.writer.cancel(trx, event, reason);
          await this.writer.notifyChanged(trx, {
            organizationId,
            event: row,
            change: 'canceled',
            before,
            after: null,
            closureId,
            reason,
            correlationId: input.correlationId ?? null,
          });
          canceled.push(event.id);
        } else {
          unresolved.push(affected.eventId);
        }
      }
      const resolution = {
        mode: input.mode,
        canceledEventIds: canceled,
        unresolvedEventIds: unresolved,
      };
      const now = this.clock.now();
      await trx
        .updateTable('closures')
        .set({
          status: next,
          applied_at: now,
          impact: json(impact),
          resolution: json(resolution),
          revision: closure.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', closureId)
        .where('revision', '=', closure.revision)
        .execute();
      if (unresolved.length > 0) {
        // Staff build and review the resolution (relocation, rescheduling, cancellation) from the Today workspace.
        await this.exceptions.raise(trx, {
          organizationId,
          facilityId: closure.facility_id,
          category: 'scheduling.closure_resolution_required',
          severity: 'high',
          title: `${unresolved.length} event(s) affected by a closure need resolution`,
          affectedType: 'closure',
          affectedId: closureId,
          ownerQueue: 'scheduler',
          dedupeKey: `closure:${closureId}`,
          details: { eventIds: unresolved, sourceRecords: impact.sourceRecords },
        });
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.closure_applied',
        targetType: 'closure',
        targetId: closureId,
        beforeRevision: closure.revision,
        afterRevision: closure.revision + 1,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        details: resolution,
      });
      await this.outbox.enqueue(trx, ClosureApplied, {
        organizationId,
        aggregateType: 'closure',
        aggregateId: closureId,
        correlationId: input.correlationId ?? null,
        payload: {
          closureId,
          facilityId: facility.id,
          resourceId: closure.resource_id,
          interval: {
            start: new Date(interval.start).toISOString(),
            end: new Date(interval.end).toISOString(),
          },
          reason: closure.reason,
          source: closure.source,
          mode: input.mode,
          canceledEventIds: canceled,
          unresolvedEventIds: unresolved,
          sourceRecords: impact.sourceRecords,
        },
      });
      return this.view((await this.load(trx, organizationId, closureId)) as ClosureRow);
    });
  }

  /**
   * SCH-01, IF-11 (SPK-FAC-003, §4.6 ClosureMachine `withdraw`): a pending closure that is no
   * longer needed is withdrawn before it ever applies, so it never affected availability and can
   * never be applied afterwards (migration 0302 checks and terminal guard). An active closure is
   * INVALID_TRANSITION: it is lifted, not withdrawn. Joins the caller's unit of work.
   *
   * Through CLOSURE_PORT any source is withdrawn (facilities withdraws the closure of a withdrawn
   * restriction). `refuseRestrictionOwned` (the HTTP route) refuses a `maintenance` closure with
   * RESOURCE_CONFLICT `OWNED_BY_RESTRICTION`: its restriction is withdrawn instead (§4.2).
   */
  async withdrawClosure(
    principal: Principal,
    closureId: string,
    input: WithdrawClosureInput,
    options: { refuseRestrictionOwned?: boolean } = {},
  ): Promise<Closure> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const closure = await this.load(trx, organizationId, closureId, true);
      if (!closure) throw errors.notFound('closure', closureId);
      await this.authorization.require(principal, SchedulingActions.manageClosures, {
        type: 'closure',
        id: closureId,
        organizationId,
        facilityId: closure.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, closure.revision);
      const next = ClosureMachine.next(closure.status, 'withdraw');
      if (options.refuseRestrictionOwned && closure.source === 'maintenance') {
        throw errors.resourceConflict(
          'This closure belongs to a maintenance restriction; withdraw the restriction instead.',
          { code: 'OWNED_BY_RESTRICTION', closureId },
        );
      }
      const updated = await trx
        .updateTable('closures')
        .set({
          status: next,
          withdrawn_at: this.clock.now(),
          withdrawn_by: json(this.writer.snapshotActor(principal)),
          withdrawal_reason: input.reason,
          revision: closure.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', closureId)
        .where('revision', '=', closure.revision)
        .returning('id')
        .executeTakeFirst();
      if (!updated) {
        const current = await this.load(trx, organizationId, closureId);
        throw errors.staleRevision(closure.revision, current?.revision ?? closure.revision);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.closure_withdrawn',
        targetType: 'closure',
        targetId: closureId,
        beforeRevision: closure.revision,
        afterRevision: closure.revision + 1,
        reason: input.reason,
        correlationId: input.correlationId ?? null,
        details: { source: closure.source },
      });
      await this.outbox.enqueue(trx, ClosureWithdrawn, {
        organizationId,
        aggregateType: 'closure',
        aggregateId: closureId,
        correlationId: input.correlationId ?? null,
        payload: {
          closureId,
          facilityId: closure.facility_id,
          resourceId: closure.resource_id,
          interval: {
            start: new Date(closure.start).toISOString(),
            end: new Date(closure.end).toISOString(),
          },
          source: closure.source,
          reason: input.reason,
        },
      });
      return this.view((await this.load(trx, organizationId, closureId)) as ClosureRow);
    });
  }

  async liftClosure(
    principal: Principal,
    closureId: string,
    input: LiftClosureInput,
  ): Promise<Closure> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const closure = await this.load(trx, organizationId, closureId, true);
      if (!closure) throw errors.notFound('closure', closureId);
      await this.authorization.require(principal, SchedulingActions.manageClosures, {
        type: 'closure',
        id: closureId,
        organizationId,
        facilityId: closure.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, closure.revision);
      const next = ClosureMachine.next(closure.status, 'lift');
      // SPK-FAC-004: a closure another module backs with its own authority (a facilities
      // restriction) is lifted only through that module's release (ClosureLiftGuards).
      await this.liftGuards.check(trx, organizationId, closureId);
      await trx
        .updateTable('closures')
        .set({ status: next, lifted_at: this.clock.now(), revision: closure.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', closureId)
        .where('revision', '=', closure.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.closure_lifted',
        targetType: 'closure',
        targetId: closureId,
        beforeRevision: closure.revision,
        afterRevision: closure.revision + 1,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
      });
      await this.outbox.enqueue(trx, ClosureLifted, {
        organizationId,
        aggregateType: 'closure',
        aggregateId: closureId,
        correlationId: input.correlationId ?? null,
        payload: {
          closureId,
          facilityId: closure.facility_id,
          resourceId: closure.resource_id,
          interval: {
            start: new Date(closure.start).toISOString(),
            end: new Date(closure.end).toISOString(),
          },
        },
      });
      return this.view((await this.load(trx, organizationId, closureId)) as ClosureRow);
    });
  }

  async getClosure(principal: Principal, closureId: string): Promise<Closure> {
    const organizationId = organizationOf(principal);
    const closure = await this.load(executorFor(this.db), organizationId, closureId);
    if (!closure) throw errors.notFound('closure', closureId);
    await this.authorization.require(principal, SchedulingActions.readInventory, {
      type: 'closure',
      id: closureId,
      organizationId,
      facilityId: closure.facility_id,
    });
    return this.view(closure);
  }

  async listClosures(
    principal: Principal,
    facilityId: string,
    status?: ClosureStatus,
  ): Promise<Closure[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SchedulingActions.readInventory, {
      type: 'closure',
      organizationId,
      facilityId,
    });
    let q = this.baseQuery(executorFor(this.db))
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .orderBy(sql`lower(during)`)
      .orderBy('id');
    if (status) q = q.where('status', '=', status);
    return (await q.execute()).map((r) => this.view(r));
  }

  /**
   * SPK-SCHED-009 / SPK-FAC-003 / §4.7: a closure holds no reservation rows, so applying one locks
   * the closed area's conflict units (every unit of the facility for a facility-wide closure)
   * FOR UPDATE, in id order, before the impact is read. A booking that has already share-locked
   * one of them (`EventWriter.reserve`) is waited for, so its committed reservation is in the
   * impact and is cancelled or listed for resolution; a booking that comes later waits for this
   * transaction and then sees the active closure in its re-check.
   */
  private async lockClosedUnits(
    trx: Trx,
    organizationId: string,
    facilityId: string,
    resourceId: string | null,
  ): Promise<void> {
    let q = trx
      .selectFrom('conflict_units')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId);
    if (resourceId) {
      q = q.where(
        'id',
        'in',
        trx
          .selectFrom('resource_conflict_units')
          .select('conflict_unit_id')
          .where('organization_id', '=', organizationId)
          .where('resource_id', '=', resourceId),
      );
    }
    await q.orderBy('id').forUpdate().execute();
  }

  /** Every published event holding space inside the closed area during the interval, with its owning record and parties. */
  private async computeImpact(
    db: Trx | Db,
    organizationId: string,
    facilityId: string,
    resourceId: string | null,
    interval: Interval,
  ): Promise<ClosureImpact> {
    let q = db
      .selectFrom('reservations as r')
      .innerJoin('events as e', (join) =>
        join.onRef('e.id', '=', 'r.event_id').onRef('e.organization_id', '=', 'r.organization_id'),
      )
      .select(['r.id as reservation_id', 'r.event_id', 'r.resource_id'])
      .where('r.organization_id', '=', organizationId)
      .where('r.status', '=', 'active')
      .where('e.facility_id', '=', facilityId)
      .where(sql<boolean>`r.occupied && ${tstzrange(interval.start, interval.end)}`);
    if (resourceId) {
      q = q.where(
        'r.resource_id',
        'in',
        db
          .selectFrom('resource_conflict_units')
          .select('resource_id')
          .where('organization_id', '=', organizationId)
          .where(
            'conflict_unit_id',
            'in',
            db
              .selectFrom('resource_conflict_units')
              .select('conflict_unit_id')
              .where('organization_id', '=', organizationId)
              .where('resource_id', '=', resourceId),
          ),
      );
    }
    const reservations = await q.execute();
    const eventIds = [...new Set(reservations.map((r) => r.event_id))];
    const events =
      eventIds.length === 0
        ? []
        : await db
            .selectFrom('events')
            .selectAll()
            .where('organization_id', '=', organizationId)
            .where('id', 'in', eventIds)
            .orderBy('scheduled_start')
            .orderBy('id')
            .execute();
    const teams = new Set<string>();
    const people = new Set<string>();
    const equipment = new Set<string>();
    const summary = {
      games: 0,
      programs: 0,
      rentals: 0,
      other: 0,
      teams: 0,
      people: 0,
      equipment: 0,
    };
    const affectedEvents = events.map((event) => {
      const commitments: PartyCommitment[] = this.writer.commitmentsOf(event);
      for (const c of commitments) {
        if (c.partyType === 'team') teams.add(c.partyId);
        else if (c.partyType === 'person') people.add(c.partyId);
        else equipment.add(c.partyId);
      }
      if (event.kind === 'game') summary.games += 1;
      else if (PROGRAM_KINDS.has(event.kind)) summary.programs += 1;
      else if (RENTAL_KINDS.has(event.kind)) summary.rentals += 1;
      else summary.other += 1;
      return {
        eventId: event.id,
        title: event.title,
        kind: event.kind,
        status: event.status,
        scheduledStart: new Date(event.scheduled_start).toISOString(),
        scheduledEnd: new Date(event.scheduled_end).toISOString(),
        sourceType: event.source_type,
        sourceId: event.source_id,
        resourceIds: event.resource_ids,
        reservationIds: reservations
          .filter((r) => r.event_id === event.id)
          .map((r) => r.reservation_id),
        commitments,
      };
    });
    summary.teams = teams.size;
    summary.people = people.size;
    summary.equipment = equipment.size;
    // SPK-SCHED-009, SPK-AT-009: customers, financial obligations and messages come from the
    // modules that own them; committed persons are customers of the event too.
    const contributed = await this.impactContributors.collect(
      db,
      organizationId,
      affectedEvents.map((e) => ({
        eventId: e.eventId,
        kind: e.kind,
        scheduledStart: e.scheduledStart,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        commitments: e.commitments,
      })),
    );
    const customers = new Map(contributed.customers.map((c) => [c.personId, c]));
    for (const e of affectedEvents) {
      for (const c of e.commitments.filter((x) => x.partyType === 'person')) {
        const entry = customers.get(c.partyId) ?? { personId: c.partyId, eventIds: [], via: [] };
        customers.set(c.partyId, {
          personId: c.partyId,
          eventIds: [...new Set([...entry.eventIds, e.eventId])].sort(),
          via: [...new Set([...entry.via, 'commitment' as const])].sort(),
        });
      }
    }
    const customerList = [...customers.values()].sort((a, b) =>
      a.personId.localeCompare(b.personId),
    );
    const sources = new Map<string, { sourceType: string; sourceId: string; eventIds: string[] }>();
    for (const event of events) {
      if (!event.source_type || !event.source_id) continue;
      const key = `${event.source_type}:${event.source_id}`;
      const entry = sources.get(key) ?? {
        sourceType: event.source_type,
        sourceId: event.source_id,
        eventIds: [],
      };
      entry.eventIds.push(event.id);
      sources.set(key, entry);
    }
    return {
      interval: {
        start: new Date(interval.start).toISOString(),
        end: new Date(interval.end).toISOString(),
      },
      affectedEvents,
      sourceRecords: [...sources.values()],
      customers: customerList,
      obligations: contributed.obligations,
      messages: contributed.messages,
      summary: {
        ...summary,
        customers: customerList.length,
        obligations: contributed.obligations.length,
        messages: contributed.messages.length,
      },
    };
  }

  private baseQuery(db: Trx | Db) {
    return db
      .selectFrom('closures')
      .selectAll()
      .select([sql<string>`lower(during)`.as('start'), sql<string>`upper(during)`.as('end')]);
  }

  private async load(
    db: Trx | Db,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<ClosureRow | undefined> {
    let q = this.baseQuery(db).where('organization_id', '=', organizationId).where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private view(row: ClosureRow): Closure {
    return {
      id: row.id,
      facilityId: row.facility_id,
      resourceId: row.resource_id,
      interval: { start: new Date(row.start).toISOString(), end: new Date(row.end).toISOString() },
      reason: row.reason,
      source: row.source,
      status: row.status,
      impact: withImpactDefaults(row.impact as ClosureImpact | null),
      resolution: (row.resolution as Closure['resolution']) ?? null,
      appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
      liftedAt: row.lifted_at ? new Date(row.lifted_at).toISOString() : null,
      withdrawnAt: row.withdrawn_at ? new Date(row.withdrawn_at).toISOString() : null,
      withdrawalReason: row.withdrawal_reason,
      revision: row.revision,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}
