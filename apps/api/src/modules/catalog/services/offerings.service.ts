import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  PUBLIC_PUBLICATION_STATES,
  z,
  type AgeBand,
  type CapacityUnit,
  type CopyOfferingInput,
  type DstResolution,
  type CreateOfferingInput,
  type ListProgramOfferingsQuery,
  type ListPublicOfferingsQuery,
  type Offering,
  type OfferingTransitionInput,
  type Page,
  type Principal,
  type PublicationProblem,
  type PublicOffering,
  type UpdateOfferingInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
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
import {
  addDays as addLocalDays,
  DEFAULT_DST_POLICY,
  localDateOf,
  localTimeOf,
  resolveLocal,
} from '../../scheduling';
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import { staffingIncreaseNeedsReason } from '../catalog.policy';
import type { OfferingLookupPort, OfferingSnapshot } from '../catalog.ports';
import {
  capacityUnitsOf,
  eligibilityReferenceDateOf,
  offeringColumns,
  organizationOf,
  toEntitlementDefinition,
  toOffering,
  toPublicOffering,
  type OfferingRow,
  type OfferingViewContext,
} from '../catalog.shared';
import {
  EDITABLE_PUBLICATION_STATES,
  OfferingPublicationMachine,
  type OfferingPublicationEvent,
} from '../catalog.state-machines';
import { PoliciesService } from './policies.service';
import { PriceRulesService } from './price-rules.service';

const Cursor = z.object({ startsOn: z.string(), id: z.string() });

export function addDays(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

interface ReferenceInput {
  facilityId?: string;
  eligibilityPolicyVersionId?: string | null;
  cancellationPolicyVersionId?: string | null;
  entitlementDefinitionId?: string | null;
  responsibleManagerPersonId?: string | null;
  requiredFormPolicyVersionIds?: readonly string[];
}

/**
 * Offerings (SPK-CAT-001..004): dated, located, priced instances of a program with eligibility,
 * entitlement, capacity, forms, cancellation policy, responsible manager and a publication
 * lifecycle. Publication validates the required configuration and the database refuses a
 * published row without it; registration opening is a distinct command whose pause preserves
 * participation; a copy is a new draft with no transactional data (SPK-CAT-003).
 */
@Injectable()
export class OfferingsService implements OfferingLookupPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly priceRules: PriceRulesService,
    private readonly policies: PoliciesService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    body: CreateOfferingInput,
    correlationId: string | null,
  ): Promise<Offering> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.manageOfferings, {
      type: 'offering',
      organizationId,
      facilityId: body.facilityId,
    });
    return this.uow.run(async ({ trx }) => {
      const program = await trx
        .selectFrom('programs')
        .select(['id', 'status', 'activity_type', 'format'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', body.programId)
        .executeTakeFirst();
      if (!program) throw errors.notFound('program', body.programId);
      if (program.status === 'archived') {
        throw errors.invalidTransition('Program', 'archived', 'add_offering');
      }
      await this.validateReferences(trx, organizationId, body);
      const id = newId();
      await trx
        .insertInto('offerings')
        .values({
          id,
          organization_id: organizationId,
          program_id: body.programId,
          facility_id: body.facilityId,
          name: body.name,
          description: body.description ?? null,
          kind: body.kind,
          activity_type: body.activityType ?? program.activity_type,
          format: body.format ?? program.format,
          location: json(body.location),
          starts_on: body.startsOn,
          ends_on: body.endsOn,
          registration_opens_at: body.registrationOpensAt
            ? new Date(body.registrationOpensAt)
            : null,
          registration_closes_at: body.registrationClosesAt
            ? new Date(body.registrationClosesAt)
            : null,
          eligibility_reference_date: body.eligibilityReferenceDate ?? null,
          eligibility_policy_version_id: body.eligibilityPolicyVersionId ?? null,
          entitlement_definition_id: body.entitlementDefinitionId ?? null,
          capacity_units: json(body.capacityUnits),
          cancellation_policy_version_id: body.cancellationPolicyVersionId ?? null,
          responsible_manager_person_id: body.responsibleManagerPersonId ?? null,
          published_at: null,
          registration_opened_at: null,
          closed_at: null,
          archived_at: null,
          copied_from_offering_id: null,
          created_by: json(snapshotActor(principal)),
        })
        .execute();
      await this.replaceRequiredForms(trx, organizationId, id, body.requiredFormPolicyVersionIds);
      const row = await this.loadOffering(trx, organizationId, id);
      if (!row) throw errors.internal('offering vanished after insert');
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.offering_created',
        targetType: 'offering',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: { programId: body.programId, kind: body.kind, facilityId: body.facilityId },
      });
      await this.outbox.enqueue(trx, CatalogEvents.offeringCreated, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: id,
        payload: this.ref(row),
        correlationId,
      });
      return this.view(trx, row, true);
    });
  }

  async update(
    principal: Principal,
    id: string,
    body: UpdateOfferingInput,
    correlationId: string | null,
  ): Promise<Offering> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.loadOffering(trx, organizationId, id, true);
      if (!current) throw errors.notFound('offering', id);
      await this.authorization.require(principal, CatalogActions.manageOfferings, {
        type: 'offering',
        id,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      if (!EDITABLE_PUBLICATION_STATES.includes(current.publication_state)) {
        throw errors.invalidTransition('OfferingPublication', current.publication_state, 'edit');
      }
      await this.validateReferences(trx, organizationId, {
        eligibilityPolicyVersionId: body.eligibilityPolicyVersionId ?? undefined,
        cancellationPolicyVersionId: body.cancellationPolicyVersionId ?? undefined,
        entitlementDefinitionId: body.entitlementDefinitionId ?? undefined,
        responsibleManagerPersonId: body.responsibleManagerPersonId ?? undefined,
        requiredFormPolicyVersionIds: body.requiredFormPolicyVersionIds,
      });

      const merged: OfferingRow = {
        ...current,
        name: body.name ?? current.name,
        description: body.description === undefined ? current.description : body.description,
        activity_type: body.activityType ?? current.activity_type,
        format: body.format === undefined ? current.format : body.format,
        location: body.location ?? current.location,
        starts_on: body.startsOn ?? current.starts_on,
        ends_on: body.endsOn ?? current.ends_on,
        registration_opens_at:
          body.registrationOpensAt === undefined
            ? current.registration_opens_at
            : body.registrationOpensAt,
        registration_closes_at:
          body.registrationClosesAt === undefined
            ? current.registration_closes_at
            : body.registrationClosesAt,
        eligibility_reference_date:
          body.eligibilityReferenceDate === undefined
            ? current.eligibility_reference_date
            : body.eligibilityReferenceDate,
        eligibility_policy_version_id:
          body.eligibilityPolicyVersionId === undefined
            ? current.eligibility_policy_version_id
            : body.eligibilityPolicyVersionId,
        entitlement_definition_id:
          body.entitlementDefinitionId === undefined
            ? current.entitlement_definition_id
            : body.entitlementDefinitionId,
        capacity_units: body.capacityUnits ?? current.capacity_units,
        cancellation_policy_version_id:
          body.cancellationPolicyVersionId === undefined
            ? current.cancellation_policy_version_id
            : body.cancellationPolicyVersionId,
        responsible_manager_person_id:
          body.responsibleManagerPersonId === undefined
            ? current.responsible_manager_person_id
            : body.responsibleManagerPersonId,
      };
      if (merged.starts_on > merged.ends_on) {
        throw errors.validation('startsOn must not be after endsOn.', { path: 'endsOn' });
      }
      if (
        merged.registration_opens_at &&
        merged.registration_closes_at &&
        new Date(merged.registration_opens_at) >= new Date(merged.registration_closes_at)
      ) {
        throw errors.validation('Registration must open before it closes.', {
          path: 'registrationClosesAt',
        });
      }

      // SPK-YOUTH-002: a capacity change that raises the staffing requirement, or removes or relaxes
      // a staffing ratio, is never silent.
      let capacityChange: {
        before: CapacityUnit[];
        after: CapacityUnit[];
        requiredStaffBefore: number;
        requiredStaffAfter: number;
        reason: string | null;
      } | null = null;
      let ratiosRelaxed: CapacityUnit['unit'][] = [];
      if (body.capacityUnits) {
        const before = capacityUnitsOf(current);
        const staffing = staffingIncreaseNeedsReason(before, body.capacityUnits);
        if (staffing.needsReason && !body.reason) {
          throw errors.validation(
            staffing.ratiosRelaxed.length > 0
              ? `This capacity change removes or relaxes the staffing ratio of ${staffing.ratiosRelaxed.join(', ')}; provide a reason confirming staffing is arranged (SPK-YOUTH-002).`
              : 'Increasing this capacity raises the staffing requirement; provide a reason confirming staffing is arranged (SPK-YOUTH-002).',
            {
              path: 'reason',
              requiredStaffBefore: staffing.requiredStaffBefore,
              requiredStaffAfter: staffing.requiredStaffAfter,
              ratiosRelaxed: staffing.ratiosRelaxed,
            },
          );
        }
        ratiosRelaxed = staffing.ratiosRelaxed;
        capacityChange = {
          before,
          after: body.capacityUnits,
          requiredStaffBefore: staffing.requiredStaffBefore,
          requiredStaffAfter: staffing.requiredStaffAfter,
          reason: body.reason ?? null,
        };
      }

      const formIds =
        body.requiredFormPolicyVersionIds ??
        (await this.requiredFormIds(trx, organizationId, [id])).get(id) ??
        [];
      if (current.publication_state !== 'draft') {
        const problems = await this.validatePublication(trx, organizationId, merged, formIds);
        if (problems.length > 0) {
          throw errors.validation('A published offering must keep its required configuration.', {
            problems,
          });
        }
      }

      await trx
        .updateTable('offerings')
        .set({
          name: body.name,
          description: body.description,
          activity_type: body.activityType,
          format: body.format,
          location: body.location === undefined ? undefined : json(body.location),
          starts_on: body.startsOn,
          ends_on: body.endsOn,
          registration_opens_at:
            body.registrationOpensAt === undefined
              ? undefined
              : body.registrationOpensAt
                ? new Date(body.registrationOpensAt)
                : null,
          registration_closes_at:
            body.registrationClosesAt === undefined
              ? undefined
              : body.registrationClosesAt
                ? new Date(body.registrationClosesAt)
                : null,
          eligibility_reference_date: body.eligibilityReferenceDate,
          eligibility_policy_version_id: body.eligibilityPolicyVersionId,
          entitlement_definition_id: body.entitlementDefinitionId,
          capacity_units: body.capacityUnits === undefined ? undefined : json(body.capacityUnits),
          cancellation_policy_version_id: body.cancellationPolicyVersionId,
          responsible_manager_person_id: body.responsibleManagerPersonId,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .execute();
      if (body.requiredFormPolicyVersionIds) {
        await this.replaceRequiredForms(trx, organizationId, id, body.requiredFormPolicyVersionIds);
      }
      const updated = await this.loadOffering(trx, organizationId, id);
      if (!updated) throw errors.internal('offering vanished after update');
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.offering_updated',
        targetType: 'offering',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId,
        details: capacityChange
          ? {
              requiredStaffBefore: capacityChange.requiredStaffBefore,
              requiredStaffAfter: capacityChange.requiredStaffAfter,
              ratiosRelaxed,
            }
          : {},
      });
      await this.outbox.enqueue(trx, CatalogEvents.offeringUpdated, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: id,
        payload: {
          ...this.ref(updated),
          revision: updated.revision,
          publicationState: updated.publication_state,
          capacityChange,
        },
        correlationId,
      });
      return this.view(trx, updated, true);
    });
  }

  publish(
    principal: Principal,
    id: string,
    body: OfferingTransitionInput,
    correlationId: string | null,
  ) {
    return this.transition(principal, id, 'publish', body, correlationId);
  }

  openRegistration(
    principal: Principal,
    id: string,
    body: OfferingTransitionInput,
    correlationId: string | null,
  ) {
    return this.transition(principal, id, 'open_registration', body, correlationId);
  }

  pauseRegistration(
    principal: Principal,
    id: string,
    body: OfferingTransitionInput,
    correlationId: string | null,
  ) {
    return this.transition(principal, id, 'pause_registration', body, correlationId);
  }

  resumeRegistration(
    principal: Principal,
    id: string,
    body: OfferingTransitionInput,
    correlationId: string | null,
  ) {
    return this.transition(principal, id, 'resume_registration', body, correlationId);
  }

  close(
    principal: Principal,
    id: string,
    body: OfferingTransitionInput,
    correlationId: string | null,
  ) {
    return this.transition(principal, id, 'close', body, correlationId);
  }

  archive(
    principal: Principal,
    id: string,
    body: OfferingTransitionInput,
    correlationId: string | null,
  ) {
    return this.transition(principal, id, 'archive', body, correlationId);
  }

  /**
   * One command per lifecycle event (§4.6). Publication validates the required configuration
   * (SPK-CAT-004) and records an approval fact; registration commands never touch participation.
   */
  private async transition(
    principal: Principal,
    id: string,
    event: OfferingPublicationEvent,
    body: OfferingTransitionInput,
    correlationId: string | null,
  ): Promise<Offering> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.loadOffering(trx, organizationId, id, true);
      if (!current) throw errors.notFound('offering', id);
      const action =
        event === 'publish'
          ? CatalogActions.publishOffering
          : event === 'archive'
            ? CatalogActions.manageOfferings
            : CatalogActions.manageRegistrationWindow;
      await this.authorization.require(principal, action, {
        type: 'offering',
        id,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = OfferingPublicationMachine.next(current.publication_state, event);
      const now = this.clock.now();
      let approvalId: string | null = null;
      if (event === 'publish') {
        const forms = (await this.requiredFormIds(trx, organizationId, [id])).get(id) ?? [];
        const problems = await this.validatePublication(trx, organizationId, current, forms);
        if (problems.length > 0) {
          throw errors.validation(
            'The offering is missing required configuration for publication.',
            { problems },
          );
        }
        approvalId = await this.policies.recordApproval(trx, principal, organizationId, {
          subjectType: 'offering_publication',
          subjectId: id,
          reason: body.reason ?? null,
          details: { revision: current.revision + 1 },
        });
      }
      await trx
        .updateTable('offerings')
        .set({
          publication_state: next,
          published_at: event === 'publish' ? now : undefined,
          registration_opened_at:
            event === 'open_registration' && current.registration_opened_at === null
              ? now
              : undefined,
          closed_at: event === 'close' ? now : undefined,
          archived_at: event === 'archive' ? now : undefined,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .execute();
      const updated = await this.loadOffering(trx, organizationId, id);
      if (!updated) throw errors.internal('offering vanished after transition');
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `catalog.offering_${event}`,
        targetType: 'offering',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId,
        details: { from: current.publication_state, to: next, approvalId },
      });
      const ref = this.ref(updated);
      const common = { organizationId, aggregateType: 'offering', aggregateId: id, correlationId };
      switch (event) {
        case 'publish':
          await this.outbox.enqueue(trx, CatalogEvents.offeringPublished, {
            ...common,
            payload: {
              ...ref,
              revision: updated.revision,
              registrationOpensAt: new Date(updated.registration_opens_at as Date).toISOString(),
              registrationClosesAt: new Date(updated.registration_closes_at as Date).toISOString(),
            },
          });
          break;
        case 'open_registration':
        case 'resume_registration':
          await this.outbox.enqueue(trx, CatalogEvents.registrationOpened, {
            ...common,
            payload: {
              ...ref,
              revision: updated.revision,
              resumed: event === 'resume_registration',
            },
          });
          break;
        case 'pause_registration':
          await this.outbox.enqueue(trx, CatalogEvents.registrationPaused, {
            ...common,
            payload: { ...ref, revision: updated.revision, reason: body.reason ?? null },
          });
          break;
        case 'close':
          await this.outbox.enqueue(trx, CatalogEvents.offeringClosed, {
            ...common,
            payload: { ...ref, revision: updated.revision, reason: body.reason ?? null },
          });
          break;
        case 'archive':
          await this.outbox.enqueue(trx, CatalogEvents.offeringArchived, {
            ...common,
            payload: { ...ref, revision: updated.revision },
          });
          break;
      }
      return this.view(trx, updated, true);
    });
  }

  /**
   * SPK-CAT-003: copying creates a draft with the configuration only. Payments, attendance,
   * enrollments, results and permissions live in other modules and reference the source id, so
   * nothing of them can follow; price rules are deliberately not copied either (DEC-007: prices
   * are set per offering by finance).
   */
  async copy(
    principal: Principal,
    id: string,
    body: CopyOfferingInput,
    correlationId: string | null,
  ): Promise<Offering> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const source = await this.loadOffering(trx, organizationId, id);
      if (!source) throw errors.notFound('offering', id);
      await this.authorization.require(principal, CatalogActions.manageOfferings, {
        type: 'offering',
        id,
        organizationId,
        facilityId: source.facility_id,
      });
      const facilityId = body.facilityId ?? source.facility_id;
      if (facilityId !== source.facility_id) {
        await this.validateReferences(trx, organizationId, { facilityId });
        await this.authorization.require(principal, CatalogActions.manageOfferings, {
          type: 'offering',
          organizationId,
          facilityId,
        });
      }
      const startsOn = body.startsOn ?? source.starts_on;
      const deltaDays = daysBetween(source.starts_on, startsOn);
      const endsOn = body.endsOn ?? addDays(source.ends_on, deltaDays);
      if (startsOn > endsOn) {
        throw errors.validation('startsOn must not be after endsOn.', { path: 'endsOn' });
      }
      // SPK-SCHED-008: shift by calendar days in facility-local time, keeping the wall-clock time,
      // so a copy across a daylight-saving change does not move every session by an hour. Local
      // times that do not exist or are ambiguous on the new date are resolved by the default DST
      // policy and recorded in the audit details.
      const zones = await trx
        .selectFrom('facilities')
        .select(['id', 'timezone'])
        .where('organization_id', '=', organizationId)
        .where('id', 'in', [source.facility_id, facilityId])
        .execute();
      const zoneOf = (facility: string): string => {
        const zone = zones.find((z) => z.id === facility)?.timezone;
        if (!zone) throw errors.internal(`facility ${facility} has no timezone`);
        return zone;
      };
      const fromZone = zoneOf(source.facility_id);
      const toZone = zoneOf(facilityId);
      const dstResolutions: Array<{
        field: string;
        sessionId?: string;
        resolution: DstResolution;
      }> = [];
      const shift = (
        value: Date | string | null,
        field: string,
        sessionId?: string,
      ): Date | null => {
        if (value === null) return null;
        const instant = new Date(value);
        if (deltaDays === 0 && fromZone === toZone) return instant;
        const resolved = resolveLocal(
          addLocalDays(localDateOf(fromZone, instant), deltaDays),
          localTimeOf(fromZone, instant),
          toZone,
          DEFAULT_DST_POLICY,
        );
        // shift_forward never skips, so resolveLocal always resolves under the default policy.
        if (!resolved) throw errors.internal('a copied local time could not be resolved');
        if (resolved.resolution !== 'exact') {
          dstResolutions.push({
            field,
            ...(sessionId ? { sessionId } : {}),
            resolution: resolved.resolution,
          });
        }
        // localTimeOf has minute precision; keep the source's seconds within the minute.
        const subMinute = ((instant.getTime() % 60_000) + 60_000) % 60_000;
        return new Date(resolved.instant.getTime() + subMinute);
      };
      const opensAt =
        body.registrationOpensAt === undefined
          ? shift(source.registration_opens_at, 'registrationOpensAt')
          : body.registrationOpensAt
            ? new Date(body.registrationOpensAt)
            : null;
      const closesAt =
        body.registrationClosesAt === undefined
          ? shift(source.registration_closes_at, 'registrationClosesAt')
          : body.registrationClosesAt
            ? new Date(body.registrationClosesAt)
            : null;
      if (opensAt && closesAt && opensAt.getTime() >= closesAt.getTime()) {
        throw errors.validation('Registration must open before it closes.', {
          path: 'registrationClosesAt',
        });
      }
      const newId_ = newId();
      await trx
        .insertInto('offerings')
        .values({
          id: newId_,
          organization_id: organizationId,
          program_id: source.program_id,
          facility_id: facilityId,
          name: body.name ?? `${source.name} (copy)`,
          description: source.description,
          kind: source.kind,
          activity_type: source.activity_type,
          format: source.format,
          location: json(source.location),
          starts_on: startsOn,
          ends_on: endsOn,
          registration_opens_at: opensAt,
          registration_closes_at: closesAt,
          eligibility_reference_date: source.eligibility_reference_date
            ? addDays(source.eligibility_reference_date, deltaDays)
            : null,
          eligibility_policy_version_id: source.eligibility_policy_version_id,
          entitlement_definition_id: source.entitlement_definition_id,
          capacity_units: json(source.capacity_units),
          cancellation_policy_version_id: source.cancellation_policy_version_id,
          responsible_manager_person_id: source.responsible_manager_person_id,
          publication_state: 'draft',
          published_at: null,
          registration_opened_at: null,
          closed_at: null,
          archived_at: null,
          copied_from_offering_id: source.id,
          created_by: json(snapshotActor(principal)),
        })
        .execute();
      const forms = (await this.requiredFormIds(trx, organizationId, [id])).get(id) ?? [];
      await this.replaceRequiredForms(trx, organizationId, newId_, forms);
      const copiedSessionIds: string[] = [];
      if (body.copySessions) {
        const sessions = await trx
          .selectFrom('offering_sessions')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('offering_id', '=', id)
          .where('status', '=', 'scheduled')
          .orderBy('sequence')
          .execute();
        for (const session of sessions) {
          const sessionId = newId();
          const start = shift(session.scheduled_start, 'scheduledStart', sessionId) as Date;
          // the session keeps its length, so start < end always holds
          const end = new Date(
            start.getTime() +
              (new Date(session.scheduled_end).getTime() -
                new Date(session.scheduled_start).getTime()),
          );
          await trx
            .insertInto('offering_sessions')
            .values({
              id: sessionId,
              organization_id: organizationId,
              offering_id: newId_,
              sequence: session.sequence,
              title: session.title,
              scheduled_start: start,
              scheduled_end: end,
              scheduling_event_id: null,
              capacity_override:
                session.capacity_override === null ? null : json(session.capacity_override),
              canceled_at: null,
              cancel_reason: null,
            })
            .execute();
          copiedSessionIds.push(sessionId);
        }
      }
      const row = await this.loadOffering(trx, organizationId, newId_);
      if (!row) throw errors.internal('offering vanished after copy');
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.offering_copied',
        targetType: 'offering',
        targetId: newId_,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: { sourceOfferingId: id, copiedSessionIds, deltaDays, dstResolutions },
      });
      await this.outbox.enqueue(trx, CatalogEvents.offeringCopied, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: newId_,
        payload: { ...this.ref(row), sourceOfferingId: id, copiedSessionIds },
        correlationId,
      });
      return this.view(trx, row, true);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  /**
   * Visibility of one offering: staff readers see every state with staff details; everyone else
   * (customers, anonymous) sees the child-safe view of a published offering or NOT_FOUND.
   */
  async loadVisible(
    principal: Principal,
    id: string,
  ): Promise<{ row: OfferingRow; staff: boolean }> {
    const row = principal.organizationId
      ? await this.loadOffering(this.db, principal.organizationId, id)
      : await this.loadOfferingAnyOrganization(id);
    if (!row) throw errors.protectedNotFound('offering');
    if (principal.kind !== 'anonymous') {
      const decision = await this.authorization.decide(principal, CatalogActions.readCatalog, {
        type: 'offering',
        id,
        organizationId: row.organization_id,
        facilityId: row.facility_id,
      });
      if (decision.allowed) return { row, staff: true };
    }
    if (!PUBLIC_PUBLICATION_STATES.includes(row.publication_state)) {
      throw errors.protectedNotFound('offering');
    }
    return { row, staff: false };
  }

  async get(principal: Principal, id: string): Promise<Offering> {
    const { row, staff } = await this.loadVisible(principal, id);
    return this.view(this.db, row, staff);
  }

  /** Public discovery (@Public): published states only, child-safe fields only (§4.14). */
  async listPublic(
    principal: Principal,
    query: ListPublicOfferingsQuery,
  ): Promise<Page<PublicOffering>> {
    let organizationId = principal.organizationId;
    if (query.organization) {
      const organization = await this.db
        .selectFrom('organizations')
        .select('id')
        .where('slug', '=', query.organization)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!organization || (organizationId && organization.id !== organizationId)) {
        throw errors.notFound('organization', query.organization);
      }
      organizationId = organization.id;
    }
    if (!organizationId) {
      throw errors.validation('organization (slug) is required for public discovery.', {
        path: 'organization',
      });
    }
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('offerings')
      .select(offeringColumns)
      .where('offerings.organization_id', '=', organizationId)
      .where('offerings.publication_state', 'in', [...PUBLIC_PUBLICATION_STATES])
      .orderBy('offerings.starts_on')
      .orderBy('offerings.id')
      .limit(query.limit + 1);
    if (query.facilityId) q = q.where('offerings.facility_id', '=', query.facilityId);
    if (query.kind) q = q.where('offerings.kind', '=', query.kind);
    if (query.programId) q = q.where('offerings.program_id', '=', query.programId);
    if (query.from) q = q.where(sql<boolean>`offerings.ends_on >= ${query.from}::date`);
    if (cursor) {
      q = q.where(
        sql<boolean>`(offerings.starts_on, offerings.id) > (${cursor.startsOn}::date, ${cursor.id}::uuid)`,
      );
    }
    const rows = (await q.execute()) as unknown as OfferingRow[];
    const page = rows.slice(0, query.limit);
    const contexts = await this.contexts(this.db, organizationId, page, this.clock.now());
    const items = page.map((row) => toPublicOffering(row, contexts.get(row.id)!));
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeCursor({ startsOn: last.starts_on, id: last.id }) : null,
    };
  }

  /** Staff listing of a program's offerings in every state. */
  async listForProgram(
    principal: Principal,
    programId: string,
    query: ListProgramOfferingsQuery,
  ): Promise<Page<Offering>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'offering',
      organizationId,
    });
    const program = await this.db
      .selectFrom('programs')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', programId)
      .executeTakeFirst();
    if (!program) throw errors.notFound('program', programId);
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('offerings')
      .select(offeringColumns)
      .where('offerings.organization_id', '=', organizationId)
      .where('offerings.program_id', '=', programId)
      .orderBy('offerings.starts_on')
      .orderBy('offerings.id')
      .limit(query.limit + 1);
    if (query.publicationState)
      q = q.where('offerings.publication_state', '=', query.publicationState);
    if (cursor) {
      q = q.where(
        sql<boolean>`(offerings.starts_on, offerings.id) > (${cursor.startsOn}::date, ${cursor.id}::uuid)`,
      );
    }
    const rows = (await q.execute()) as unknown as OfferingRow[];
    const page = rows.slice(0, query.limit);
    const contexts = await this.contexts(this.db, organizationId, page, this.clock.now());
    const items = page.map((row) => toOffering(row, contexts.get(row.id)!, true));
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeCursor({ startsOn: last.starts_on, id: last.id }) : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // OfferingLookupPort
  // -------------------------------------------------------------------------------------------

  async getOffering(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<OfferingSnapshot | null> {
    const db = trx ?? this.db;
    const row = await this.loadOffering(db, organizationId, offeringId);
    if (!row) return null;
    const contexts = await this.contexts(db, organizationId, [row], at);
    const ctx = contexts.get(row.id)!;
    const offering = toOffering(row, ctx, true);
    const entitlementRow = row.entitlement_definition_id
      ? await db
          .selectFrom('entitlement_definitions')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', row.entitlement_definition_id)
          .executeTakeFirst()
      : undefined;
    const eligibilityPolicy = row.eligibility_policy_version_id
      ? await this.policies.getPolicyVersion(organizationId, row.eligibility_policy_version_id, trx)
      : null;
    const cancellationPolicy = row.cancellation_policy_version_id
      ? await this.policies.getPolicyVersion(
          organizationId,
          row.cancellation_policy_version_id,
          trx,
        )
      : null;
    const requiredForms = [];
    for (const formId of ctx.requiredFormPolicyVersionIds) {
      const form = await this.policies.getPolicyVersion(organizationId, formId, trx);
      if (form) requiredForms.push(form);
    }
    const opens = row.registration_opens_at ? new Date(row.registration_opens_at).getTime() : null;
    const closes = row.registration_closes_at
      ? new Date(row.registration_closes_at).getTime()
      : null;
    return {
      offering,
      priceRule: ctx.price,
      entitlementDefinition: entitlementRow ? toEntitlementDefinition(entitlementRow) : null,
      capacityUnits: capacityUnitsOf(row),
      eligibilityReferenceDate: eligibilityReferenceDateOf(row),
      eligibilityPolicy,
      cancellationPolicy,
      requiredForms,
      registrationOpen:
        row.publication_state === 'registration_open' &&
        opens !== null &&
        closes !== null &&
        opens <= at.getTime() &&
        at.getTime() < closes,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Publication validation (SPK-CAT-004)
  // -------------------------------------------------------------------------------------------

  async validatePublication(
    trx: Trx | Db,
    organizationId: string,
    row: OfferingRow,
    requiredFormPolicyVersionIds: readonly string[],
  ): Promise<PublicationProblem[]> {
    const problems: PublicationProblem[] = [];
    const problem = (code: string, field: string, message: string) =>
      problems.push({ code, field, message });
    if (!row.registration_opens_at || !row.registration_closes_at) {
      problem(
        'registration_window_missing',
        'registrationOpensAt',
        'The registration window is not set.',
      );
    }
    const units = capacityUnitsOf(row);
    if (units.length === 0) {
      problem('capacity_missing', 'capacityUnits', 'At least one capacity unit is required.');
    }
    for (const unit of units) {
      if (unit.unit === 'camp_group_places' && (!unit.groupSize || !unit.staffingRatio)) {
        problem(
          'staffing_requirement_missing',
          'capacityUnits',
          'Camp group places require a group size and a staffing ratio (SPK-YOUTH-002).',
        );
      }
    }
    await this.checkPolicy(
      trx,
      organizationId,
      row.eligibility_policy_version_id,
      'eligibility',
      'eligibilityPolicyVersionId',
      problem,
    );
    await this.checkPolicy(
      trx,
      organizationId,
      row.cancellation_policy_version_id,
      'cancellation',
      'cancellationPolicyVersionId',
      problem,
    );
    for (const formId of requiredFormPolicyVersionIds) {
      await this.checkPolicy(
        trx,
        organizationId,
        formId,
        'form',
        'requiredFormPolicyVersionIds',
        problem,
      );
    }
    if (!row.entitlement_definition_id) {
      problem(
        'entitlement_missing',
        'entitlementDefinitionId',
        'An entitlement definition is required.',
      );
    } else {
      const entitlement = await trx
        .selectFrom('entitlement_definitions')
        .select('status')
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.entitlement_definition_id)
        .executeTakeFirst();
      if (!entitlement) {
        problem(
          'entitlement_missing',
          'entitlementDefinitionId',
          'The entitlement definition does not exist.',
        );
      } else if (entitlement.status !== 'active') {
        problem(
          'entitlement_archived',
          'entitlementDefinitionId',
          'The entitlement definition is archived.',
        );
      }
    }
    if (!row.responsible_manager_person_id) {
      problem(
        'responsible_manager_missing',
        'responsibleManagerPersonId',
        'A responsible manager is required.',
      );
    } else {
      const manager = await this.persons.findPerson(
        organizationId,
        row.responsible_manager_person_id,
        trx as Trx,
      );
      if (!manager || manager.status !== 'active') {
        problem(
          'responsible_manager_inactive',
          'responsibleManagerPersonId',
          'The responsible manager is not an active person.',
        );
      }
    }
    const now = this.clock.now();
    const priced = await trx
      .selectFrom('price_rules')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', row.id)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
      .executeTakeFirst();
    if (!priced) {
      problem(
        'price_rule_missing',
        'priceRules',
        'A current or future price rule is required (SPK-PAY-001).',
      );
    } else {
      // SPK-CAT-001 "price and obligations", SPK-PAY-001: every instant a customer can still
      // register must have an effective price rule ("unpriced" is not "free"; a free offering is a
      // 0-price rule). Rules never overlap (exclusion constraint), are never extended
      // (price_rules_guard), and a successor closes an open-ended rule only where it begins, so
      // coverage proven here holds for the rest of the window.
      const gap = await this.firstUnpricedInstant(trx, organizationId, row, now);
      if (gap) {
        problem(
          'price_rule_gap',
          'priceRules',
          `No price rule is effective at ${gap.toISOString()}, inside the registration window (SPK-PAY-001).`,
        );
      }
    }
    return problems;
  }

  /** The first instant of [max(now, opens), closes) that no price rule covers, if any. */
  private async firstUnpricedInstant(
    db: Trx | Db,
    organizationId: string,
    row: OfferingRow,
    now: Date,
  ): Promise<Date | null> {
    // A missing window is reported as registration_window_missing.
    if (!row.registration_opens_at || !row.registration_closes_at) return null;
    const end = new Date(row.registration_closes_at).getTime();
    let cursor = Math.max(now.getTime(), new Date(row.registration_opens_at).getTime());
    if (cursor >= end) return null;
    const rules = await db
      .selectFrom('price_rules')
      .select(['effective_from', 'effective_to'])
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', row.id)
      .where('effective_from', '<', new Date(end))
      .where((eb) =>
        eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', new Date(cursor))]),
      )
      .orderBy('effective_from')
      .execute();
    for (const rule of rules) {
      if (new Date(rule.effective_from).getTime() > cursor) break;
      cursor = rule.effective_to === null ? Infinity : new Date(rule.effective_to).getTime();
      if (cursor >= end) return null;
    }
    return new Date(cursor);
  }

  private async checkPolicy(
    db: Trx | Db,
    organizationId: string,
    policyVersionId: string | null,
    kind: 'eligibility' | 'cancellation' | 'form',
    field: string,
    problem: (code: string, field: string, message: string) => void,
  ): Promise<void> {
    if (!policyVersionId) {
      problem(`${kind}_policy_missing`, field, `An approved ${kind} policy version is required.`);
      return;
    }
    const policy = await db
      .selectFrom('policy_versions')
      .select(['kind', 'approval_status'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', policyVersionId)
      .executeTakeFirst();
    if (!policy) {
      problem(`${kind}_policy_missing`, field, `Policy version ${policyVersionId} does not exist.`);
    } else if (policy.kind !== kind) {
      problem(
        `${kind}_policy_wrong_kind`,
        field,
        `Policy version ${policyVersionId} is a ${policy.kind} policy.`,
      );
    } else if (policy.approval_status !== 'approved') {
      problem(
        `${kind}_policy_not_approved`,
        field,
        `Policy version ${policyVersionId} is ${policy.approval_status}.`,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------------------------

  private async validateReferences(
    trx: Trx,
    organizationId: string,
    refs: ReferenceInput,
  ): Promise<void> {
    if (refs.facilityId) {
      const facility = await trx
        .selectFrom('facilities')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', refs.facilityId)
        .executeTakeFirst();
      if (!facility) throw errors.validation('Unknown facility.', { path: 'facilityId' });
    }
    const policyIds = [
      ...(refs.eligibilityPolicyVersionId ? [refs.eligibilityPolicyVersionId] : []),
      ...(refs.cancellationPolicyVersionId ? [refs.cancellationPolicyVersionId] : []),
      ...(refs.requiredFormPolicyVersionIds ?? []),
    ];
    if (policyIds.length > 0) {
      const found = await trx
        .selectFrom('policy_versions')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', 'in', policyIds)
        .execute();
      const missing = policyIds.filter((id) => !found.some((f) => f.id === id));
      if (missing.length > 0) {
        throw errors.validation('Unknown policy version.', { policyVersionIds: missing });
      }
    }
    if (refs.entitlementDefinitionId) {
      const entitlement = await trx
        .selectFrom('entitlement_definitions')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', refs.entitlementDefinitionId)
        .executeTakeFirst();
      if (!entitlement) {
        throw errors.validation('Unknown entitlement definition.', {
          path: 'entitlementDefinitionId',
        });
      }
    }
    if (refs.responsibleManagerPersonId) {
      const manager = await this.persons.findPerson(
        organizationId,
        refs.responsibleManagerPersonId,
        trx,
      );
      if (!manager || manager.status !== 'active' || manager.kind !== 'adult') {
        throw errors.validation(
          'The responsible manager must be an active adult of this organization.',
          {
            path: 'responsibleManagerPersonId',
          },
        );
      }
    }
  }

  private async replaceRequiredForms(
    trx: Trx,
    organizationId: string,
    offeringId: string,
    policyVersionIds: readonly string[],
  ): Promise<void> {
    await trx
      .deleteFrom('offering_required_forms')
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .execute();
    let sequence = 1;
    for (const policyVersionId of new Set(policyVersionIds)) {
      await trx
        .insertInto('offering_required_forms')
        .values({
          organization_id: organizationId,
          offering_id: offeringId,
          policy_version_id: policyVersionId,
          sequence,
        })
        .execute();
      sequence += 1;
    }
  }

  private async requiredFormIds(
    db: Trx | Db,
    organizationId: string,
    offeringIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (offeringIds.length === 0) return out;
    const rows = await db
      .selectFrom('offering_required_forms')
      .select(['offering_id', 'policy_version_id'])
      .where('organization_id', '=', organizationId)
      .where('offering_id', 'in', [...offeringIds])
      .orderBy('sequence')
      .execute();
    for (const row of rows) {
      const list = out.get(row.offering_id) ?? [];
      list.push(row.policy_version_id);
      out.set(row.offering_id, list);
    }
    return out;
  }

  private async contexts(
    db: Trx | Db,
    organizationId: string,
    rows: readonly OfferingRow[],
    at: Date,
  ): Promise<Map<string, OfferingViewContext>> {
    const out = new Map<string, OfferingViewContext>();
    if (rows.length === 0) return out;
    const programIds = [...new Set(rows.map((r) => r.program_id))];
    const programs = await db
      .selectFrom('programs')
      .select(['id', 'age_band'])
      .where('organization_id', '=', organizationId)
      .where('id', 'in', programIds)
      .execute();
    const ageBands = new Map(programs.map((p) => [p.id, p.age_band as AgeBand]));
    const ids = rows.map((r) => r.id);
    const prices = await this.priceRules.effectivePriceRules(
      organizationId,
      ids,
      at,
      'isTransaction' in db && typeof db.isTransaction === 'boolean' && db.isTransaction
        ? (db as Trx)
        : undefined,
    );
    const forms = await this.requiredFormIds(db, organizationId, ids);
    for (const row of rows) {
      out.set(row.id, {
        ageBand: ageBands.get(row.program_id) ?? {},
        price: prices.get(row.id) ?? null,
        requiredFormPolicyVersionIds: forms.get(row.id) ?? [],
      });
    }
    return out;
  }

  private async view(db: Trx | Db, row: OfferingRow, includeStaff: boolean): Promise<Offering> {
    const contexts = await this.contexts(db, row.organization_id, [row], this.clock.now());
    return toOffering(row, contexts.get(row.id)!, includeStaff);
  }

  private ref(row: OfferingRow) {
    return {
      offeringId: row.id,
      programId: row.program_id,
      facilityId: row.facility_id,
      kind: row.kind,
    };
  }

  async loadOffering(
    db: Trx | Db,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<OfferingRow | undefined> {
    let q = db
      .selectFrom('offerings')
      .select(offeringColumns)
      .where('offerings.organization_id', '=', organizationId)
      .where('offerings.id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return (await q.executeTakeFirst()) as unknown as OfferingRow | undefined;
  }

  private async loadOfferingAnyOrganization(id: string): Promise<OfferingRow | undefined> {
    return (await this.db
      .selectFrom('offerings')
      .select(offeringColumns)
      .where('offerings.id', '=', id)
      .executeTakeFirst()) as unknown as OfferingRow | undefined;
  }
}
