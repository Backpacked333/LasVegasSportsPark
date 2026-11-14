import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  PUBLIC_PUBLICATION_STATES,
  type CreatePriceRuleInput,
  type PriceRule,
  type Principal,
} from '@sportspark/contracts';
import { isExclusionViolation, json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  executorFor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import type { RemainingSession } from '../catalog.ports';
import { organizationOf, toPriceRule } from '../catalog.shared';

/**
 * Versioned price rules (SPK-PAY-001, SPK-PAY-002 "historical purchases retain their price
 * basis", §4.5). There is no update: a change is a new version that starts now or later, and the
 * previously open-ended rule is closed at that instant. The exclusion constraint in migration
 * 0200 is the final guarantee that one rule is effective per offering per instant; the trigger
 * keeps every rule's pricing content immutable.
 *
 * Proposed amendments (migration 0211): a rule may be priced per session (SPK-PAY-013, PA-02,
 * capability `per_session_pricing`) and may carry a member price with the membership entitlement
 * it requires (SPK-PAY-015, PA-04, capability `member_pricing`). With a capability off the
 * corresponding fields are refused on write; a rule without them is written exactly as before.
 */
@Injectable()
export class PriceRulesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
  ) {}

  async create(
    principal: Principal,
    offeringId: string,
    body: CreatePriceRuleInput,
    correlationId: string | null,
  ): Promise<PriceRule> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const offering = await trx
        .selectFrom('offerings')
        .select(['id', 'facility_id', 'publication_state'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', offeringId)
        .forUpdate()
        .executeTakeFirst();
      if (!offering) throw errors.notFound('offering', offeringId);
      await this.authorization.require(principal, CatalogActions.managePriceRules, {
        type: 'price_rule',
        organizationId,
        facilityId: offering.facility_id,
      });
      if (offering.publication_state === 'archived') {
        throw errors.invalidTransition('OfferingPublication', 'archived', 'price');
      }
      // SPK-PAY-013 (PA-02), SPK-PAY-015 (PA-04): each amendment is a new commitment of its own
      // capability, refused inside the unit of work while the organization has it off (DEC-016).
      if (body.pricingBasis === 'per_session') {
        await this.capabilities.require(organizationId, 'per_session_pricing', trx);
      }
      let memberEntitlementName: string | null = null;
      if (body.memberEntitlementDefinitionId !== undefined) {
        await this.capabilities.require(organizationId, 'member_pricing', trx);
        // An unknown id and another organization's id read the same (§4.10); the composite
        // foreign key of migration 0211 is the guarantee.
        const definition = await trx
          .selectFrom('entitlement_definitions')
          .select(['id', 'name', 'kind', 'status'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', body.memberEntitlementDefinitionId)
          .executeTakeFirst();
        if (!definition) {
          throw errors.validation('The membership entitlement is not known.', {
            path: 'memberEntitlementDefinitionId',
          });
        }
        if (definition.kind !== 'membership_benefit' || definition.status !== 'active') {
          throw errors.validation(
            'A member price names an active membership entitlement (SPK-PAY-015, SPK-COND-001).',
            {
              path: 'memberEntitlementDefinitionId',
              kind: definition.kind,
              status: definition.status,
            },
          );
        }
        memberEntitlementName = definition.name;
      }
      const now = this.clock.now();
      const effectiveFrom = new Date(body.effectiveFrom);
      const effectiveTo = body.effectiveTo ? new Date(body.effectiveTo) : null;
      // SPK-PAY-002: a new rule never prices instants that have already passed, in any branch.
      if (effectiveFrom.getTime() < now.getTime()) {
        throw errors.validation(
          'effectiveFrom must be at or after now; historical prices are never rewritten (SPK-PAY-002).',
          { path: 'effectiveFrom' },
        );
      }

      const overlapping = await trx
        .selectFrom('price_rules')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('offering_id', '=', offeringId)
        .where((eb) =>
          eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', effectiveFrom)]),
        )
        .where((eb) => (effectiveTo ? eb('effective_from', '<', effectiveTo) : eb.lit(true)))
        .orderBy('effective_from')
        .execute();

      let supersededPriceRuleId: string | null = null;
      const [first] = overlapping;
      if (
        overlapping.length === 1 &&
        first &&
        first.effective_to === null &&
        effectiveTo === null &&
        effectiveFrom.getTime() > new Date(first.effective_from).getTime()
      ) {
        // An open-ended successor closes the current open-ended rule where it begins (never in
        // the past). A bounded window overlapping an existing rule is a conflict: closing the old
        // rule would leave the offering unpriced after the window, and splitting it would rewrite
        // a rule that quotes may already cite.
        await trx
          .updateTable('price_rules')
          .set({ effective_to: effectiveFrom, revision: first.revision + 1 })
          .where('organization_id', '=', organizationId)
          .where('id', '=', first.id)
          .where('revision', '=', first.revision)
          .execute();
        supersededPriceRuleId = first.id;
      } else if (overlapping.length > 0) {
        throw errors.resourceConflict(
          'A price rule is already effective in this window. An open-ended successor may start at or after now and after the current rule began; bounded windows must not overlap an existing rule, and historical prices are never rewritten.',
          { conflictingPriceRuleIds: overlapping.map((r) => r.id) },
        );
      }

      const latest = await trx
        .selectFrom('price_rules')
        .select((eb) => eb.fn.max('version').as('version'))
        .where('organization_id', '=', organizationId)
        .where('offering_id', '=', offeringId)
        .executeTakeFirst();
      const version = (latest?.version ?? 0) + 1;
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('price_rules')
          .values({
            id,
            organization_id: organizationId,
            offering_id: offeringId,
            version,
            effective_from: effectiveFrom,
            effective_to: effectiveTo,
            base_price_minor: body.basePriceMinor,
            currency: body.currency,
            charge_lines: json(body.chargeLines),
            pricing_basis: body.pricingBasis,
            member_price_minor: body.memberPriceMinor ?? null,
            member_entitlement_definition_id: body.memberEntitlementDefinitionId ?? null,
            created_by: json(snapshotActor(principal)),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isExclusionViolation(error)) {
          throw errors.resourceConflict('A price rule is already effective in this window.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.price_rule_created',
        targetType: 'price_rule',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: {
          offeringId,
          version,
          basePriceMinor: body.basePriceMinor,
          currency: body.currency,
          pricingBasis: body.pricingBasis,
          memberPriceMinor: body.memberPriceMinor ?? null,
          memberEntitlementDefinitionId: body.memberEntitlementDefinitionId ?? null,
          supersededPriceRuleId,
          policyReferences: body.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.priceRuleCreated, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: offeringId,
        payload: {
          priceRuleId: id,
          offeringId,
          version,
          effectiveFrom: effectiveFrom.toISOString(),
          effectiveTo: effectiveTo ? effectiveTo.toISOString() : null,
          basePriceMinor: body.basePriceMinor,
          currency: body.currency,
          supersededPriceRuleId,
        },
        correlationId,
      });
      return toPriceRule(row, memberEntitlementName);
    });
  }

  /**
   * Every version of an offering's price rules, for catalog readers at its facility (§4.14).
   * §4.10 (R4-AUTHZ-TARGETS-04 follow-up): the offering exists for the caller exactly as
   * GET /offerings/{id} says. An offering they cannot see (an unpublished one at a facility their
   * reading roles do not cover) is the same NOT_FOUND as an unknown id; a discoverable one they
   * may not read the rules of is ACCESS_DENIED.
   */
  async list(principal: Principal, offeringId: string): Promise<PriceRule[]> {
    const organizationId = organizationOf(principal);
    const offering = await this.db
      .selectFrom('offerings')
      .select(['id', 'facility_id', 'publication_state'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', offeringId)
      .executeTakeFirst();
    if (!offering) throw errors.protectedNotFound('offering');
    const target = {
      type: 'price_rule',
      organizationId,
      facilityId: offering.facility_id,
    };
    const reader = await this.authorization.decide(principal, CatalogActions.readCatalog, target);
    if (!reader.allowed && !PUBLIC_PUBLICATION_STATES.includes(offering.publication_state)) {
      throw errors.protectedNotFound('offering');
    }
    await this.authorization.require(principal, CatalogActions.readCatalog, target);
    const rows = await this.db
      .selectFrom('price_rules')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .orderBy('version')
      .execute();
    const names = await this.memberEntitlementNames(this.db, organizationId, rows);
    return rows.map((row) =>
      toPriceRule(row, names.get(row.member_entitlement_definition_id ?? '') ?? null),
    );
  }

  /** The names of the membership entitlements the rules name (SPK-PAY-015), in one read. */
  private async memberEntitlementNames(
    db: Db | Trx,
    organizationId: string,
    rows: ReadonlyArray<{ member_entitlement_definition_id: string | null }>,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(rows.flatMap((row) => row.member_entitlement_definition_id ?? [])),
    ].sort();
    if (ids.length === 0) return new Map();
    const definitions = await db
      .selectFrom('entitlement_definitions')
      .select(['id', 'name'])
      .where('organization_id', '=', organizationId)
      .where('id', 'in', ids)
      .execute();
    return new Map(definitions.map((d) => [d.id, d.name]));
  }

  async effectivePriceRule(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<PriceRule | null> {
    const map = await this.effectivePriceRules(organizationId, [offeringId], at, trx);
    return map.get(offeringId) ?? null;
  }

  /** Batched lookup for listings: the rule effective at `at` per offering id. */
  async effectivePriceRules(
    organizationId: string,
    offeringIds: readonly string[],
    at: Date,
    trx?: Trx,
  ): Promise<Map<string, PriceRule>> {
    const out = new Map<string, PriceRule>();
    if (offeringIds.length === 0) return out;
    const db = trx ?? executorFor(this.db);
    const rows = await db
      .selectFrom('price_rules')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', 'in', [...offeringIds])
      .where('effective_from', '<=', at)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
      .execute();
    const names = await this.memberEntitlementNames(db, organizationId, rows);
    for (const row of rows) {
      out.set(
        row.offering_id,
        toPriceRule(row, names.get(row.member_entitlement_definition_id ?? '') ?? null),
      );
    }
    return out;
  }

  /**
   * SPK-PAY-013 (PA-02): the sessions of an offering a participant joining at `at` can still
   * attend: status `scheduled` and a start strictly after `at` (the proposed cut-off, DEC-096
   * pending: a session counts until it starts). Ordered by start, then id, so the list a quote
   * stores is stable.
   */
  async remainingSessions(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<RemainingSession[]> {
    const rows = await (trx ?? executorFor(this.db))
      .selectFrom('offering_sessions')
      .select(['id', 'scheduled_start'])
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .where('status', '=', 'scheduled')
      .where('scheduled_start', '>', at)
      .orderBy('scheduled_start')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      scheduledStart: new Date(row.scheduled_start).toISOString(),
    }));
  }

  /** Batched count of `remainingSessions` per offering id, for listings (absent = none). */
  async remainingSessionCounts(
    organizationId: string,
    offeringIds: readonly string[],
    at: Date,
    trx?: Trx,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (offeringIds.length === 0) return out;
    const rows = await (trx ?? executorFor(this.db))
      .selectFrom('offering_sessions')
      .select((eb) => ['offering_id', eb.fn.countAll<string>().as('count')])
      .where('organization_id', '=', organizationId)
      .where('offering_id', 'in', [...offeringIds])
      .where('status', '=', 'scheduled')
      .where('scheduled_start', '>', at)
      .groupBy('offering_id')
      .execute();
    for (const row of rows) out.set(row.offering_id, Number(row.count));
    return out;
  }
}
