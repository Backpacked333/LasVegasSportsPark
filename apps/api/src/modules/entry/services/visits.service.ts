import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type Departure,
  type ListVisitsQuery,
  type Page,
  type Principal,
  type RecordDepartureBody,
  type RecordedVisits,
  type RecordVisitsBody,
  type Visit,
  type VisitorCategory,
  type VoidVisitBody,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db, type DepartureSource } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  ensureUpdated,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { EntryActions } from '../entry.actions';
import { EntryEvents } from '../entry.events';
import { ENTRY_POLICY, policyForFacility, type EntryPolicy } from '../entry.policy';
import {
  localDayWindow,
  organizationOf,
  toDeparture,
  toVisit,
  type DepartureRow,
  type VisitRow,
} from '../entry.shared';
import { VisitMachine } from '../entry.state-machines';
import { ActivityResolver } from './activity-resolver';
import { lockEntrySubjects, presenceLockKey } from './subject-locks';

const VisitCursor = z.object({ arrivedAt: z.iso.datetime(), id: z.uuid() });

export interface NewVisit {
  facilityId: string;
  personId: string | null;
  visitorDescription?: string | null;
  partySize?: number;
  visitorCategory: VisitorCategory;
  arrivedAt: Date;
  passId?: string | null;
  source: 'desk' | 'offline_sync' | 'access_control';
  deviceId?: string | null;
  clientObservationId?: string | null;
  syncBatchId?: string | null;
  accessEventRef?: string | null;
}

export interface NewDeparture {
  visit: VisitRow;
  departedAt: Date;
  source: DepartureSource;
  releaseRecordId?: string | null;
  deviceId?: string | null;
  clientObservationId?: string | null;
  syncBatchId?: string | null;
}

/**
 * Facility arrival and departure (SPK-ENTRY-001, SPK-ENTRY-003, SPK-ENTRY-006, SPK-ENTRY-008).
 * Staff record the people who actually arrived, each in a visitor category; a visit never creates
 * an enrollment, a check-in or an attendance observation. A child participant, or a child with a
 * live session check-in, leaves through a supervised release (ReleasesService), which records the
 * departure itself (`releaseRequired`).
 */
@Injectable()
export class VisitsService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENTRY_POLICY) private readonly policy: EntryPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly resolver: ActivityResolver,
  ) {}

  async record(
    principal: Principal,
    body: RecordVisitsBody,
    correlationId: string | null,
  ): Promise<RecordedVisits> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EntryActions.recordArrival, {
      type: 'facility',
      id: body.facilityId,
      organizationId,
      facilityId: body.facilityId,
    });
    return this.uow.run(async ({ trx }) => {
      await this.resolver.facility(organizationId, body.facilityId, trx);
      if (body.passId) {
        const pass = await trx
          .selectFrom('passes')
          .select(['id', 'status'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', body.passId)
          .executeTakeFirst();
        if (!pass) throw errors.notFound('pass', body.passId);
        if (pass.status !== 'active') {
          throw errors.resourceConflict('This pass has been revoked.', {
            code: 'pass_revoked',
            passId: pass.id,
          });
        }
      }
      const personIds = body.arrivals.flatMap((a) => (a.personId ? [a.personId] : []));
      for (const personId of personIds) {
        const person = await this.people.findPerson(organizationId, personId, trx);
        if (!person || person.status !== 'active') throw errors.notFound('person', personId);
      }
      if (personIds.length > 0) {
        const open = await trx
          .selectFrom('visits')
          .select(['id', 'person_id'])
          .where('organization_id', '=', organizationId)
          .where('facility_id', '=', body.facilityId)
          .where('status', '=', 'on_site')
          .where('person_id', 'in', personIds)
          .execute();
        if (open.length > 0) {
          throw errors.resourceConflict('Already on site: record a departure first.', {
            code: 'already_on_site',
            visits: open.map((v) => ({ personId: v.person_id, visitId: v.id })),
          });
        }
      }
      const now = this.clock.now();
      const visits: Visit[] = [];
      for (const arrival of body.arrivals) {
        const row = await this.insertVisit(trx, principal, organizationId, {
          facilityId: body.facilityId,
          personId: arrival.personId ?? null,
          visitorDescription: arrival.visitorDescription ?? null,
          partySize: arrival.partySize ?? 1,
          visitorCategory: arrival.visitorCategory,
          arrivedAt: now,
          passId: body.passId ?? null,
          source: 'desk',
        });
        // A concurrent arrival of the same person won the one-open-visit index.
        if (!row) {
          throw errors.resourceConflict('Already on site: record a departure first.', {
            code: 'already_on_site',
          });
        }
        await this.afterVisit(trx, principal, organizationId, row, correlationId, body.reason);
        visits.push(toVisit(row));
      }
      return { visits };
    });
  }

  async void(
    principal: Principal,
    id: string,
    body: VoidVisitBody,
    correlationId: string | null,
  ): Promise<Visit> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const visit = await this.load(trx, organizationId, id);
      if (!visit) throw errors.notFound('visit', id);
      await this.authorization.require(principal, EntryActions.voidVisit, {
        type: 'visit',
        id,
        organizationId,
        facilityId: visit.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, visit.revision);
      const status = VisitMachine.next(visit.status, 'void');
      const now = this.clock.now();
      const result = await trx
        .updateTable('visits')
        .set({ status, voided_at: now, void_reason: body.reason, revision: visit.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', visit.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(body.expectedRevision, visit.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.voidVisit.id,
        targetType: 'visit',
        targetId: id,
        beforeRevision: visit.revision,
        afterRevision: visit.revision + 1,
        reason: body.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, EntryEvents.visitClosed, {
        organizationId,
        aggregateType: 'visit',
        aggregateId: id,
        payload: { visitId: id, facilityId: visit.facility_id, status: 'voided' },
        correlationId,
      });
      const updated = await this.load(trx, organizationId, id);
      if (!updated) throw errors.notFound('visit', id);
      return toVisit(updated);
    });
  }

  async list(principal: Principal, query: ListVisitsQuery): Promise<Page<Visit>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EntryActions.readVisits, {
      type: 'facility',
      id: query.facilityId,
      organizationId,
      facilityId: query.facilityId,
    });
    const facility = await this.resolver.facility(organizationId, query.facilityId);
    const window = localDayWindow(facility.timezone, this.clock.now(), query.date);
    const cursor = decodeCursor(query.cursor, VisitCursor);
    let q = this.uow
      .reader()
      .selectFrom('visits')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', query.facilityId)
      .where('arrived_at', '>=', window.start)
      .where('arrived_at', '<', window.end)
      .orderBy('arrived_at')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) {
      q = q.where(
        sql<boolean>`(arrived_at, id) > (${new Date(cursor.arrivedAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : undefined;
    return {
      items: page.map(toVisit),
      nextCursor: last
        ? encodeCursor({ arrivedAt: new Date(last.arrived_at).toISOString(), id: last.id })
        : null,
    };
  }

  async depart(
    principal: Principal,
    body: RecordDepartureBody,
    correlationId: string | null,
  ): Promise<Departure> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const found = body.visitId
        ? await this.load(trx, organizationId, body.visitId)
        : await this.openVisit(trx, organizationId, body.facilityId ?? '', body.personId ?? '');
      if (!found) throw errors.notFound('visit', body.visitId);
      // §4.15: serialized with offline synchronization of this person's presence (an offline
      // departure or release of the same visit then sees this one, and the reverse).
      if (found.person_id) {
        await lockEntrySubjects(trx, [presenceLockKey(organizationId, found.person_id)]);
      }
      const visit = (await this.load(trx, organizationId, found.id)) ?? found;
      await this.authorization.require(principal, EntryActions.recordDeparture, {
        type: 'visit',
        id: visit.id,
        organizationId,
        facilityId: visit.facility_id,
      });
      VisitMachine.next(visit.status, 'depart');
      const facility = await this.resolver.facility(organizationId, visit.facility_id, trx);
      const policy = policyForFacility(this.policy, facility.settings);
      if (await this.releaseRequired(trx, organizationId, visit, policy)) {
        throw errors.resourceConflict(
          'A child in a supervised activity leaves through a supervised release (POST /v1/releases).',
          { code: 'release_required', visitId: visit.id },
        );
      }
      const departure = await this.recordDeparture(
        trx,
        principal,
        organizationId,
        {
          visit,
          departedAt: this.clock.now(),
          source: 'desk',
        },
        correlationId,
      );
      return toDeparture(departure);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Shared with releases, offline synchronization and access events
  // -------------------------------------------------------------------------------------------

  /**
   * Whether the visit may close only through a supervised release (SPK-ENTRY-007, SPK-COND-004,
   * §4.15). The rule follows the person, not the visit's category label: a child on a
   * `participant` visit, or a child with a live (held or admitted) session check-in on this visit
   * or at this facility for an activity that had not ended when the visit began. A turnstile
   * arrival (`unclassified`) or a desk arrival recorded as a spectator therefore never removes
   * the pickup check from a child admitted to a supervised session. Spectators, guardians and
   * children with no live check-in leave by a plain departure (SPK-ENTRY-006). Whether supervised
   * pickup applies at all is DEC-075 (pending); the facility policy flag keeps the conservative
   * default (`childParticipantDepartureRequiresRelease: true`).
   */
  async releaseRequired(
    trx: Trx,
    organizationId: string,
    visit: VisitRow,
    policy: EntryPolicy,
  ): Promise<boolean> {
    if (!policy.childParticipantDepartureRequiresRelease || !visit.person_id) return false;
    const person = await this.people.findPerson(organizationId, visit.person_id, trx);
    if (person?.kind !== 'child') return false;
    if (visit.visitor_category === 'participant') return true;
    const live = await trx
      .selectFrom('session_checkins')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', visit.person_id)
      .where('status', 'in', ['held', 'admitted'])
      .where((eb) =>
        eb.or([
          eb('visit_id', '=', visit.id),
          eb.and([
            eb('facility_id', '=', visit.facility_id),
            eb('activity_end', '>', new Date(visit.arrived_at)),
          ]),
        ]),
      )
      .executeTakeFirst();
    return live !== undefined;
  }

  /** Inserts a visit; returns null when a unique key already holds it (client id or access event). */
  async insertVisit(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    input: NewVisit,
  ): Promise<VisitRow | null> {
    const id = newId();
    const row = await trx
      .insertInto('visits')
      .values({
        id,
        organization_id: organizationId,
        facility_id: input.facilityId,
        person_id: input.personId,
        visitor_description: input.visitorDescription ?? null,
        party_size: input.partySize ?? 1,
        visitor_category: input.visitorCategory,
        arrived_at: input.arrivedAt,
        pass_id: input.passId ?? null,
        source: input.source,
        device_id: input.deviceId ?? null,
        client_observation_id: input.clientObservationId ?? null,
        sync_batch_id: input.syncBatchId ?? null,
        access_event_ref: input.accessEventRef ?? null,
        departed_at: null,
        voided_at: null,
        void_reason: null,
        recorded_by: json(snapshotActor(principal)),
        recorded_by_person_id: principal.personId,
        received_at: this.clock.now(),
      })
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  }

  async afterVisit(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    row: VisitRow,
    correlationId: string | null,
    reason?: string | null,
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: EntryActions.recordArrival.id,
      targetType: 'visit',
      targetId: row.id,
      afterRevision: 1,
      reason: reason ?? null,
      correlationId,
      details: {
        visitorCategory: row.visitor_category,
        source: row.source,
        partySize: row.party_size,
      },
    });
    await this.outbox.enqueue(trx, EntryEvents.visitRecorded, {
      organizationId,
      aggregateType: 'visit',
      aggregateId: row.id,
      payload: {
        visitId: row.id,
        facilityId: row.facility_id,
        personId: row.person_id,
        visitorCategory: row.visitor_category,
        partySize: row.party_size,
        source: row.source,
      },
      correlationId,
    });
  }

  /** Records the departure of an open visit and closes it (one departure per visit, database-enforced). */
  async recordDeparture(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    input: NewDeparture,
    correlationId: string | null,
  ): Promise<DepartureRow> {
    const { visit } = input;
    const status = VisitMachine.next(visit.status, 'depart');
    const departedAt =
      input.departedAt.getTime() < new Date(visit.arrived_at).getTime()
        ? new Date(visit.arrived_at)
        : input.departedAt;
    const departure = await trx
      .insertInto('departures')
      .values({
        id: newId(),
        organization_id: organizationId,
        facility_id: visit.facility_id,
        visit_id: visit.id,
        person_id: visit.person_id,
        departed_at: departedAt,
        release_record_id: input.releaseRecordId ?? null,
        source: input.source,
        device_id: input.deviceId ?? null,
        client_observation_id: input.clientObservationId ?? null,
        sync_batch_id: input.syncBatchId ?? null,
        recorded_by: json(snapshotActor(principal)),
        recorded_by_person_id: principal.personId,
        received_at: this.clock.now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('This visit already has a departure.', {
            code: 'already_departed',
            visitId: visit.id,
          });
        }
        throw error;
      });
    const result = await trx
      .updateTable('visits')
      .set({ status, departed_at: departedAt, revision: visit.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', visit.id)
      .where('revision', '=', visit.revision)
      .executeTakeFirst();
    ensureUpdated(result.numUpdatedRows, () =>
      errors.staleRevision(visit.revision, visit.revision + 1),
    );
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: EntryActions.recordDeparture.id,
      targetType: 'departure',
      targetId: departure.id,
      afterRevision: 1,
      correlationId,
      details: {
        visitId: visit.id,
        source: input.source,
        releaseRecordId: departure.release_record_id,
      },
    });
    await this.outbox.enqueue(trx, EntryEvents.departureRecorded, {
      organizationId,
      aggregateType: 'departure',
      aggregateId: departure.id,
      payload: {
        departureId: departure.id,
        visitId: visit.id,
        facilityId: visit.facility_id,
        personId: visit.person_id,
        releaseRecordId: departure.release_record_id,
      },
      correlationId,
    });
    await this.outbox.enqueue(trx, EntryEvents.visitClosed, {
      organizationId,
      aggregateType: 'visit',
      aggregateId: visit.id,
      payload: { visitId: visit.id, facilityId: visit.facility_id, status: 'departed' },
      correlationId,
    });
    return departure;
  }

  async load(db: Db | Trx, organizationId: string, id: string): Promise<VisitRow | undefined> {
    return db
      .selectFrom('visits')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async openVisit(
    db: Db | Trx,
    organizationId: string,
    facilityId: string,
    personId: string,
  ): Promise<VisitRow | undefined> {
    if (!facilityId || !personId) return undefined;
    return db
      .selectFrom('visits')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('person_id', '=', personId)
      .where('status', '=', 'on_site')
      .executeTakeFirst();
  }
}
