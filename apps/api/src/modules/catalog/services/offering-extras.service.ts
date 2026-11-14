import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  PUBLIC_PUBLICATION_STATES,
  type CreateOfferingAddonInput,
  type CreateOfferingUniformInput,
  type OfferingAddon,
  type OfferingPurchaseOptions,
  type OfferingUniform,
  type Principal,
  type RetireOfferingExtraInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
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
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import type { OfferingExtras } from '../catalog.ports';
import { organizationOf, toOfferingAddon, toOfferingUniform } from '../catalog.shared';
import { PriceRulesService } from './price-rules.service';

/**
 * Add-ons and uniforms of an offering (proposed amendments, both Proposed):
 *
 * - **Add-ons** (SPK-PAY-014, PA-03; capability `price_tiers_addons`, DEC-097 pending): an
 *   optional extra with its own price, selected once for the registration or per session, with
 *   an optional capacity of its own. Created and retired; never edited in what a purchase depends
 *   on (migration 0216), so a change is a retirement and a new add-on.
 * - **Uniforms** (SPK-REG-012, PA-07; capability `uniforms`, DEC-101 pending): the kit an
 *   offering requires or offers, with sizes, an optional price and the returning-participant rule.
 *   One live uniform per offering (migration 0217).
 *
 * Every command requires its capability inside its unit of work. Reads of records that exist stay
 * available to staff while a capability is off; the customer-facing purchase options show nothing
 * of a feature whose capability is off.
 */
@Injectable()
export class OfferingExtrasService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly priceRules: PriceRulesService,
  ) {}

  private async offeringForCommand(trx: Trx, organizationId: string, offeringId: string) {
    const offering = await trx
      .selectFrom('offerings')
      .select(['id', 'facility_id', 'publication_state'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', offeringId)
      .forUpdate()
      .executeTakeFirst();
    if (!offering) throw errors.notFound('offering', offeringId);
    return offering;
  }

  // -------------------------------------------------------------------------------------------
  // Add-ons (SPK-PAY-014)
  // -------------------------------------------------------------------------------------------

  async createAddon(
    principal: Principal,
    offeringId: string,
    body: CreateOfferingAddonInput,
    correlationId: string | null,
  ): Promise<OfferingAddon> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const offering = await this.offeringForCommand(trx, organizationId, offeringId);
      await this.authorization.require(principal, CatalogActions.manageOfferingAddons, {
        type: 'offering_addon',
        organizationId,
        facilityId: offering.facility_id,
      });
      await this.capabilities.require(organizationId, 'price_tiers_addons', trx);
      if (offering.publication_state === 'archived') {
        throw errors.invalidTransition('OfferingPublication', 'archived', 'add_addon');
      }
      // A basket holds one currency (SPK-PAY-001): an add-on is priced in the offering's.
      const rule = await this.priceRules.effectivePriceRule(
        organizationId,
        offeringId,
        this.clock.now(),
        trx,
      );
      if (rule && rule.currency !== body.currency) {
        throw errors.validation(
          `An add-on is priced in the currency of its offering (${rule.currency}).`,
          { path: 'currency' },
        );
      }
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('offering_addons')
          .values({
            id,
            organization_id: organizationId,
            offering_id: offeringId,
            code: body.code,
            name: body.name,
            description: body.description ?? null,
            price_minor: body.priceMinor,
            currency: body.currency,
            charge_lines: json(body.chargeLines),
            selection: body.selection,
            capacity: body.capacity ?? null,
            created_by: json(snapshotActor(principal)),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('This offering already has a live add-on with that code.', {
            code: 'ADDON_CODE_TAKEN',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CatalogActions.manageOfferingAddons.id,
        targetType: 'offering_addon',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: {
          offeringId,
          code: body.code,
          priceMinor: body.priceMinor,
          currency: body.currency,
          selection: body.selection,
          capacity: body.capacity ?? null,
          policyReferences: body.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.offeringAddonChanged, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: offeringId,
        payload: { addonId: id, offeringId, status: 'active' },
        correlationId,
      });
      return toOfferingAddon(row);
    });
  }

  async retireAddon(
    principal: Principal,
    addonId: string,
    body: RetireOfferingExtraInput,
    correlationId: string | null,
  ): Promise<OfferingAddon> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const addon = await trx
        .selectFrom('offering_addons')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', addonId)
        .forUpdate()
        .executeTakeFirst();
      if (!addon) throw errors.notFound('offering_addon', addonId);
      const offering = await this.offeringForCommand(trx, organizationId, addon.offering_id);
      await this.authorization.require(principal, CatalogActions.manageOfferingAddons, {
        type: 'offering_addon',
        id: addonId,
        organizationId,
        facilityId: offering.facility_id,
      });
      await this.capabilities.require(organizationId, 'price_tiers_addons', trx);
      assertExpectedRevision(body.expectedRevision, addon.revision);
      if (addon.status === 'retired') return toOfferingAddon(addon);
      const row = await trx
        .updateTable('offering_addons')
        .set({ status: 'retired', retired_at: this.clock.now(), revision: addon.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', addonId)
        .where('revision', '=', addon.revision)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw errors.staleRevision(addon.revision, addon.revision + 1);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CatalogActions.manageOfferingAddons.id,
        targetType: 'offering_addon',
        targetId: addonId,
        beforeRevision: addon.revision,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: { offeringId: addon.offering_id, retired: true },
      });
      await this.outbox.enqueue(trx, CatalogEvents.offeringAddonChanged, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: addon.offering_id,
        payload: { addonId, offeringId: addon.offering_id, status: 'retired' },
        correlationId,
      });
      return toOfferingAddon(row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Uniforms (SPK-REG-012)
  // -------------------------------------------------------------------------------------------

  async createUniform(
    principal: Principal,
    offeringId: string,
    body: CreateOfferingUniformInput,
    correlationId: string | null,
  ): Promise<OfferingUniform> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const offering = await this.offeringForCommand(trx, organizationId, offeringId);
      await this.authorization.require(principal, CatalogActions.manageOfferingUniforms, {
        type: 'offering_uniform',
        organizationId,
        facilityId: offering.facility_id,
      });
      await this.capabilities.require(organizationId, 'uniforms', trx);
      if (offering.publication_state === 'archived') {
        throw errors.invalidTransition('OfferingPublication', 'archived', 'set_uniform');
      }
      if (body.currency !== undefined) {
        const rule = await this.priceRules.effectivePriceRule(
          organizationId,
          offeringId,
          this.clock.now(),
          trx,
        );
        if (rule && rule.currency !== body.currency) {
          throw errors.validation(
            `A uniform is priced in the currency of its offering (${rule.currency}).`,
            { path: 'currency' },
          );
        }
      }
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('offering_uniforms')
          .values({
            id,
            organization_id: organizationId,
            offering_id: offeringId,
            item_key: body.itemKey,
            name: body.name,
            sizes: json(body.sizes),
            requirement: body.requirement,
            price_minor: body.priceMinor ?? null,
            currency: body.currency ?? null,
            charge_lines: json(body.chargeLines),
            returning_holder_free: body.returningHolderFree,
            created_by: json(snapshotActor(principal)),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict(
            'This offering already has a uniform; retire it before setting another.',
            { code: 'UNIFORM_ALREADY_SET' },
          );
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CatalogActions.manageOfferingUniforms.id,
        targetType: 'offering_uniform',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: {
          offeringId,
          itemKey: body.itemKey,
          sizes: body.sizes,
          requirement: body.requirement,
          priceMinor: body.priceMinor ?? null,
          currency: body.currency ?? null,
          returningHolderFree: body.returningHolderFree,
          policyReferences: body.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.offeringUniformChanged, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: offeringId,
        payload: { offeringUniformId: id, offeringId, status: 'active' },
        correlationId,
      });
      return toOfferingUniform(row);
    });
  }

  async retireUniform(
    principal: Principal,
    uniformId: string,
    body: RetireOfferingExtraInput,
    correlationId: string | null,
  ): Promise<OfferingUniform> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const uniform = await trx
        .selectFrom('offering_uniforms')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', uniformId)
        .forUpdate()
        .executeTakeFirst();
      if (!uniform) throw errors.notFound('offering_uniform', uniformId);
      const offering = await this.offeringForCommand(trx, organizationId, uniform.offering_id);
      await this.authorization.require(principal, CatalogActions.manageOfferingUniforms, {
        type: 'offering_uniform',
        id: uniformId,
        organizationId,
        facilityId: offering.facility_id,
      });
      await this.capabilities.require(organizationId, 'uniforms', trx);
      assertExpectedRevision(body.expectedRevision, uniform.revision);
      if (uniform.status === 'retired') return toOfferingUniform(uniform);
      const row = await trx
        .updateTable('offering_uniforms')
        .set({ status: 'retired', retired_at: this.clock.now(), revision: uniform.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', uniformId)
        .where('revision', '=', uniform.revision)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw errors.staleRevision(uniform.revision, uniform.revision + 1);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CatalogActions.manageOfferingUniforms.id,
        targetType: 'offering_uniform',
        targetId: uniformId,
        beforeRevision: uniform.revision,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: { offeringId: uniform.offering_id, retired: true },
      });
      await this.outbox.enqueue(trx, CatalogEvents.offeringUniformChanged, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: uniform.offering_id,
        payload: {
          offeringUniformId: uniformId,
          offeringId: uniform.offering_id,
          status: 'retired',
        },
        correlationId,
      });
      return toOfferingUniform(row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /** The offering as the caller may see it: staff readers, or anyone for a published one (§4.10). */
  private async readableOffering(principal: Principal, offeringId: string) {
    const organizationId = organizationOf(principal);
    const offering = await this.db
      .selectFrom('offerings')
      .select(['id', 'facility_id', 'publication_state'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', offeringId)
      .executeTakeFirst();
    if (!offering) throw errors.protectedNotFound('offering');
    const reader = await this.authorization.decide(principal, CatalogActions.readCatalog, {
      type: 'offering',
      organizationId,
      facilityId: offering.facility_id,
    });
    if (!reader.allowed && !PUBLIC_PUBLICATION_STATES.includes(offering.publication_state)) {
      throw errors.protectedNotFound('offering');
    }
    return { organizationId, offering, staff: reader.allowed };
  }

  /** Every add-on of the offering, retired ones included (staff catalog readers). */
  async listAddons(principal: Principal, offeringId: string): Promise<OfferingAddon[]> {
    const { organizationId, offering } = await this.readableOffering(principal, offeringId);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'offering_addon',
      organizationId,
      facilityId: offering.facility_id,
    });
    return (await this.offeringExtras(organizationId, offeringId)).addons;
  }

  /** Every uniform of the offering, retired ones included (staff catalog readers). */
  async listUniforms(principal: Principal, offeringId: string): Promise<OfferingUniform[]> {
    const { organizationId, offering } = await this.readableOffering(principal, offeringId);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'offering_uniform',
      organizationId,
      facilityId: offering.facility_id,
    });
    return (await this.offeringExtras(organizationId, offeringId)).uniforms;
  }

  /**
   * What a customer chooses from when registering (SPK-PAY-014, SPK-REG-012): the tiers of the
   * rule effective now that can still be bought, the active add-ons and the active uniform. A
   * part whose capability is off is empty, so no client offers what the command would refuse.
   */
  async purchaseOptions(
    principal: Principal,
    offeringId: string,
  ): Promise<OfferingPurchaseOptions> {
    const { organizationId } = await this.readableOffering(principal, offeringId);
    const now = this.clock.now();
    const tiersOn = await this.capabilities.isEnabled(organizationId, 'price_tiers_addons');
    const uniformsOn = await this.capabilities.isEnabled(organizationId, 'uniforms');
    const rule = await this.priceRules.effectivePriceRule(organizationId, offeringId, now);
    const extras =
      tiersOn || uniformsOn
        ? await this.offeringExtras(organizationId, offeringId)
        : { addons: [], uniforms: [] };
    return {
      offeringId,
      priceRuleId: rule?.id ?? null,
      pricingBasis: rule?.pricingBasis ?? null,
      currency: rule?.currency ?? null,
      tiers:
        tiersOn && rule
          ? rule.tiers.filter(
              (tier) =>
                tier.availableUntil === null ||
                new Date(tier.availableUntil).getTime() > now.getTime(),
            )
          : [],
      addons: tiersOn ? extras.addons.filter((addon) => addon.status === 'active') : [],
      uniform: uniformsOn
        ? (extras.uniforms.find((uniform) => uniform.status === 'active') ?? null)
        : null,
    };
  }

  /**
   * PRICING_PORT: every add-on and uniform of the offering, retired ones included, for modules
   * that have authorized their own command (enrollment validates a selection, finance prices
   * it). Unknown and cross-organization ids answer empty lists.
   */
  async offeringExtras(
    organizationId: string,
    offeringId: string,
    trx?: Trx,
  ): Promise<OfferingExtras> {
    const db = trx ?? executorFor(this.db);
    const addons = await db
      .selectFrom('offering_addons')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const uniforms = await db
      .selectFrom('offering_uniforms')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return { addons: addons.map(toOfferingAddon), uniforms: uniforms.map(toOfferingUniform) };
  }
}
