import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type CreateDiscountInput,
  type DiscountDefinition,
  type DiscountEvaluation,
  type EvaluateDiscountsInput,
  type ListDiscountsQuery,
  type Page,
  type Principal,
  type RetireDiscountInput,
  type UpdateDiscountInput,
} from '@sportspark/contracts';
import {
  isCheckViolation,
  isUniqueViolation,
  json,
  type Db,
  type DiscountStatus,
} from '@sportspark/db';
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
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import type {
  EvaluateDiscountsRequest,
  RedeemDiscountInput,
  RedemptionOutcome,
} from '../catalog.ports';
import { organizationOf, toDiscountDefinition } from '../catalog.shared';
import { DiscountMachine } from '../catalog.state-machines';
import { evaluateDiscounts, type EvaluableDiscount } from '../pricing/discount-evaluator';

const Cursor = z.object({ name: z.string(), id: z.string() });

/**
 * Discount definitions (SPK-PAY-003) and their redemption counters (§4.7 invariant 7). Evaluation
 * is the pure function in `pricing/discount-evaluator.ts`; redemption is a conditional update of
 * the counter row whose check constraint is the database-level guarantee.
 */
@Injectable()
export class DiscountsService {
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
    body: CreateDiscountInput,
    correlationId: string | null,
  ): Promise<DiscountDefinition> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.manageDiscounts, {
      type: 'discount_definition',
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('discount_definitions')
          .values({
            id,
            organization_id: organizationId,
            code: body.code ?? null,
            name: body.name,
            description: body.description ?? null,
            kind: body.code ? 'promo_code' : 'automatic',
            amount_kind: body.amountKind,
            amount_value: body.amountValue,
            currency: body.currency ?? null,
            eligibility_rules: json(body.eligibilityRules),
            stacking_rule: body.stackingRule,
            stacking_priority: body.stackingPriority,
            cap_minor: body.capMinor ?? null,
            redemption_limit: body.redemptionLimit ?? null,
            per_person_limit: body.perPersonLimit ?? null,
            rounding: body.rounding,
            allocation_method: body.allocationMethod,
            effective_from: new Date(body.effectiveFrom),
            effective_to: body.effectiveTo ? new Date(body.effectiveTo) : null,
            status: body.status,
            created_by: json(snapshotActor(principal)),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.validation('A discount with this code already exists.', { path: 'code' });
        }
        throw error;
      }
      await trx
        .insertInto('discount_redemptions')
        .values({
          organization_id: organizationId,
          discount_definition_id: id,
          redemption_limit: body.redemptionLimit ?? null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.discount_created',
        targetType: 'discount_definition',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: { code: row.code, policyReferences: body.policyReferences ?? [] },
      });
      await this.outbox.enqueue(trx, CatalogEvents.discountCreated, {
        organizationId,
        aggregateType: 'discount_definition',
        aggregateId: id,
        payload: { discountDefinitionId: id, code: row.code, status: row.status },
        correlationId,
      });
      return toDiscountDefinition(row, 0);
    });
  }

  async update(
    principal: Principal,
    id: string,
    body: UpdateDiscountInput,
    correlationId: string | null,
  ): Promise<DiscountDefinition> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.manageDiscounts, {
      type: 'discount_definition',
      id,
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const current = await this.loadForUpdate(trx, organizationId, id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      if (current.status === 'retired') {
        throw errors.invalidTransition('Discount', 'retired', 'update');
      }
      let status: DiscountStatus = current.status;
      if (body.status !== undefined && body.status !== current.status) {
        if (body.status !== 'active')
          throw errors.invalidTransition('Discount', current.status, 'revert_to_draft');
        status = DiscountMachine.next(current.status, 'activate');
      }
      if (
        body.effectiveTo !== undefined &&
        body.effectiveTo !== null &&
        new Date(body.effectiveTo).getTime() <= new Date(current.effective_from).getTime()
      ) {
        throw errors.validation('effectiveTo must be after effectiveFrom.', {
          path: 'effectiveTo',
        });
      }
      const updated = await trx
        .updateTable('discount_definitions')
        .set({
          name: body.name,
          description: body.description,
          eligibility_rules:
            body.eligibilityRules === undefined ? undefined : json(body.eligibilityRules),
          stacking_rule: body.stackingRule,
          stacking_priority: body.stackingPriority,
          cap_minor: body.capMinor,
          redemption_limit: body.redemptionLimit,
          per_person_limit: body.perPersonLimit,
          rounding: body.rounding,
          allocation_method: body.allocationMethod,
          effective_to:
            body.effectiveTo === undefined
              ? undefined
              : body.effectiveTo
                ? new Date(body.effectiveTo)
                : null,
          status,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (body.redemptionLimit !== undefined) {
        try {
          await trx
            .updateTable('discount_redemptions')
            .set({ redemption_limit: body.redemptionLimit })
            .where('organization_id', '=', organizationId)
            .where('discount_definition_id', '=', id)
            .execute();
        } catch (error) {
          if (isCheckViolation(error)) {
            throw errors.validation(
              'redemptionLimit cannot be lower than the number already redeemed.',
              {
                path: 'redemptionLimit',
              },
            );
          }
          throw error;
        }
      }
      const counter = await this.counter(trx, organizationId, id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.discount_updated',
        targetType: 'discount_definition',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId,
        details: status !== current.status ? { status } : {},
      });
      await this.outbox.enqueue(trx, CatalogEvents.discountUpdated, {
        organizationId,
        aggregateType: 'discount_definition',
        aggregateId: id,
        payload: { discountDefinitionId: id, revision: updated.revision, status: updated.status },
        correlationId,
      });
      return toDiscountDefinition(updated, counter.redeemed_count);
    });
  }

  async retire(
    principal: Principal,
    id: string,
    body: RetireDiscountInput,
    correlationId: string | null,
  ): Promise<DiscountDefinition> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.manageDiscounts, {
      type: 'discount_definition',
      id,
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const current = await this.loadForUpdate(trx, organizationId, id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = DiscountMachine.next(current.status, 'retire');
      const updated = await trx
        .updateTable('discount_definitions')
        .set({ status: next, revision: current.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      const counter = await this.counter(trx, organizationId, id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.discount_retired',
        targetType: 'discount_definition',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, CatalogEvents.discountRetired, {
        organizationId,
        aggregateType: 'discount_definition',
        aggregateId: id,
        payload: { discountDefinitionId: id, reason: body.reason },
        correlationId,
      });
      return toDiscountDefinition(updated, counter.redeemed_count);
    });
  }

  async get(principal: Principal, id: string): Promise<DiscountDefinition> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'discount_definition',
      id,
      organizationId,
    });
    const row = await this.db
      .selectFrom('discount_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('discount', id);
    const counter = await this.counter(this.db, organizationId, id);
    return toDiscountDefinition(row, counter.redeemed_count);
  }

  async list(principal: Principal, query: ListDiscountsQuery): Promise<Page<DiscountDefinition>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'discount_definition',
      organizationId,
    });
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('discount_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.code) q = q.where(sql<boolean>`lower(code) = lower(${query.code})`);
    if (cursor) q = q.where(sql<boolean>`(name, id) > (${cursor.name}, ${cursor.id}::uuid)`);
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const counters = await this.db
      .selectFrom('discount_redemptions')
      .select(['discount_definition_id', 'redeemed_count'])
      .where('organization_id', '=', organizationId)
      .where('discount_definition_id', 'in', page.length > 0 ? page.map((r) => r.id) : [newId()])
      .execute();
    const counts = new Map(counters.map((c) => [c.discount_definition_id, c.redeemed_count]));
    const items = page.map((r) => toDiscountDefinition(r, counts.get(r.id) ?? 0));
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return { items, nextCursor: last ? encodeCursor({ name: last.name, id: last.id }) : null };
  }

  /** Explainable preview for staff (any reader) or a customer about their own basket. */
  async evaluate(principal: Principal, body: EvaluateDiscountsInput): Promise<DiscountEvaluation> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.evaluateDiscounts, {
      type: 'discount_evaluation',
      organizationId,
      subjectPersonIds:
        principal.kind === 'customer' && principal.personId ? [principal.personId] : undefined,
    });
    return this.evaluateForOrganization(organizationId, {
      currency: body.currency,
      at: body.at ? new Date(body.at) : this.clock.now(),
      lines: body.lines,
      codes: body.codes,
    });
  }

  async evaluateForOrganization(
    organizationId: string,
    input: EvaluateDiscountsRequest,
    trx?: Trx,
  ): Promise<DiscountEvaluation> {
    const db = trx ?? this.db;
    const rows = await db
      .selectFrom('discount_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .where('effective_from', '<=', input.at)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', input.at)]))
      .execute();
    const knownCodes = await db
      .selectFrom('discount_definitions')
      .select('code')
      .where('organization_id', '=', organizationId)
      .where('code', 'is not', null)
      .execute();
    const ids = rows.map((r) => r.id);
    const counters = ids.length
      ? await db
          .selectFrom('discount_redemptions')
          .select(['discount_definition_id', 'redeemed_count'])
          .where('organization_id', '=', organizationId)
          .where('discount_definition_id', 'in', ids)
          .execute()
      : [];
    const counts = new Map(counters.map((c) => [c.discount_definition_id, c.redeemed_count]));
    const participants = [
      ...new Set(input.lines.map((l) => l.participantPersonId).filter((p): p is string => !!p)),
    ];
    const perPerson = new Map<string, Record<string, number>>();
    if (ids.length > 0 && participants.length > 0) {
      const entries = await db
        .selectFrom('discount_redemption_entries')
        .select(['discount_definition_id', 'person_id', 'kind'])
        .where('organization_id', '=', organizationId)
        .where('discount_definition_id', 'in', ids)
        .where('person_id', 'in', participants)
        .execute();
      for (const e of entries) {
        if (!e.person_id) continue;
        const byPerson = perPerson.get(e.discount_definition_id) ?? {};
        byPerson[e.person_id] = (byPerson[e.person_id] ?? 0) + (e.kind === 'redeem' ? 1 : -1);
        perPerson.set(e.discount_definition_id, byPerson);
      }
    }
    const definitions: EvaluableDiscount[] = rows.map((r) => ({
      ...toDiscountDefinition(r, counts.get(r.id) ?? 0),
      redeemedByPerson: perPerson.get(r.id) ?? {},
    }));
    // Codes that exist but are inactive are "known" so the explanation is "not active", not "unknown".
    const inactiveKnown: EvaluableDiscount[] = knownCodes
      .filter((k) => k.code !== null && !rows.some((r) => r.code === k.code))
      .map((k) => ({
        id: newId(),
        code: k.code,
        name: k.code ?? '',
        kind: 'promo_code',
        amountKind: 'fixed',
        amountValue: 1,
        currency: input.currency,
        eligibilityRules: {},
        stackingRule: 'stackable',
        stackingPriority: 0,
        capMinor: null,
        redemptionLimit: null,
        perPersonLimit: null,
        rounding: 'half_up',
        allocationMethod: 'proportional',
        effectiveFrom: new Date(0).toISOString(),
        effectiveTo: null,
        status: 'retired',
        redeemedCount: 0,
      }));
    return evaluateDiscounts({
      currency: input.currency,
      at: input.at,
      lines: input.lines,
      codes: input.codes,
      definitions: [...definitions, ...inactiveKnown],
    });
  }

  // -------------------------------------------------------------------------------------------
  // Redemption inside the caller's transaction (finance checkout, §4.11 step 7)
  // -------------------------------------------------------------------------------------------

  async redeem(
    trx: Trx,
    organizationId: string,
    input: RedeemDiscountInput,
  ): Promise<RedemptionOutcome> {
    const definition = await trx
      .selectFrom('discount_definitions')
      .select(['id', 'status', 'per_person_limit'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', input.discountDefinitionId)
      .executeTakeFirst();
    if (!definition) throw errors.notFound('discount', input.discountDefinitionId);
    // Lock the counter row before anything is counted (SPK-PAY-003 per-person limit): concurrent
    // redemptions of one discount serialize here, so the replay check and the participant's
    // ledger count below see every redemption committed before the lock was granted.
    const counterBefore = await this.counter(trx, organizationId, definition.id, true);
    const existing = await this.entry(trx, organizationId, input, 'redeem');
    if (existing) {
      return {
        discountDefinitionId: definition.id,
        redeemedCount: counterBefore.redeemed_count,
        redemptionLimit: counterBefore.redemption_limit,
        replayed: true,
      };
    }
    if (definition.status !== 'active') {
      throw errors.resourceConflict('The discount is no longer active.', {
        code: 'DISCOUNT_NOT_ACTIVE',
        discountDefinitionId: definition.id,
      });
    }
    if (definition.per_person_limit !== null && input.personId) {
      const used = await this.personRedemptions(trx, organizationId, definition.id, input.personId);
      if (used >= definition.per_person_limit) {
        throw errors.resourceConflict('The participant has already used this discount.', {
          code: 'DISCOUNT_PER_PERSON_LIMIT',
          discountDefinitionId: definition.id,
          perPersonLimit: definition.per_person_limit,
        });
      }
    }
    await this.insertEntry(trx, organizationId, input, 'redeem');
    // Conditional update: the row only changes while under the limit; the check constraint on
    // discount_redemptions is the final guarantee (§4.7 invariant 7).
    const updated = await trx
      .updateTable('discount_redemptions')
      .set({ redeemed_count: sql`redeemed_count + 1` })
      .where('organization_id', '=', organizationId)
      .where('discount_definition_id', '=', definition.id)
      .where((eb) =>
        eb.or([
          eb('redemption_limit', 'is', null),
          eb('redeemed_count', '<', eb.ref('redemption_limit')),
        ]),
      )
      .returning(['redeemed_count', 'redemption_limit'])
      .executeTakeFirst();
    if (!updated) {
      throw errors.resourceConflict('The discount has reached its redemption limit.', {
        code: 'DISCOUNT_REDEMPTION_LIMIT',
        discountDefinitionId: definition.id,
        redemptionLimit: counterBefore.redemption_limit,
      });
    }
    await this.audit.record(trx, {
      organizationId,
      actor: input.actor,
      action: 'catalog.discount_redeemed',
      targetType: 'discount_definition',
      targetId: definition.id,
      correlationId: input.correlationId ?? null,
      details: {
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        redeemedCount: updated.redeemed_count,
      },
    });
    await this.outbox.enqueue(trx, CatalogEvents.discountRedeemed, {
      organizationId,
      aggregateType: 'discount_definition',
      aggregateId: definition.id,
      payload: {
        discountDefinitionId: definition.id,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        redeemedCount: updated.redeemed_count,
        redemptionLimit: updated.redemption_limit,
      },
      correlationId: input.correlationId ?? null,
    });
    return {
      discountDefinitionId: definition.id,
      redeemedCount: updated.redeemed_count,
      redemptionLimit: updated.redemption_limit,
      replayed: false,
    };
  }

  async release(
    trx: Trx,
    organizationId: string,
    input: RedeemDiscountInput,
  ): Promise<RedemptionOutcome> {
    const redeemed = await trx
      .selectFrom('discount_redemption_entries')
      .select(['id', 'person_id', 'amount_minor', 'currency'])
      .where('organization_id', '=', organizationId)
      .where('discount_definition_id', '=', input.discountDefinitionId)
      .where('reference_type', '=', input.referenceType)
      .where('reference_id', '=', input.referenceId)
      .where('kind', '=', 'redeem')
      .executeTakeFirst();
    if (!redeemed) {
      throw errors.notFound('discount redemption', `${input.referenceType}:${input.referenceId}`);
    }
    // SPK-PAY-003: the release gives the allowance back to the participant who redeemed, never
    // to whoever the caller names; a mismatching personId is refused, replay included.
    if (
      input.personId !== undefined &&
      input.personId !== null &&
      input.personId !== redeemed.person_id
    ) {
      throw errors.validation('personId does not match the redemption being released.', {
        path: 'personId',
      });
    }
    const counterBefore = await this.counter(trx, organizationId, input.discountDefinitionId, true);
    const existing = await this.entry(trx, organizationId, input, 'release');
    if (existing) {
      return {
        discountDefinitionId: input.discountDefinitionId,
        redeemedCount: counterBefore.redeemed_count,
        redemptionLimit: counterBefore.redemption_limit,
        replayed: true,
      };
    }
    // The release row mirrors the redeem row it reverses (append-only correction).
    await this.insertEntry(
      trx,
      organizationId,
      {
        ...input,
        personId: redeemed.person_id,
        amountMinor: redeemed.amount_minor === null ? null : Number(redeemed.amount_minor),
        currency: redeemed.currency,
      },
      'release',
    );
    const updated = await trx
      .updateTable('discount_redemptions')
      .set({ redeemed_count: sql`redeemed_count - 1` })
      .where('organization_id', '=', organizationId)
      .where('discount_definition_id', '=', input.discountDefinitionId)
      .returning(['redeemed_count', 'redemption_limit'])
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId,
      actor: input.actor,
      action: 'catalog.discount_released',
      targetType: 'discount_definition',
      targetId: input.discountDefinitionId,
      correlationId: input.correlationId ?? null,
      details: { referenceType: input.referenceType, referenceId: input.referenceId },
    });
    await this.outbox.enqueue(trx, CatalogEvents.discountReleased, {
      organizationId,
      aggregateType: 'discount_definition',
      aggregateId: input.discountDefinitionId,
      payload: {
        discountDefinitionId: input.discountDefinitionId,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        redeemedCount: updated.redeemed_count,
      },
      correlationId: input.correlationId ?? null,
    });
    return {
      discountDefinitionId: input.discountDefinitionId,
      redeemedCount: updated.redeemed_count,
      redemptionLimit: updated.redemption_limit,
      replayed: false,
    };
  }

  // -------------------------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------------------------

  private async loadForUpdate(trx: Trx, organizationId: string, id: string) {
    const row = await trx
      .selectFrom('discount_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('discount', id);
    return row;
  }

  private async counter(db: Db | Trx, organizationId: string, id: string, forUpdate = false) {
    return db
      .selectFrom('discount_redemptions')
      .select(['redeemed_count', 'redemption_limit'])
      .where('organization_id', '=', organizationId)
      .where('discount_definition_id', '=', id)
      .$if(forUpdate, (qb) => qb.forUpdate())
      .executeTakeFirstOrThrow(() => errors.notFound('discount', id));
  }

  private entry(
    trx: Trx,
    organizationId: string,
    input: RedeemDiscountInput,
    kind: 'redeem' | 'release',
  ) {
    return trx
      .selectFrom('discount_redemption_entries')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('discount_definition_id', '=', input.discountDefinitionId)
      .where('reference_type', '=', input.referenceType)
      .where('reference_id', '=', input.referenceId)
      .where('kind', '=', kind)
      .executeTakeFirst();
  }

  private async insertEntry(
    trx: Trx,
    organizationId: string,
    input: RedeemDiscountInput,
    kind: 'redeem' | 'release',
  ): Promise<void> {
    await trx
      .insertInto('discount_redemption_entries')
      .values({
        id: newId(),
        organization_id: organizationId,
        discount_definition_id: input.discountDefinitionId,
        kind,
        reference_type: input.referenceType,
        reference_id: input.referenceId,
        person_id: input.personId ?? null,
        amount_minor: input.amountMinor ?? null,
        currency: input.currency ?? null,
        actor: json(snapshotActor(input.actor)),
        occurred_at: this.clock.now(),
      })
      .execute();
  }

  private async personRedemptions(
    trx: Trx,
    organizationId: string,
    discountDefinitionId: string,
    personId: string,
  ): Promise<number> {
    const rows = await trx
      .selectFrom('discount_redemption_entries')
      .select('kind')
      .where('organization_id', '=', organizationId)
      .where('discount_definition_id', '=', discountDefinitionId)
      .where('person_id', '=', personId)
      .execute();
    return rows.reduce((n, r) => n + (r.kind === 'redeem' ? 1 : -1), 0);
  }
}
