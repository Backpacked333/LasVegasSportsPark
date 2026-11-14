import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  UniformOrderMachine,
  type CorrectUniformHandOverInput,
  type HandOverUniformInput,
  type ListUniformOrdersQuery,
  type OfferingUniform,
  type Principal,
  type UniformOrder,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type UniformOrdersTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import { iso, isoOrNull, organizationOf } from '../enrollment.shared';
import { EnrollmentFacilityScope } from './facility-scope';

type UniformOrderRow = Selectable<UniformOrdersTable>;

/**
 * Uniform orders (SPK-REG-012, proposed amendment PA-07; capability `uniforms`, DEC-101 pending).
 * A uniform is ordered with the registration it was chosen for and follows it
 * (UniformOrderMachine): `ordered` while the registration is pending, `paid` once it is confirmed
 * (a uniform that is not charged is paid with nothing owed), `canceled` with a registration that
 * ended before the hand-over. Handing over is a staff command that records who handed it over and
 * when; it is undone only by a recorded correction with its reason. Both are rows of the
 * append-only `uniform_handover_events`, and migration 0523 refuses a hand-over state that has no
 * such row behind it.
 *
 * The registration's own transitions (confirm, cancel) never check the capability: turning it off
 * stops new uniform choices and hand-overs, not the consequences of what was already bought.
 * Staff keep reading the list while the capability is off (ADR-002).
 */
@Injectable()
export class UniformOrdersService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly scope: EnrollmentFacilityScope,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Following the registration (called inside the registration's own unit of work)
  // -------------------------------------------------------------------------------------------

  /** Orders the uniform chosen on a basket line for the pending enrollment the line became. */
  async order(
    trx: Trx,
    organizationId: string,
    input: {
      enrollmentId: string;
      basketLineId: string;
      offeringId: string;
      participantPersonId: string;
      teamEntryId: string | null;
      uniform: OfferingUniform;
      size: string;
      /**
       * False for a uniform that is not charged: one without a price, or one a returning
       * participant already holds where the offering says it is not charged again. The order
       * then records no price, so the staff list never reads "paid" for what cost nothing.
       */
      charged: boolean;
      correlationId: string | null;
    },
  ): Promise<string> {
    const id = newId();
    try {
      await trx
        .insertInto('uniform_orders')
        .values({
          id,
          organization_id: organizationId,
          enrollment_id: input.enrollmentId,
          basket_line_id: input.basketLineId,
          offering_id: input.offeringId,
          offering_uniform_id: input.uniform.id,
          team_entry_id: input.teamEntryId,
          participant_person_id: input.participantPersonId,
          item_key: input.uniform.itemKey,
          name: input.uniform.name,
          size: input.size,
          price_minor: input.charged ? input.uniform.priceMinor : null,
          currency: input.charged ? input.uniform.currency : null,
          ordered_at: this.clock.now(),
          paid_at: null,
          handed_over_at: null,
          handed_over_by: null,
          handed_over_by_person_id: null,
          canceled_at: null,
          cancel_reason: null,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error) && pgConstraintName(error) === 'uniform_orders_live_idx') {
        throw errors.duplicateEntitlement(
          'This participant already has a uniform on order for this offering.',
          { participantPersonId: input.participantPersonId, offeringId: input.offeringId },
        );
      }
      throw error;
    }
    await this.changed(trx, organizationId, id, input.enrollmentId, 'ordered', input.correlationId);
    return id;
  }

  /** The registration was confirmed: its uniform is paid (nothing is owed for one not charged). */
  async onEnrollmentConfirmed(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.ofEnrollment(trx, organizationId, enrollmentId);
    if (!row || !UniformOrderMachine.can(row.status, 'pay')) return;
    await trx
      .updateTable('uniform_orders')
      .set({
        status: UniformOrderMachine.next(row.status, 'pay'),
        paid_at: this.clock.now(),
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.changed(trx, organizationId, row.id, enrollmentId, 'paid', correlationId);
  }

  /**
   * The registration ended: a uniform not yet handed over is canceled with it. One already handed
   * over stays as it is (the participant holds it); what that means in money is finance's review.
   */
  async onEnrollmentCanceled(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    reason: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.ofEnrollment(trx, organizationId, enrollmentId);
    if (!row || !UniformOrderMachine.can(row.status, 'cancel')) return;
    await trx
      .updateTable('uniform_orders')
      .set({
        status: UniformOrderMachine.next(row.status, 'cancel'),
        canceled_at: this.clock.now(),
        cancel_reason: reason,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.changed(trx, organizationId, row.id, enrollmentId, 'canceled', correlationId);
  }

  private async ofEnrollment(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
  ): Promise<UniformOrderRow | undefined> {
    return trx
      .selectFrom('uniform_orders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .forUpdate()
      .executeTakeFirst();
  }

  private async changed(
    trx: Trx,
    organizationId: string,
    uniformOrderId: string,
    enrollmentId: string,
    status: UniformOrder['status'],
    correlationId: string | null,
  ): Promise<void> {
    await this.outbox.enqueue(trx, EnrollmentEvents.uniformOrderChanged, {
      organizationId,
      aggregateType: 'uniform_order',
      aggregateId: uniformOrderId,
      correlationId,
      payload: { organizationId, uniformOrderId, enrollmentId, status },
    });
  }

  // -------------------------------------------------------------------------------------------
  // GET /uniform-orders
  // -------------------------------------------------------------------------------------------

  /**
   * The uniforms ordered for a class (an offering) or a team (a team entry): size, paid state and
   * hand-over, canceled orders included. Staff only, at the facility of the offering.
   */
  async list(principal: Principal, query: ListUniformOrdersQuery): Promise<UniformOrder[]> {
    const organizationId = organizationOf(principal);
    let q = this.db
      .selectFrom('uniform_orders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('ordered_at')
      .orderBy('id');
    if (query.offeringId) q = q.where('offering_id', '=', query.offeringId);
    if (query.teamEntryId) q = q.where('team_entry_id', '=', query.teamEntryId);
    const rows = await q.execute();
    // §4.3: the list is read at the facilities of the offerings it covers; with nothing ordered
    // the named offering decides (an unknown one is organization-wide and still needs the role).
    const facilities = await this.scope.facilitiesOf(organizationId, [
      query.offeringId,
      ...rows.map((row) => row.offering_id),
    ]);
    await this.scope.requireAt(
      principal,
      EnrollmentActions.readUniformOrders,
      { type: 'uniform_order', organizationId },
      facilities,
    );
    return this.views(organizationId, rows);
  }

  private async views(
    organizationId: string,
    rows: readonly UniformOrderRow[],
    trx?: Trx,
  ): Promise<UniformOrder[]> {
    const personIds = new Set<string>();
    for (const row of rows) {
      personIds.add(row.participant_person_id);
      if (row.handed_over_by_person_id) personIds.add(row.handed_over_by_person_id);
    }
    // Names are read only after the list or the command was authorized (§4.14).
    const names = await this.persons.displayNames(organizationId, [...personIds], trx);
    return rows.map((row) => ({
      id: row.id,
      enrollmentId: row.enrollment_id,
      offeringId: row.offering_id,
      offeringUniformId: row.offering_uniform_id,
      teamEntryId: row.team_entry_id,
      participantPersonId: row.participant_person_id,
      participantDisplayName: names.get(row.participant_person_id)?.displayName ?? null,
      itemKey: row.item_key,
      name: row.name,
      size: row.size,
      priceMinor: row.price_minor,
      currency: row.currency,
      status: row.status,
      orderedAt: iso(row.ordered_at),
      paidAt: isoOrNull(row.paid_at),
      handedOverAt: isoOrNull(row.handed_over_at),
      handedOverBy: row.handed_over_by_person_id
        ? (names.get(row.handed_over_by_person_id)?.displayName ?? null)
        : null,
      canceledAt: isoOrNull(row.canceled_at),
      revision: row.revision,
    }));
  }

  // -------------------------------------------------------------------------------------------
  // POST /uniform-orders/{id}/hand-over and /hand-over-corrections
  // -------------------------------------------------------------------------------------------

  private async forCommand(trx: Trx, principal: Principal, id: string): Promise<UniformOrderRow> {
    const organizationId = organizationOf(principal);
    const row = await trx
      .selectFrom('uniform_orders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('uniform_order', id);
    await this.authorization.require(principal, EnrollmentActions.handOverUniform, {
      type: 'uniform_order',
      id,
      organizationId,
      facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
    });
    await this.capabilities.require(organizationId, 'uniforms', trx);
    return row;
  }

  /** Records that a paid uniform was handed over: who handed it over and when. */
  async handOver(
    principal: Principal,
    id: string,
    input: HandOverUniformInput,
    correlationId: string | null,
  ): Promise<UniformOrder> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.forCommand(trx, principal, id);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = UniformOrderMachine.next(row.status, 'hand_over');
      const now = this.clock.now();
      const eventId = newId();
      // The event first: the order moves to handed over only with it (migration 0523).
      await trx
        .insertInto('uniform_handover_events')
        .values({
          id: eventId,
          organization_id: organizationId,
          uniform_order_id: id,
          kind: 'handed_over',
          corrects_event_id: null,
          reason: input.reason ?? null,
          actor: json(snapshotActor(principal)),
          actor_person_id: principal.personId,
          occurred_at: now,
        })
        .execute();
      const updated = await trx
        .updateTable('uniform_orders')
        .set({
          status,
          handed_over_at: now,
          handed_over_by: json(snapshotActor(principal)),
          handed_over_by_person_id: principal.personId,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw errors.staleRevision(row.revision, row.revision + 1);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.handOverUniform.id,
        targetType: 'uniform_order',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: input.reason ?? null,
        correlationId,
        details: {
          handOverEventId: eventId,
          enrollmentId: row.enrollment_id,
          participantPersonId: row.participant_person_id,
          size: row.size,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.changed(trx, organizationId, id, row.enrollment_id, status, correlationId);
      return (await this.views(organizationId, [updated], trx))[0] as UniformOrder;
    });
  }

  /** Undoes a hand-over by a recorded correction with its reason; the order is paid again. */
  async correctHandOver(
    principal: Principal,
    id: string,
    input: CorrectUniformHandOverInput,
    correlationId: string | null,
  ): Promise<UniformOrder> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.forCommand(trx, principal, id);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = UniformOrderMachine.next(row.status, 'correct_hand_over');
      const handOver = await trx
        .selectFrom('uniform_handover_events as h')
        .select(['h.id'])
        .where('h.organization_id', '=', organizationId)
        .where('h.uniform_order_id', '=', id)
        .where('h.kind', '=', 'handed_over')
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('uniform_handover_events as c')
                .select('c.id')
                .whereRef('c.organization_id', '=', 'h.organization_id')
                .whereRef('c.corrects_event_id', '=', 'h.id'),
            ),
          ),
        )
        .executeTakeFirst();
      if (!handOver) throw errors.internal('a handed-over uniform without its hand-over record');
      const eventId = newId();
      await trx
        .insertInto('uniform_handover_events')
        .values({
          id: eventId,
          organization_id: organizationId,
          uniform_order_id: id,
          kind: 'correction',
          corrects_event_id: handOver.id,
          reason: input.reason,
          actor: json(snapshotActor(principal)),
          actor_person_id: principal.personId,
          occurred_at: this.clock.now(),
        })
        .execute();
      const updated = await trx
        .updateTable('uniform_orders')
        .set({
          status,
          handed_over_at: null,
          handed_over_by: null,
          handed_over_by_person_id: null,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw errors.staleRevision(row.revision, row.revision + 1);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.handOverUniform.id,
        targetType: 'uniform_order',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: input.reason,
        correlationId,
        details: {
          correctionEventId: eventId,
          correctsEventId: handOver.id,
          enrollmentId: row.enrollment_id,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.changed(trx, organizationId, id, row.enrollment_id, status, correlationId);
      return (await this.views(organizationId, [updated], trx))[0] as UniformOrder;
    });
  }
}
