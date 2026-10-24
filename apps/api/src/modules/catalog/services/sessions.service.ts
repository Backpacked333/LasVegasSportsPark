import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CancelOfferingSessionInput,
  type CreateOfferingSessionInput,
  type OfferingSession,
  type Principal,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  type Clock,
} from '../../../kernel';
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import { relaxedStaffingRatios, requiredStaffFor } from '../catalog.policy';
import { capacityUnitsOf, organizationOf, toOfferingSession } from '../catalog.shared';
import { EDITABLE_PUBLICATION_STATES, OfferingSessionMachine } from '../catalog.state-machines';
import { OfferingsService } from './offerings.service';

/**
 * Individual sessions of an offering (§4.4 Session, SPK-CAT-002). A session may point at the
 * scheduling event that reserves its space; scheduling remains the authority for that event.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly offerings: OfferingsService,
  ) {}

  async create(
    principal: Principal,
    offeringId: string,
    body: CreateOfferingSessionInput,
    correlationId: string | null,
  ): Promise<OfferingSession> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const offering = await this.offerings.loadOffering(trx, organizationId, offeringId, true);
      if (!offering) throw errors.notFound('offering', offeringId);
      await this.authorization.require(principal, CatalogActions.manageSessions, {
        type: 'offering_session',
        organizationId,
        facilityId: offering.facility_id,
      });
      if (!EDITABLE_PUBLICATION_STATES.includes(offering.publication_state)) {
        throw errors.invalidTransition(
          'OfferingPublication',
          offering.publication_state,
          'add_session',
        );
      }
      const overrideStaffing = body.capacityOverride
        ? await this.checkCapacityOverride(principal, offering, body)
        : null;
      const latest = await trx
        .selectFrom('offering_sessions')
        .select((eb) => eb.fn.max('sequence').as('sequence'))
        .where('organization_id', '=', organizationId)
        .where('offering_id', '=', offeringId)
        .executeTakeFirst();
      const sequence = body.sequence ?? (latest?.sequence ?? 0) + 1;
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('offering_sessions')
          .values({
            id,
            organization_id: organizationId,
            offering_id: offeringId,
            sequence,
            title: body.title ?? null,
            scheduled_start: new Date(body.scheduledStart),
            scheduled_end: new Date(body.scheduledEnd),
            scheduling_event_id: body.schedulingEventId ?? null,
            capacity_override:
              body.capacityOverride === undefined ? null : json(body.capacityOverride),
            canceled_at: null,
            cancel_reason: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A session with this sequence already exists.', {
            sequence,
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.session_created',
        targetType: 'offering_session',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: overrideStaffing
          ? { offeringId, sequence, capacityOverride: body.capacityOverride, ...overrideStaffing }
          : { offeringId, sequence },
      });
      await this.outbox.enqueue(trx, CatalogEvents.sessionCreated, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: offeringId,
        payload: {
          sessionId: id,
          offeringId,
          sequence,
          scheduledStart: new Date(row.scheduled_start).toISOString(),
          scheduledEnd: new Date(row.scheduled_end).toISOString(),
          schedulingEventId: row.scheduling_event_id,
          capacityOverride: body.capacityOverride ?? null,
        },
        correlationId,
      });
      return toOfferingSession(row);
    });
  }

  /**
   * SPK-YOUTH-002: a session capacity override is commercial capacity (enrollment holds session
   * places against it instead of the offering's units), so it is offering configuration: it needs
   * the offering manager's authority, follows the camp-group publication rule, and an override that
   * raises the staffing requirement, removes or relaxes a staffing ratio, or adds unstaffed places
   * to a staffed offering needs an explicit reason. Overrides are not re-validated at publication,
   * so the rule applies in every editable state.
   */
  private async checkCapacityOverride(
    principal: Principal,
    offering: {
      id: string;
      organization_id: string;
      facility_id: string;
      capacity_units: unknown[];
    },
    body: CreateOfferingSessionInput,
  ) {
    const override = body.capacityOverride ?? [];
    await this.authorization.require(principal, CatalogActions.manageOfferings, {
      type: 'offering',
      id: offering.id,
      organizationId: offering.organization_id,
      facilityId: offering.facility_id,
    });
    if (
      override.some((u) => u.unit === 'camp_group_places' && (!u.groupSize || !u.staffingRatio))
    ) {
      throw errors.validation(
        'Camp group places require a group size and a staffing ratio (SPK-YOUTH-002).',
        { path: 'capacityOverride' },
      );
    }
    const base = capacityUnitsOf(offering);
    const requiredStaffOffering = requiredStaffFor(base);
    const requiredStaffOverride = requiredStaffFor(override);
    const ratiosRelaxed = relaxedStaffingRatios(base, override);
    const unstaffedUnits =
      requiredStaffOffering > 0 ? override.filter((u) => !u.staffingRatio).map((u) => u.unit) : [];
    if (
      (requiredStaffOverride > requiredStaffOffering ||
        ratiosRelaxed.length > 0 ||
        unstaffedUnits.length > 0) &&
      !body.reason
    ) {
      throw errors.validation(
        "This session capacity override bypasses the offering's staffing requirement; provide a reason confirming staffing is arranged (SPK-YOUTH-002).",
        {
          path: 'reason',
          requiredStaffOffering,
          requiredStaffOverride,
          ratiosRelaxed,
          unstaffedUnits,
        },
      );
    }
    return { requiredStaffOffering, requiredStaffOverride, ratiosRelaxed, unstaffedUnits };
  }

  async cancel(
    principal: Principal,
    id: string,
    body: CancelOfferingSessionInput,
    correlationId: string | null,
  ): Promise<OfferingSession> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('offering_sessions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('session', id);
      const offering = await this.offerings.loadOffering(trx, organizationId, current.offering_id);
      if (!offering) throw errors.notFound('offering', current.offering_id);
      await this.authorization.require(principal, CatalogActions.manageSessions, {
        type: 'offering_session',
        id,
        organizationId,
        facilityId: offering.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = OfferingSessionMachine.next(current.status, 'cancel');
      const updated = await trx
        .updateTable('offering_sessions')
        .set({
          status: next,
          canceled_at: this.clock.now(),
          cancel_reason: body.reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.session_canceled',
        targetType: 'offering_session',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, CatalogEvents.sessionCanceled, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: current.offering_id,
        payload: {
          sessionId: id,
          offeringId: current.offering_id,
          sequence: current.sequence,
          schedulingEventId: current.scheduling_event_id,
          reason: body.reason,
        },
        correlationId,
      });
      return toOfferingSession(updated);
    });
  }

  /** Same visibility rule as the offering itself (public when published, every state for staff). */
  async list(principal: Principal, offeringId: string): Promise<OfferingSession[]> {
    const { row } = await this.offerings.loadVisible(principal, offeringId);
    const rows = await this.db
      .selectFrom('offering_sessions')
      .selectAll()
      .where('organization_id', '=', row.organization_id)
      .where('offering_id', '=', row.id)
      .orderBy('sequence')
      .execute();
    return rows.map(toOfferingSession);
  }
}
