import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CreatePriceRuleInput,
  type PriceRule,
  type Principal,
} from '@sportspark/contracts';
import { isExclusionViolation, json, type Db } from '@sportspark/db';
import {
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
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import { organizationOf, toPriceRule } from '../catalog.shared';

/**
 * Versioned price rules (SPK-PAY-001, SPK-PAY-002 "historical purchases retain their price
 * basis", §4.5). There is no update: a change is a new version that starts now or later, and the
 * previously open-ended rule is closed at that instant. The exclusion constraint in migration
 * 0200 is the final guarantee that one rule is effective per offering per instant; the trigger
 * keeps every rule's pricing content immutable.
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
      return toPriceRule(row);
    });
  }

  async list(principal: Principal, offeringId: string): Promise<PriceRule[]> {
    const organizationId = organizationOf(principal);
    const offering = await this.db
      .selectFrom('offerings')
      .select(['id', 'facility_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', offeringId)
      .executeTakeFirst();
    if (!offering) throw errors.notFound('offering', offeringId);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'price_rule',
      organizationId,
      facilityId: offering.facility_id,
    });
    const rows = await this.db
      .selectFrom('price_rules')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .orderBy('version')
      .execute();
    return rows.map(toPriceRule);
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
    const rows = await (trx ?? this.db)
      .selectFrom('price_rules')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', 'in', [...offeringIds])
      .where('effective_from', '<=', at)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
      .execute();
    for (const row of rows) out.set(row.offering_id, toPriceRule(row));
    return out;
  }
}
