import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type Basket,
  type BasketLine,
  type CreateQuoteInput,
  type LinePolicyReferences,
  type Principal,
  type Quote,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  PRICING_PORT,
  type OfferingLookupPort,
  type PricingPort,
} from '../../catalog';
import { BASKET_PORT, type BasketPort } from '../../enrollment';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import {
  isStaffLike,
  minutesFrom,
  organizationOf,
  toQuote,
  type QuoteRow,
  type Reader,
} from '../finance.shared';
import { computeQuote, type PlanInput, type QuoteLineInput } from '../pricing/quote-calculator';
import { FinancePolicyResolver } from './finance-policy.resolver';
import { MoneyFacts } from './money-facts.service';

/** Lines that a quote prices: held lines of a held basket, pending lines of an open one. */
export function quotableLines(basket: Basket): BasketLine[] {
  if (basket.status === 'held') return basket.lines.filter((l) => l.outcome === 'held');
  if (basket.status === 'open') return basket.lines.filter((l) => l.outcome === 'pending');
  return [];
}

/**
 * Registration quotes (SPK-PAY-001/002/003, §4.8 `POST /v1/registration-quotes`). The basket is
 * read through enrollment's BasketPort; every price comes from catalog's price rule effective now
 * (PricingPort), discounts from catalog's explainable evaluation, approved taxes and fees from the
 * price rule's charge lines, credits from the payer's active credits. Nothing the client sends is
 * a price: the request body carries no amounts and unknown properties are rejected. The quote
 * stores its full price and policy basis and expires (POL-013).
 */
@Injectable()
export class QuotesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BASKET_PORT) private readonly baskets: BasketPort,
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly policy: FinancePolicyResolver,
    private readonly facts: MoneyFacts,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<QuoteRow | undefined> {
    let q = db
      .selectFrom('quotes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async lines(db: Reader, organizationId: string, quoteId: string) {
    return db
      .selectFrom('quote_lines')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('quote_id', '=', quoteId)
      .orderBy('sequence')
      .execute();
  }

  async view(db: Reader, row: QuoteRow): Promise<Quote> {
    return toQuote(row, await this.lines(db, row.organization_id, row.id), this.clock.now());
  }

  async get(principal: Principal, id: string): Promise<Quote> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('quote');
    const lines = await this.lines(this.db, organizationId, id);
    await this.authorization.require(principal, FinanceActions.readQuote, {
      type: 'quote',
      id,
      organizationId,
      subjectPersonIds: [row.payer_person_id, ...lines.map((l) => l.participant_person_id)],
      protected: true,
    });
    return toQuote(row, lines, this.clock.now());
  }

  async create(
    principal: Principal,
    input: CreateQuoteInput,
    correlationId: string | null,
  ): Promise<Quote> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    // Reads happen before the transaction (catalog and enrollment lookups use their own executor).
    const basket = await this.baskets.getBasket(organizationId, input.basketId);
    if (!basket) throw errors.protectedNotFound('basket');
    const payerPersonId = basket.payerPersonId ?? basket.ownerPersonId;
    const lines = quotableLines(basket);
    // The basket owner already reads the basket and its participants (enrollment.read_basket), so
    // a refusal is explained to them; anyone else learns nothing about it (§4.10).
    const ownsBasket = !!principal.personId && principal.personId === basket.ownerPersonId;
    const participants = [...new Set(lines.map((l) => l.participantPersonId))];
    const target = {
      type: 'basket',
      id: basket.id,
      organizationId,
      // SPK-PAY-004/SPK-IAM-003: the payer holds pay over every participant (or is the adult participant).
      subjectPersonIds: participants,
    };
    const decision = await this.authorization.decide(principal, FinanceActions.createQuote, target);
    if (!decision.allowed) {
      if (!ownsBasket) throw errors.protectedNotFound('basket');
      if (lines.length === 0) {
        throw errors.validation('The basket has no lines that can be quoted.', {
          basketStatus: basket.status,
        });
      }
      // SPK-AT-001, SPK-IAM-003, §4.10: register and pay are separate grants. An owner who may
      // register a child but not pay for them is told which participants need pay authority (the
      // permitted next action), not that their own basket does not exist.
      const lacking: string[] = [];
      for (const participant of participants) {
        const one = await this.authorization.decide(principal, FinanceActions.createQuote, {
          ...target,
          subjectPersonIds: [participant],
        });
        if (!one.allowed) lacking.push(participant);
      }
      throw new DomainError(
        'PARTICIPANT_AUTHORITY_REQUIRED',
        'Paying for this basket needs pay authority over every participant (SPK-IAM-003).',
        { details: { permission: 'pay', participantPersonIds: lacking } },
      );
    }
    if (!isStaffLike(principal) && principal.personId !== payerPersonId) {
      // A quote is the payer's; another adult with authority over a shared child learns nothing
      // (§4.10). The owner, who named the payer, is told that only the payer may request it.
      if (ownsBasket) {
        throw errors.accessDenied('Only the payer named on the basket may request its quote.');
      }
      throw errors.protectedNotFound('basket');
    }
    if (lines.length === 0) {
      throw errors.validation('The basket has no lines that can be quoted.', {
        basketStatus: basket.status,
      });
    }
    if (basket.approvalPending) {
      throw errors.resourceConflict('A line of this basket awaits human approval before payment.', {
        code: 'APPROVAL_PENDING',
      });
    }
    const resolved = await this.policy.resolve(organizationId, now);
    const plan: PlanInput =
      input.paymentPlan.kind === 'full'
        ? { kind: 'full' }
        : {
            kind: 'installments',
            count: input.paymentPlan.count,
            intervalDays: resolved.config.installments.intervalDays,
          };
    if (plan.kind === 'installments') {
      if (!resolved.config.installments.enabled) {
        throw errors.validation('Installment plans are not offered (POL-016).');
      }
      if (plan.count > resolved.config.installments.maxInstallments) {
        throw errors.validation('Too many installments for the installment policy.', {
          maxInstallments: resolved.config.installments.maxInstallments,
        });
      }
    }

    // SPK-PAY-001: the price is the catalog price rule effective now, never the client's.
    const lineInputs: QuoteLineInput[] = [];
    let currency: string | null = null;
    const evaluationLines = [];
    for (const line of lines) {
      const snapshot = await this.offerings.getOffering(organizationId, line.offeringId, now);
      if (!snapshot) throw errors.notFound('offering', line.offeringId);
      const rule = await this.pricing.effectivePriceRule(organizationId, line.offeringId, now);
      if (rule) {
        currency ??= rule.currency;
        if (rule.currency !== currency) {
          throw errors.validation('Every line of a quote must be priced in the same currency.');
        }
      }
      const policies: LinePolicyReferences = {
        eligibilityPolicyVersionId: line.policies.eligibilityPolicyVersionId,
        cancellationPolicyVersionId: line.policies.cancellationPolicyVersionId,
        requiredFormPolicyVersionIds: line.policies.requiredFormPolicyVersionIds,
        approvalPolicyVersionId: line.policies.approvalPolicyVersionId ?? null,
      };
      lineInputs.push({
        basketLineId: line.id,
        participantPersonId: line.participantPersonId,
        offeringId: line.offeringId,
        description: snapshot.offering.name,
        quantity: line.quantity,
        priceRule: rule
          ? {
              id: rule.id,
              basePriceMinor: rule.basePriceMinor,
              currency: rule.currency,
              chargeLines: rule.chargeLines,
            }
          : null,
        policies,
        equivalenceKey: line.equivalenceKey,
        enrollmentId: line.enrollmentId,
      });
      evaluationLines.push({
        lineId: line.id,
        offeringId: line.offeringId,
        offeringKind: snapshot.offering.kind,
        programId: snapshot.offering.programId ?? null,
        participantPersonId: line.participantPersonId,
        baseAmountMinor: (rule?.basePriceMinor ?? 0) * line.quantity,
      });
    }
    const quoteCurrency = currency ?? basket.currency ?? 'USD';
    const discountEvaluation =
      evaluationLines.some((l) => l.baseAmountMinor > 0) || input.discountCodes.length > 0
        ? await this.pricing.evaluateDiscounts(organizationId, {
            currency: quoteCurrency,
            at: now,
            lines: evaluationLines,
            codes: input.discountCodes,
          })
        : null;
    if (discountEvaluation && discountEvaluation.unknownCodes.length > 0) {
      throw errors.validation('Unknown or inactive discount code.', {
        unknownCodes: discountEvaluation.unknownCodes,
      });
    }

    // Credits the payer owns and may use for registration (redeemed only at checkout). Each credit
    // is applied once (SPK-PAY-002/009): a repeated id would count its balance again.
    if (new Set(input.creditIds).size !== input.creditIds.length) {
      throw errors.validation('A credit may be listed only once.', { field: 'creditIds' });
    }
    const credits = [];
    for (const creditId of input.creditIds) {
      const credit = await this.facts.loadCredit(this.db, organizationId, creditId);
      if (!credit || credit.owner_person_id !== payerPersonId)
        throw errors.protectedNotFound('credit');
      if (
        credit.status !== 'active' ||
        credit.currency !== quoteCurrency ||
        (credit.expires_at && new Date(credit.expires_at) <= now) ||
        !(credit.permitted_uses as string[]).includes('registration')
      ) {
        throw errors.validation('The credit cannot be applied to this registration.', {
          creditId,
          status: credit.status,
        });
      }
      credits.push({ creditId, remainingMinor: credit.remaining_minor });
    }

    const computed = computeQuote({
      currency: quoteCurrency,
      lines: lineInputs,
      discountEvaluation,
      credits,
      plan,
      now,
    });
    if (plan.kind === 'installments' && computed.dueNowMinor === 0) {
      throw errors.validation('Nothing remains payable for an installment plan.');
    }
    const validity = minutesFrom(now, resolved.config.quoteValidityMinutes);
    const holdExpiry = basket.holdExpiresAt ? new Date(basket.holdExpiresAt) : null;
    const expiresAt = holdExpiry && holdExpiry < validity ? holdExpiry : validity;

    return this.uow.run(async ({ trx }) => {
      const id = newId();
      await trx
        .insertInto('quotes')
        .values({
          id,
          organization_id: organizationId,
          basket_id: basket.id,
          payer_person_id: payerPersonId,
          requested_by: json(snapshotActor(principal)),
          requested_by_person_id: principal.personId,
          currency: quoteCurrency,
          subtotal_minor: computed.subtotalMinor,
          discount_minor: computed.discountMinor,
          tax_minor: computed.taxMinor,
          fee_minor: computed.feeMinor,
          included_tax_minor: computed.includedTaxMinor,
          total_minor: computed.totalMinor,
          credits_applied_minor: computed.creditsAppliedMinor,
          due_now_minor: computed.dueNowMinor,
          future_minor: computed.futureMinor,
          payment_plan: plan.kind,
          future_obligations: json(computed.futureObligations),
          applied_credits: json(computed.appliedCredits),
          discount_codes: json(input.discountCodes),
          discounts: json(computed.discounts),
          policy_references: json(resolved.references),
          basket_revision: basket.revision,
          expires_at: expiresAt,
          consumed_at: null,
          consumed_by_checkout_id: null,
          expired_at: null,
        })
        .execute();
      await trx
        .insertInto('quote_lines')
        .values(
          computed.lines.map((line) => ({
            id: newId(),
            organization_id: organizationId,
            quote_id: id,
            sequence: line.sequence,
            basket_line_id: line.basketLineId,
            participant_person_id: line.participantPersonId,
            offering_id: line.offeringId,
            description: line.description,
            quantity: line.quantity,
            price_rule_id: line.priceRule?.id ?? null,
            unit_price_minor: line.unitPriceMinor,
            base_amount_minor: line.baseAmountMinor,
            discount_minor: line.discountMinor,
            tax_minor: line.taxMinor,
            fee_minor: line.feeMinor,
            included_tax_minor: line.includedTaxMinor,
            total_minor: line.totalMinor,
            currency: quoteCurrency,
            discount_lines: json(line.discounts),
            charge_lines: json(line.charges),
            policy_references: json(line.policies),
            equivalence_key: line.equivalenceKey,
            enrollment_id: line.enrollmentId,
          })),
        )
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.createQuote.id,
        targetType: 'quote',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: {
          basketId: basket.id,
          totalMinor: computed.totalMinor,
          dueNowMinor: computed.dueNowMinor,
          currency: quoteCurrency,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, FinanceEvents.quoteCreated, {
        organizationId,
        aggregateType: 'quote',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          quoteId: id,
          basketId: basket.id,
          totalMinor: computed.totalMinor,
          currency: quoteCurrency,
        },
      });
      const row = await this.load(trx, organizationId, id);
      return this.view(trx, row as QuoteRow);
    });
  }

  /** Marks a lapsed quote expired (a fact for later reads); idempotent. */
  async expireIfLapsed(trx: Trx, row: QuoteRow): Promise<void> {
    if (row.status !== 'active' || new Date(row.expires_at) > this.clock.now()) return;
    await trx
      .updateTable('quotes')
      .set({ status: 'expired', expired_at: this.clock.now(), revision: row.revision + 1 })
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
  }
}
