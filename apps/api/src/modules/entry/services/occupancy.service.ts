import { Inject, Injectable } from '@nestjs/common';
import {
  newId,
  type Occupancy,
  type OccupancyQuery,
  type OccupancySnapshot,
  type Principal,
  type TakeOccupancySnapshotBody,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { EntryActions } from '../entry.actions';
import { EntryEvents } from '../entry.events';
import {
  localDayWindow,
  organizationOf,
  toOccupancySnapshot,
  type DayWindow,
} from '../entry.shared';
import { ActivityResolver } from './activity-resolver';

interface Counts {
  arrivalsPeople: number;
  arrivalsVisits: number;
  departuresPeople: number;
  departuresVisits: number;
  recordedOnSite: number;
  openFromEarlierDays: number;
  /** The most recent arrival, departure or void recorded for the facility. */
  lastChangeAt: Date | null;
}

/**
 * Occupancy (SPK-ENTRY-008). Arrivals and departures are counted separately. Arrivals without a
 * recorded departure are a records figure, never presented as verified occupancy: occupancy is
 * verified only by a reconciled snapshot (a physical count, database-enforced) taken after the
 * last arrival, departure or void it could have missed.
 */
@Injectable()
export class OccupancyService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly resolver: ActivityResolver,
  ) {}

  async get(principal: Principal, facilityId: string, query: OccupancyQuery): Promise<Occupancy> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EntryActions.readOccupancy, {
      type: 'facility',
      id: facilityId,
      organizationId,
      facilityId,
    });
    const facility = await this.resolver.facility(organizationId, facilityId);
    const now = this.clock.now();
    const window = localDayWindow(facility.timezone, now, query.date);
    const db = this.uow.reader();
    const counts = await this.counts(db, organizationId, facilityId, window);
    const last = await db
      .selectFrom('occupancy_snapshots')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('window_start', '=', window.start)
      .orderBy('taken_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const lastReconciled = await db
      .selectFrom('occupancy_snapshots')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('window_start', '=', window.start)
      .where('reconciled', '=', true)
      .orderBy('taken_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const verified =
      lastReconciled !== undefined &&
      (counts.lastChangeAt === null ||
        new Date(lastReconciled.taken_at).getTime() >= counts.lastChangeAt.getTime());
    const statement = verified
      ? `Verified occupancy ${lastReconciled.verified_occupancy} from a physical count at ${new Date(
          lastReconciled.taken_at,
        ).toISOString()}; no arrival or departure has been recorded since.`
      : `Arrivals (${counts.arrivalsPeople}) and departures (${counts.departuresPeople}) are recorded separately. ${counts.recordedOnSite} arrived without a recorded departure; this is not verified occupancy until a physical count reconciles it.`;
    return {
      facilityId,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      evaluatedAt: now.toISOString(),
      arrivals: { people: counts.arrivalsPeople, visits: counts.arrivalsVisits },
      departures: { people: counts.departuresPeople, visits: counts.departuresVisits },
      recordedOnSite: counts.recordedOnSite,
      openFromEarlierDays: counts.openFromEarlierDays,
      occupancy: {
        status: verified ? 'verified' : 'unverified',
        verifiedOccupancy: verified ? lastReconciled.verified_occupancy : null,
        reconciledAt: verified ? new Date(lastReconciled.taken_at).toISOString() : null,
        statement,
      },
      lastSnapshot: last ? toOccupancySnapshot(last) : null,
    };
  }

  async snapshot(
    principal: Principal,
    facilityId: string,
    body: TakeOccupancySnapshotBody,
    correlationId: string | null,
  ): Promise<OccupancySnapshot> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EntryActions.reconcileOccupancy, {
      type: 'facility',
      id: facilityId,
      organizationId,
      facilityId,
    });
    const facility = await this.resolver.facility(organizationId, facilityId);
    return this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const window = localDayWindow(facility.timezone, now);
      const counts = await this.counts(trx, organizationId, facilityId, window);
      const reconciled = body.countedOnSite !== undefined;
      const row = await trx
        .insertInto('occupancy_snapshots')
        .values({
          id: newId(),
          organization_id: organizationId,
          facility_id: facilityId,
          taken_at: now,
          window_start: window.start,
          window_end: window.end,
          arrivals: counts.arrivalsPeople,
          departures: counts.departuresPeople,
          recorded_on_site: counts.recordedOnSite,
          open_from_earlier_days: counts.openFromEarlierDays,
          reconciled,
          counted_on_site: body.countedOnSite ?? null,
          verified_occupancy: body.countedOnSite ?? null,
          discrepancy: reconciled ? (body.countedOnSite ?? 0) - counts.recordedOnSite : null,
          reconciliation_note: body.note ?? null,
          taken_by: json(snapshotActor(principal)),
          taken_by_person_id: principal.personId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.reconcileOccupancy.id,
        targetType: 'occupancy_snapshot',
        targetId: row.id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        details: { reconciled, discrepancy: row.discrepancy },
      });
      await this.outbox.enqueue(trx, EntryEvents.occupancySnapshotTaken, {
        organizationId,
        aggregateType: 'occupancy_snapshot',
        aggregateId: row.id,
        payload: { snapshotId: row.id, facilityId, reconciled },
        correlationId,
      });
      return toOccupancySnapshot(row);
    });
  }

  private async counts(
    db: Db | Trx,
    organizationId: string,
    facilityId: string,
    window: DayWindow,
  ): Promise<Counts> {
    const arrivals = await db
      .selectFrom('visits')
      .select((eb) => [
        eb.fn.countAll<string>().as('visits'),
        sql<string>`coalesce(sum(party_size), 0)`.as('people'),
      ])
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('status', '<>', 'voided')
      .where('arrived_at', '>=', window.start)
      .where('arrived_at', '<', window.end)
      .executeTakeFirstOrThrow();
    const departures = await db
      .selectFrom('departures')
      .innerJoin('visits', (join) =>
        join
          .onRef('visits.organization_id', '=', 'departures.organization_id')
          .onRef('visits.id', '=', 'departures.visit_id'),
      )
      .select((eb) => [
        eb.fn.countAll<string>().as('visits'),
        sql<string>`coalesce(sum(visits.party_size), 0)`.as('people'),
      ])
      .where('departures.organization_id', '=', organizationId)
      .where('departures.facility_id', '=', facilityId)
      .where('departures.departed_at', '>=', window.start)
      .where('departures.departed_at', '<', window.end)
      .executeTakeFirstOrThrow();
    const onSite = await db
      .selectFrom('visits')
      .select([
        sql<string>`coalesce(sum(party_size) filter (where arrived_at >= ${window.start}), 0)`.as(
          'today',
        ),
        sql<string>`coalesce(sum(party_size) filter (where arrived_at < ${window.start}), 0)`.as(
          'earlier',
        ),
      ])
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('status', '=', 'on_site')
      .where('arrived_at', '<', window.end)
      .executeTakeFirstOrThrow();
    const lastVisit = await db
      .selectFrom('visits')
      .select(
        sql<Date | null>`max(greatest(received_at, coalesce(voided_at, received_at)))`.as('at'),
      )
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .executeTakeFirstOrThrow();
    const lastDeparture = await db
      .selectFrom('departures')
      .select(sql<Date | null>`max(received_at)`.as('at'))
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .executeTakeFirstOrThrow();
    const times = [lastVisit.at, lastDeparture.at]
      .filter((t): t is Date => t !== null)
      .map((t) => new Date(t).getTime());
    return {
      arrivalsPeople: Number(arrivals.people),
      arrivalsVisits: Number(arrivals.visits),
      departuresPeople: Number(departures.people),
      departuresVisits: Number(departures.visits),
      recordedOnSite: Number(onSite.today),
      openFromEarlierDays: Number(onSite.earlier),
      lastChangeAt: times.length > 0 ? new Date(Math.max(...times)) : null,
    };
  }
}
