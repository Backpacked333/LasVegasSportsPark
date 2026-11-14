import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Acknowledgment,
  type OfferingRequiredWaivers,
  type PersonWaiver,
  type PersonWaivers,
  type Principal,
  type RecordWaiverAcceptanceInput,
  type RecordWaiverOverrideInput,
  type SetOfferingRequiredWaiversInput,
  type WaiverActivityRef,
  type WaiverOverride,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  DATABASE,
  executorFor,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import { organizationOf } from '../catalog.shared';
import { judgeWaiver } from '../waivers/waiver-rule';
import { AcknowledgmentsService } from './acknowledgments.service';
import { toWaiverOverride, WaiverStatusReader } from './waiver-status.reader';

/**
 * Liability waivers (SPK-REG-011, proposed amendment PA-01, ADR-004; capability
 * `liability_waivers`, DEC-095). Proposed: built ahead of the decision, off until an organization
 * turns the capability on.
 *
 * - A waiver is a policy family of kind `waiver`; its versions are drafted, approved and retired
 *   through the policy version commands, and its rule is the content of the version in force.
 * - An acceptance is an acknowledgment of a waiver version (`AcknowledgmentsService`), so every
 *   signing rule of SPK-REG-009 holds; this service only routes the command.
 * - A requirement is a waiver key on an offering (`offering_required_waivers`).
 * - An override of a block is an append-only record for one person and one activity.
 *
 * Commands check the capability inside their unit of work. Reads never do: with the capability
 * off the person read answers `evaluated: false` and an offering shows no required waiver.
 */
@Injectable()
export class WaiversService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly reader: WaiverStatusReader,
    private readonly acknowledgments: AcknowledgmentsService,
  ) {}

  accept(
    principal: Principal,
    body: RecordWaiverAcceptanceInput,
    correlationId: string | null,
  ): Promise<Acknowledgment> {
    return this.acknowledgments.recordWaiverAcceptance(principal, body, correlationId);
  }

  /**
   * A person's waivers (staff; the person; a guardian holding complete_forms). Anyone else gets
   * the answer an unknown person gets (§4.10). Every waiver family with a version in force is
   * listed, and every family the person ever accepted, each judged now.
   */
  async personWaivers(principal: Principal, personId: string): Promise<PersonWaivers> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readPersonWaivers, {
      type: 'person',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    const person = await this.persons.findPerson(organizationId, personId);
    if (!person) throw errors.protectedNotFound('person');
    if (!(await this.capabilities.isEnabled(organizationId, 'liability_waivers'))) {
      return { personId, evaluated: false, waivers: [] };
    }
    const at = this.clock.now();
    const families = await this.reader.families(organizationId, at);
    const accepted = (await this.reader.acceptances(organizationId, [personId], undefined)).get(
      personId,
    );
    const staff = principal.kind === 'staff' || principal.kind === 'system';
    const overrides = staff ? await this.overridesOf(organizationId, personId) : [];
    const waivers: PersonWaiver[] = [];
    for (const [policyKey, family] of families) {
      const history = (accepted ?? [])
        .filter((a) => a.policyKey === policyKey)
        .map((a) => a.acceptance);
      // A family with no version in force is listed only when the person has a history in it.
      if (!family.inForce && history.length === 0) continue;
      waivers.push({
        ...judgeWaiver({ policyKey, at, inForce: family.inForce, acceptances: history }),
        title: family.title,
        history,
        overrides: overrides.filter((o) => o.policyKey === policyKey),
      });
    }
    waivers.sort(
      (a, b) => a.title.localeCompare(b.title) || a.policyKey.localeCompare(b.policyKey),
    );
    return { personId, evaluated: true, waivers };
  }

  /**
   * Records that a staff member lets one person take part in one activity although the waiver
   * rule blocks. Permitted only where the version in force blocks and names one of the actor's
   * roles; never for a waiver that is current or only warns, and never for oneself.
   */
  async override(
    principal: Principal,
    body: RecordWaiverOverrideInput,
    correlationId: string | null,
  ): Promise<WaiverOverride> {
    const organizationId = organizationOf(principal);
    const actorPersonId = principal.personId;
    if (principal.kind !== 'staff' || !actorPersonId) {
      throw errors.accessDenied('A waiver override is recorded by a named staff member.', {
        action: CatalogActions.overrideWaiver.id,
      });
    }
    if (actorPersonId === body.personId) {
      throw errors.accessDenied('Nobody overrides a waiver rule for themselves.', {
        action: CatalogActions.overrideWaiver.id,
      });
    }
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'liability_waivers', trx);
      const facilityId = await this.activityFacility(trx, organizationId, body.activity);
      await this.authorization.require(principal, CatalogActions.overrideWaiver, {
        type: 'waiver_override',
        organizationId,
        ...(facilityId ? { facilityId } : {}),
      });
      const person = await this.persons.findPerson(organizationId, body.personId, trx);
      if (!person) throw errors.notFound('person', body.personId);
      const at = this.clock.now();
      const family = (await this.reader.families(organizationId, at, [body.policyKey], trx)).get(
        body.policyKey,
      );
      const status = await this.reader.status(
        organizationId,
        body.personId,
        body.policyKey,
        at,
        trx,
      );
      if (status.status === 'current' || !family?.inForce) {
        throw errors.validation(
          status.status === 'current'
            ? 'The waiver is current; there is nothing to override.'
            : 'No approved version of this waiver is in force; there is no rule to override.',
          { path: 'policyKey', code: 'WAIVER_NOT_BLOCKING' },
        );
      }
      if (family.inForce.content.enforcement !== 'block') {
        throw errors.validation(
          'This waiver warns and does not block; no override is needed or recorded.',
          { path: 'policyKey', code: 'WAIVER_NOT_BLOCKING' },
        );
      }
      const permitted = family.inForce.content.overrideRoles;
      if (!principal.staffRoles.some((role) => permitted.includes(role))) {
        throw errors.accessDenied('The approved waiver does not permit your role to override it.', {
          action: CatalogActions.overrideWaiver.id,
          code: 'WAIVER_OVERRIDE_NOT_PERMITTED',
        });
      }
      const id = newId();
      const row = await trx
        .insertInto('waiver_overrides')
        .values({
          id,
          organization_id: organizationId,
          person_id: body.personId,
          policy_key: body.policyKey,
          policy_version_id: family.inForce.ref.policyVersionId,
          waiver_status: status.status,
          activity_type: body.activity.type,
          activity_id: body.activity.id,
          reason: body.reason,
          actor: json(snapshotActor(principal)),
          actor_person_id: actorPersonId,
          occurred_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.waiver_override_recorded',
        targetType: 'waiver_override',
        targetId: id,
        reason: body.reason,
        correlationId,
        details: {
          personId: body.personId,
          policyKey: body.policyKey,
          policyVersionId: family.inForce.ref.policyVersionId,
          waiverStatus: status.status,
          activity: body.activity,
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.waiverOverrideRecorded, {
        organizationId,
        aggregateType: 'waiver_override',
        aggregateId: id,
        payload: {
          waiverOverrideId: id,
          personId: body.personId,
          policyKey: body.policyKey,
          activityType: body.activity.type,
          activityId: body.activity.id,
        },
        correlationId,
      });
      return toWaiverOverride(row);
    });
  }

  /**
   * The waiver families an offering requires with the version in force now. Readable by every
   * authenticated principal of the organization once the offering is published (a customer must
   * see what they will be asked to accept); a draft or archived offering is staff-only.
   */
  async offeringRequiredWaivers(
    principal: Principal,
    offeringId: string,
  ): Promise<OfferingRequiredWaivers> {
    const organizationId = organizationOf(principal);
    const offering = await this.db
      .selectFrom('offerings')
      .select(['id', 'facility_id', 'publication_state'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', offeringId)
      .executeTakeFirst();
    if (!offering) throw errors.notFound('offering', offeringId);
    if (offering.publication_state === 'draft' || offering.publication_state === 'archived') {
      await this.authorization.require(principal, CatalogActions.readCatalog, {
        type: 'offering',
        id: offeringId,
        organizationId,
      });
    }
    if (!(await this.capabilities.isEnabled(organizationId, 'liability_waivers'))) {
      return { offeringId, waivers: [] };
    }
    return this.describeRequired(organizationId, offeringId);
  }

  async setOfferingRequiredWaivers(
    principal: Principal,
    offeringId: string,
    body: SetOfferingRequiredWaiversInput,
    correlationId: string | null,
  ): Promise<OfferingRequiredWaivers> {
    const organizationId = organizationOf(principal);
    const policyKeys = [...new Set(body.policyKeys)].sort();
    return this.uow.run(async ({ trx }) => {
      const offering = await trx
        .selectFrom('offerings')
        .select(['id', 'facility_id', 'publication_state'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', offeringId)
        .forUpdate()
        .executeTakeFirst();
      if (!offering) throw errors.notFound('offering', offeringId);
      await this.authorization.require(principal, CatalogActions.manageRequiredWaivers, {
        type: 'offering',
        id: offeringId,
        organizationId,
        facilityId: offering.facility_id,
      });
      await this.capabilities.require(organizationId, 'liability_waivers', trx);
      if (offering.publication_state === 'archived') {
        throw errors.validation('An archived offering cannot be changed.', { path: 'id' });
      }
      const families = await this.reader.families(
        organizationId,
        this.clock.now(),
        policyKeys,
        trx,
      );
      const unknown = policyKeys.filter((key) => !families.get(key)?.inForce);
      if (unknown.length > 0) {
        // A requirement nobody could satisfy is refused: the family needs a version in force.
        throw errors.validation('Each required waiver needs an approved version in force.', {
          path: 'policyKeys',
          code: 'WAIVER_NOT_IN_FORCE',
          policyKeys: unknown,
        });
      }
      const before = await this.requiredKeys(organizationId, offeringId, trx);
      const removed = before.filter((key) => !policyKeys.includes(key));
      const added = policyKeys.filter((key) => !before.includes(key));
      if (removed.length > 0) {
        await trx
          .deleteFrom('offering_required_waivers')
          .where('organization_id', '=', organizationId)
          .where('offering_id', '=', offeringId)
          .where('policy_key', 'in', removed)
          .execute();
      }
      if (added.length > 0) {
        await trx
          .insertInto('offering_required_waivers')
          .values(
            added.map((policy_key) => ({
              organization_id: organizationId,
              offering_id: offeringId,
              policy_key,
              added_by: json(snapshotActor(principal)),
            })),
          )
          .execute();
      }
      if (removed.length > 0 || added.length > 0) {
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'catalog.offering_required_waivers_changed',
          targetType: 'offering',
          targetId: offeringId,
          reason: body.reason ?? null,
          correlationId,
          details: { before, after: policyKeys },
        });
        await this.outbox.enqueue(trx, CatalogEvents.offeringRequiredWaiversChanged, {
          organizationId,
          aggregateType: 'offering',
          aggregateId: offeringId,
          payload: { offeringId, policyKeys },
          correlationId,
        });
      }
      return this.describeRequired(organizationId, offeringId, trx);
    });
  }

  /** The waiver keys an offering requires, in key order (the offering snapshot's port field). */
  async requiredKeys(organizationId: string, offeringId: string, trx?: Trx): Promise<string[]> {
    const rows = await (trx ?? executorFor(this.db))
      .selectFrom('offering_required_waivers')
      .select('policy_key')
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .orderBy('policy_key')
      .execute();
    return rows.map((r) => r.policy_key);
  }

  /** SPK-CAT-003: a copied offering requires the waivers its source requires. */
  async copyRequired(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    sourceOfferingId: string,
    targetOfferingId: string,
  ): Promise<void> {
    const keys = await this.requiredKeys(organizationId, sourceOfferingId, trx);
    if (keys.length === 0) return;
    await trx
      .insertInto('offering_required_waivers')
      .values(
        keys.map((policy_key) => ({
          organization_id: organizationId,
          offering_id: targetOfferingId,
          policy_key,
          added_by: json(snapshotActor(principal)),
        })),
      )
      .execute();
  }

  private async describeRequired(
    organizationId: string,
    offeringId: string,
    trx?: Trx,
  ): Promise<OfferingRequiredWaivers> {
    const keys = await this.requiredKeys(organizationId, offeringId, trx);
    const families = await this.reader.families(organizationId, this.clock.now(), keys, trx);
    return {
      offeringId,
      waivers: keys.map((policyKey) => {
        const inForce = families.get(policyKey)?.inForce ?? null;
        return {
          policyKey,
          currentVersion: inForce?.ref ?? null,
          enforcement: inForce?.content.enforcement ?? null,
        };
      }),
    };
  }

  private async overridesOf(organizationId: string, personId: string): Promise<WaiverOverride[]> {
    const ids = await this.persons.personIdsResolvingTo(organizationId, personId);
    const rows = await this.db
      .selectFrom('waiver_overrides')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', ids.length > 0 ? ids : [personId])
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toWaiverOverride);
  }

  /**
   * The facility an override is authorized against, for the activities the catalog owns (an
   * offering, or one of its sessions). An unknown one is refused. A scheduling event or a booking
   * belongs to another module, so its id is recorded as a reference and not resolved here.
   */
  private async activityFacility(
    trx: Trx,
    organizationId: string,
    activity: WaiverActivityRef,
  ): Promise<string | null> {
    if (activity.type === 'offering') {
      const row = await trx
        .selectFrom('offerings')
        .select('facility_id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', activity.id)
        .executeTakeFirst();
      if (!row) throw errors.notFound('offering', activity.id);
      return row.facility_id;
    }
    if (activity.type === 'offering_session') {
      const row = await trx
        .selectFrom('offering_sessions as s')
        .innerJoin('offerings as o', (join) =>
          join
            .onRef('o.organization_id', '=', 's.organization_id')
            .onRef('o.id', '=', 's.offering_id'),
        )
        .select('o.facility_id')
        .where('s.organization_id', '=', organizationId)
        .where('s.id', '=', activity.id)
        .executeTakeFirst();
      if (!row) throw errors.notFound('offering session', activity.id);
      return row.facility_id;
    }
    return null;
  }
}
