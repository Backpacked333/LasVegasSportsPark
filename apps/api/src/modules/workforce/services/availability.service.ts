import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type StaffAvailability,
  type CreateAvailabilityBody,
  type ListAvailabilityQuery,
  type Principal,
  type WithdrawAvailabilityBody,
} from '@sportspark/contracts';
import { isExclusionViolation, type Db } from '@sportspark/db';
import { json } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { WorkforceActions } from '../workforce.actions';
import { WorkforceEvents } from '../workforce.events';
import { AvailabilityMachine } from '../workforce.state-machines';
import { organizationOf, toAvailability, type AvailabilityRow } from '../workforce.shared';

/**
 * Availability windows (SPK-STAFF-001). A person states when they can or cannot work; staff
 * planning coverage read them, and the replacement workflow explains candidates with them.
 * The exclusion constraint `availability_no_overlap` keeps one active statement per instant.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async create(
    principal: Principal,
    body: CreateAvailabilityBody,
    correlationId: string | null,
  ): Promise<StaffAvailability> {
    const organizationId = organizationOf(principal);
    const personId = body.personId ?? principal.personId;
    if (!personId) throw errors.validation('personId is required.');
    const self = personId === principal.personId;
    await this.authorization.require(
      principal,
      self ? WorkforceActions.manageOwnAvailability : WorkforceActions.manageAvailability,
      { type: 'availability', organizationId, subjectPersonIds: [personId] },
    );
    const start = new Date(body.interval.start);
    const end = new Date(body.interval.end);
    return this.uow.run(async ({ trx }) => {
      const person = await this.people.findPerson(organizationId, personId, trx);
      if (!person || person.status !== 'active') throw errors.notFound('person', personId);
      const overlapping = await this.overlapping(trx, organizationId, personId, start, end);
      if (overlapping.length > 0) {
        throw errors.resourceConflict(
          'The window overlaps another active availability statement of the person.',
          {
            conflicts: [
              { code: 'availability_overlap', availabilityIds: overlapping.map((r) => r.id) },
            ],
          },
        );
      }
      const id = newId();
      try {
        await trx
          .insertInto('availability')
          .values({
            id,
            organization_id: organizationId,
            person_id: personId,
            starts_at: start,
            ends_at: end,
            kind: body.kind,
            note: body.note ?? null,
            withdrawn_at: null,
            withdrawn_reason: null,
            recorded_by: json(snapshotActor(principal)),
            recorded_by_person_id: principal.personId,
          })
          .execute();
      } catch (error) {
        if (isExclusionViolation(error)) {
          throw errors.resourceConflict(
            'A concurrent availability statement overlaps this window.',
            { conflicts: [{ code: 'availability_overlap', availabilityIds: [] }] },
          );
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: self
          ? WorkforceActions.manageOwnAvailability.id
          : WorkforceActions.manageAvailability.id,
        targetType: 'availability',
        targetId: id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        details: { personId, kind: body.kind },
      });
      const row = await this.load(trx, organizationId, id);
      await this.notify(trx, row as AvailabilityRow, correlationId);
      return toAvailability(row as AvailabilityRow);
    });
  }

  async list(principal: Principal, query: ListAvailabilityQuery): Promise<StaffAvailability[]> {
    const organizationId = organizationOf(principal);
    const personId = query.personId ?? principal.personId;
    if (!personId) throw errors.validation('personId is required.');
    await this.authorization.require(principal, WorkforceActions.readAvailability, {
      type: 'availability',
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    let q = this.db
      .selectFrom('availability')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .orderBy('starts_at')
      .orderBy('id');
    if (!query.includeWithdrawn) q = q.where('status', '=', 'active');
    if (query.from) q = q.where('ends_at', '>', new Date(query.from));
    if (query.to) q = q.where('starts_at', '<', new Date(query.to));
    return (await q.execute()).map(toAvailability);
  }

  async withdraw(
    principal: Principal,
    id: string,
    body: WithdrawAvailabilityBody,
    correlationId: string | null,
  ): Promise<StaffAvailability> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id, true);
      if (!current) throw errors.protectedNotFound('availability');
      const self = current.person_id === principal.personId;
      // Existence is revealed only to someone who may read the person's availability (§4.10).
      await this.authorization.require(principal, WorkforceActions.readAvailability, {
        type: 'availability',
        id,
        organizationId,
        subjectPersonIds: [current.person_id],
        protected: true,
      });
      await this.authorization.require(
        principal,
        self ? WorkforceActions.manageOwnAvailability : WorkforceActions.manageAvailability,
        { type: 'availability', id, organizationId, subjectPersonIds: [current.person_id] },
      );
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = AvailabilityMachine.next(current.status, 'withdraw');
      await trx
        .updateTable('availability')
        .set({
          status: next,
          withdrawn_at: this.clock.now(),
          withdrawn_reason: body.reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'workforce.availability_withdrawn',
        targetType: 'availability',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: body.reason,
        correlationId,
      });
      const row = (await this.load(trx, organizationId, id)) as AvailabilityRow;
      await this.notify(trx, row, correlationId);
      return toAvailability(row);
    });
  }

  /** Active windows of the person overlapping [start, end). */
  async overlapping(
    db: Db | Trx,
    organizationId: string,
    personId: string,
    start: Date,
    end: Date,
  ): Promise<AvailabilityRow[]> {
    return db
      .selectFrom('availability')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('status', '=', 'active')
      .where('starts_at', '<', end)
      .where('ends_at', '>', start)
      .orderBy('starts_at')
      .execute();
  }

  private async load(
    db: Db | Trx,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<AvailabilityRow | undefined> {
    let q = db
      .selectFrom('availability')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async notify(trx: Trx, row: AvailabilityRow, correlationId: string | null) {
    await this.outbox.enqueue(trx, WorkforceEvents.availabilityChanged, {
      organizationId: row.organization_id,
      aggregateType: 'availability',
      aggregateId: row.id,
      correlationId,
      payload: {
        availabilityId: row.id,
        personId: row.person_id,
        kind: row.kind,
        status: row.status,
        start: new Date(row.starts_at).toISOString(),
        end: new Date(row.ends_at).toISOString(),
      },
    });
  }
}
