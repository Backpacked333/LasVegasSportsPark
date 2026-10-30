import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AddPosSaleLineInput,
  type AddPosTenderInput,
  type CreatePosReturnInput,
  type CreatePosSaleInput,
  type ListMyPosReceiptsQuery,
  type Page,
  type PolicyKind,
  type PosReceipt,
  type PosSale,
  type Principal,
  type VoidPosSaleInput,
} from '@sportspark/contracts';
import { json, type Db, type PosLineChargeRecord, type PosReturnLineRecord } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../../kernel';
import { POLICY_PORT, type PolicyPort } from '../../../catalog';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../../identity';
import { FinanceActions } from '../../finance.actions';
import { RECORD_AUTHORITY_PORT, type RecordAuthorityPort } from '../../finance.ports';
import {
  LIVE_ATTEMPT_STATES,
  afterKeysetDesc,
  decodeKeyset,
  keysetAt,
  keysetPage,
  organizationOf,
  outcomeUnknownDetails,
  type Reader,
} from '../../finance.shared';
import { PosSaleMachine } from '../../finance.state-machines';
import { FinanceCustomerScope } from '../customer-scope';
import { PaymentsService } from '../payments.service';
import { RefundsService } from '../refunds.service';
import { requirePosRead } from './pos-access';
import { TaxFeeContent, chargeFor, returnedShare } from './pos-charges';
import { PosSaleFinalizer, type PosSaleRow } from './pos-sale-finalizer.service';
import { PosSetupService } from './pos-setup.service';
import {
  PAID_SALE_STATES,
  loadSaleParts,
  returnedUnits,
  toPosReceipt,
  toPosSale,
  type PosSaleLineRow,
} from './pos-views';

/** The catalog policy kind of approved taxes and fees (CAT-02, IF-48). */
const TAX_FEE_KIND = 'tax_fee' as PolicyKind;

/**
 * Point-of-sale sales (FIN-06; §3.16 POS row, SPK-PAY-001/002/008/010/012, §4.11).
 *
 * - A sale is numbered `<register>-<YYYYMMDD>-<n>` under its session's lock; lines take the
 *   product's price and only charges of approved `tax_fee` policy versions effective now
 *   (POLICY_PORT, DEC-057), snapshotted with the version id; a key without an approved version
 *   refuses the line (CHARGE_POLICY_NOT_APPROVED). New sales and lines need the `point_of_sale`
 *   capability; tenders settling an existing open sale, voids, returns and reads never check it
 *   (the capability rule: settlements and reversals are never gated, DEC-016), so turning the
 *   switch off never strands a sale that already holds a tender.
 * - §4.9: every command on a sale compares the caller's `expectedRevision` with the locked sale
 *   (STALE_REVISION), and a tender bumps the sale's revision, so a void or return decided on a
 *   stale view of the sale is refused rather than overriding another operator's tender.
 * - Cash and external tenders (evidence required) settle at once; the sale is paid when settled
 *   tenders cover its total.
 * - A card tender (§4.11): unit of work 1 commits the payment attempt (purpose `pos_sale`) and a
 *   pending tender; the provider is called outside any transaction with the attempt id as
 *   idempotency key; unit of work 2 records the outcome through PaymentsService, whose evidence
 *   paths (webhook, reconciliation sweep) route to PosSaleFinalizer, so a late outcome settles and
 *   pays the sale exactly once. An unknown outcome keeps the sale open and refuses another card
 *   tender until it is reconciled (SPK-PAY-007).
 * - A return is approved by finance (finance.approve_pos_return), never beyond what was paid by its
 *   tender kind (database trigger `pos_returns_within_paid`, invariant 6); a card return reserves
 *   the refund within the payment's refundable funds (RefundsService, SPK-PAY-008) and executes it
 *   outside the transaction. Its journal reverses the sale's revenue, taxes and fees; the sale's
 *   own entries are never edited (SPK-PAY-010).
 */
@Injectable()
export class PosSalesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    @Inject(RECORD_AUTHORITY_PORT) private readonly recordAuthority: RecordAuthorityPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: CapabilityService,
    private readonly audit: AuditWriter,
    private readonly setup: PosSetupService,
    private readonly finalizer: PosSaleFinalizer,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly scope: FinanceCustomerScope,
  ) {}

  async view(db: Reader, sale: PosSaleRow): Promise<PosSale> {
    return toPosSale(sale, await loadSaleParts(db, sale));
  }

  private async load(db: Reader, organizationId: string, id: string) {
    return db
      .selectFrom('pos_sales')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private async afterCommand(organizationId: string, id: string): Promise<PosSale> {
    const sale = await this.load(this.db, organizationId, id);
    if (!sale) throw errors.notFound('pos sale', id);
    return this.view(this.db, sale);
  }

  private requireOperator(principal: Principal, sale: PosSaleRow) {
    return this.authorization.require(principal, FinanceActions.operateRegister, {
      type: 'pos_sale',
      id: sale.id,
      organizationId: sale.organization_id,
      facilityId: sale.facility_id,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Sales and lines
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    input: CreatePosSaleInput,
    correlationId: string | null,
  ): Promise<PosSale> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) throw errors.accessDenied('A sale is made by a named person.');
    const seller = principal.personId;
    const id = await this.uow.run(async ({ trx }) => {
      const session = await this.setup.lockSession(trx, organizationId, input.registerSessionId);
      await this.authorization.require(principal, FinanceActions.operateRegister, {
        type: 'pos_register_session',
        id: session.id,
        organizationId,
        facilityId: session.facility_id,
      });
      await this.capabilities.require(organizationId, 'point_of_sale', trx);
      if (session.status !== 'open') {
        throw errors.invalidTransition('PosRegisterSession', session.status, 'sell');
      }
      if (input.customerPersonId) {
        const person = await this.persons.findPerson(organizationId, input.customerPersonId, trx);
        if (!person) throw errors.notFound('person', input.customerPersonId);
      }
      const register = await trx
        .selectFrom('pos_registers')
        .select(['code', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', session.register_id)
        .executeTakeFirstOrThrow();
      const number = session.next_sale_number;
      await trx
        .updateTable('pos_register_sessions')
        .set({ next_sale_number: number + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', session.id)
        .execute();
      const saleId = newId();
      await trx
        .insertInto('pos_sales')
        .values({
          id: saleId,
          organization_id: organizationId,
          register_session_id: session.id,
          facility_id: session.facility_id,
          currency: session.currency,
          sale_number: `${register.code}-${session.business_date}-${number}`,
          customer_person_id: input.customerPersonId ?? null,
          paid_at: null,
          void_reason: null,
          voided_at: null,
          voided_by: null,
          created_by: json(snapshotActor(principal)),
          created_by_person_id: seller,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.operateRegister.id}.sale`,
        targetType: 'pos_sale',
        targetId: saleId,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          registerSessionId: session.id,
          customerPersonId: input.customerPersonId ?? null,
        },
      });
      const sale = await this.finalizer.lockSale(trx, organizationId, saleId);
      await this.finalizer.announce(trx, sale, correlationId);
      return saleId;
    });
    return this.afterCommand(organizationId, id);
  }

  /** SPK-PAY-001/002: the product's price and the approved charges in effect; never the client's. */
  async addLine(
    principal: Principal,
    saleId: string,
    input: AddPosSaleLineInput,
    correlationId: string | null,
  ): Promise<PosSale> {
    const organizationId = organizationOf(principal);
    await this.uow.run(async ({ trx }) => {
      const sale = await this.finalizer.lockSale(trx, organizationId, saleId);
      await this.requireOperator(principal, sale);
      await this.capabilities.require(organizationId, 'point_of_sale', trx);
      if (sale.status !== 'open')
        throw errors.invalidTransition('PosSale', sale.status, 'add_line');
      assertExpectedRevision(input.expectedRevision, sale.revision);
      const product = await trx
        .selectFrom('pos_products')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.productId)
        .executeTakeFirst();
      if (!product) throw errors.notFound('pos product', input.productId);
      if (product.status !== 'active') {
        throw errors.resourceConflict('The product is retired.', { code: 'PRODUCT_RETIRED' });
      }
      if (product.facility_id && product.facility_id !== sale.facility_id) {
        throw errors.validation('The product is not sold at this facility.', {
          code: 'PRODUCT_NOT_AT_FACILITY',
        });
      }
      if (product.currency !== sale.currency) {
        throw errors.validation('The product is priced in another currency than the sale.', {
          code: 'CURRENCY_MISMATCH',
          productCurrency: product.currency,
          saleCurrency: sale.currency,
        });
      }
      const keys = await trx
        .selectFrom('pos_product_charges')
        .select('tax_fee_policy_key')
        .where('organization_id', '=', organizationId)
        .where('product_id', '=', product.id)
        .orderBy('position')
        .execute();
      const base = Number(product.price_minor) * input.quantity;
      const now = this.clock.now();
      const charges: PosLineChargeRecord[] = [];
      for (const { tax_fee_policy_key: key } of keys) {
        const version = await this.policies.currentPolicyVersion(
          organizationId,
          TAX_FEE_KIND,
          key,
          now,
          trx,
        );
        if (!version || version.approvalStatus !== 'approved') {
          // DEC-057: only Finance-approved taxes and fees appear on a sale; none is assumed.
          throw errors.resourceConflict(
            `No approved tax or fee policy "${key}" is in effect; the product cannot be sold.`,
            { code: 'CHARGE_POLICY_NOT_APPROVED', policyKey: key, productId: product.id },
          );
        }
        const content = TaxFeeContent.safeParse(version.content);
        if (!content.success) {
          throw errors.resourceConflict(
            `The approved tax or fee policy "${key}" has no usable rate or amount.`,
            { code: 'CHARGE_POLICY_INVALID', policyKey: key, policyVersionId: version.id },
          );
        }
        if (content.data.currency !== undefined && content.data.currency !== sale.currency) {
          throw errors.resourceConflict(
            `The approved fixed charge "${key}" is in another currency than the sale.`,
            { code: 'CHARGE_POLICY_CURRENCY_MISMATCH', policyKey: key },
          );
        }
        charges.push(chargeFor(content.data, version.id, base, input.quantity));
      }
      const chargesMinor = charges.reduce((sum, c) => sum + c.amountMinor, 0);
      const last = await trx
        .selectFrom('pos_sale_lines')
        .select((eb) => eb.fn.max('line_number').as('n'))
        .where('organization_id', '=', organizationId)
        .where('sale_id', '=', sale.id)
        .executeTakeFirst();
      const lineId = newId();
      await trx
        .insertInto('pos_sale_lines')
        .values({
          id: lineId,
          organization_id: organizationId,
          sale_id: sale.id,
          currency: sale.currency,
          line_number: Number(last?.n ?? 0) + 1,
          product_id: product.id,
          sku: product.sku,
          name: product.name,
          kind: product.kind,
          unit_price_minor: Number(product.price_minor),
          quantity: input.quantity,
          base_minor: base,
          charges: json(charges),
          charges_minor: chargesMinor,
          line_total_minor: base + chargesMinor,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.operateRegister.id}.add_line`,
        targetType: 'pos_sale',
        targetId: sale.id,
        beforeRevision: sale.revision,
        correlationId,
        details: {
          lineId,
          productId: product.id,
          quantity: input.quantity,
          baseMinor: base,
          charges: charges.map((c) => ({
            policyVersionId: c.policyVersionId,
            code: c.code,
            amountMinor: c.amountMinor,
          })),
        },
      });
    });
    return this.afterCommand(organizationId, saleId);
  }

  // -------------------------------------------------------------------------------------------
  // Tenders
  // -------------------------------------------------------------------------------------------

  private async remaining(trx: Trx, sale: PosSaleRow): Promise<number> {
    const live = await trx
      .selectFrom('pos_tenders')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_minor'), eb.lit(0)).as('total'))
      .where('organization_id', '=', sale.organization_id)
      .where('sale_id', '=', sale.id)
      .where('status', 'in', ['pending', 'settled'])
      .executeTakeFirst();
    return Number(sale.total_minor) - Number(live?.total ?? 0);
  }

  async addTender(
    principal: Principal,
    saleId: string,
    input: AddPosTenderInput,
    correlationId: string | null,
  ): Promise<PosSale> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) throw errors.accessDenied('A tender is taken by a named person.');
    const recordedBy = principal.personId;
    const attemptId = await this.uow.run(async ({ trx }) => {
      if (input.kind === 'card') {
        // Lock order everywhere: payment attempt, then sale (the evidence path locks the attempt
        // first). SPK-PAY-007: no second card charge while one is live or unknown.
        const live = await trx
          .selectFrom('payment_attempts')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('pos_sale_id', '=', saleId)
          .where('status', 'in', [...LIVE_ATTEMPT_STATES])
          .forUpdate()
          .executeTakeFirst();
        if (live) throw errors.paymentOutcomeUnknown(outcomeUnknownDetails(principal, live));
      }
      const sale = await this.finalizer.lockSale(trx, organizationId, saleId);
      await this.requireOperator(principal, sale);
      // CAPABILITIES-01, DEC-016: a tender settles a sale that already exists, so it is never
      // gated; a sale whose card tender covered part of it can be completed (then returned) after
      // the switch is turned off, and its session and register can then be closed.
      if (sale.status !== 'open') throw errors.invalidTransition('PosSale', sale.status, 'tender');
      assertExpectedRevision(input.expectedRevision, sale.revision);
      const remaining = await this.remaining(trx, sale);
      if (input.amountMinor > remaining) {
        throw errors.validation('The tender exceeds what remains to be paid.', {
          code: 'TENDER_EXCEEDS_REMAINING',
          remainingMinor: remaining,
        });
      }
      const now = this.clock.now();
      const tenderId = newId();
      let attempt: { id: string } | null = null;
      if (input.kind === 'card') {
        if (!sale.customer_person_id) {
          // The payer of a card payment is a person (DEC-019: an anonymous card sale depends on
          // the processor); the customer is named when the sale starts.
          throw errors.validation('A card tender needs the sale to name its customer.', {
            code: 'CARD_TENDER_NEEDS_CUSTOMER',
          });
        }
        attempt = await this.payments.createAttemptInTrx(trx, {
          organizationId,
          purpose: 'pos_sale',
          posSaleId: sale.id,
          payerPersonId: sale.customer_person_id,
          amountMinor: input.amountMinor,
          currency: sale.currency,
          paymentMethodRef: input.paymentMethodToken,
          actor: principal,
        });
      }
      await trx
        .insertInto('pos_tenders')
        .values({
          id: tenderId,
          organization_id: organizationId,
          sale_id: sale.id,
          currency: sale.currency,
          kind: input.kind,
          amount_minor: input.amountMinor,
          payment_attempt_id: attempt?.id ?? null,
          evidence: input.kind === 'external' ? json(input.evidence) : null,
          status: input.kind === 'card' ? 'pending' : 'settled',
          failure_reason: null,
          recorded_by: json(snapshotActor(principal)),
          recorded_by_person_id: recordedBy,
          recorded_at: now,
          settled_at: input.kind === 'card' ? null : now,
          failed_at: null,
        })
        .execute();
      // §4.9: the sale changed (its tenders and what remains), so its revision moves on and a
      // command decided on the earlier view is refused as stale.
      await trx
        .updateTable('pos_sales')
        .set({ revision: sale.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', sale.id)
        .where('revision', '=', sale.revision)
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.operateRegister.id}.tender`,
        targetType: 'pos_tender',
        targetId: tenderId,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          saleId: sale.id,
          kind: input.kind,
          amountMinor: input.amountMinor,
          paymentAttemptId: attempt?.id ?? null,
        },
      });
      if (input.kind !== 'card') {
        await this.finalizer.payIfCovered(trx, organizationId, sale.id, principal, correlationId);
      }
      return attempt?.id ?? null;
    });
    // §4.11 step 5: the provider is called outside any transaction; its answer is recorded in a
    // new one (unknown keeps the tender pending and the sale open).
    if (attemptId) await this.payments.execute(organizationId, attemptId, correlationId);
    return this.afterCommand(organizationId, saleId);
  }

  // -------------------------------------------------------------------------------------------
  // Voids and returns (never gated by the capability)
  // -------------------------------------------------------------------------------------------

  async void(
    principal: Principal,
    saleId: string,
    input: VoidPosSaleInput,
    correlationId: string | null,
  ): Promise<PosSale> {
    const organizationId = organizationOf(principal);
    await this.uow.run(async ({ trx }) => {
      const sale = await this.finalizer.lockSale(trx, organizationId, saleId);
      await this.requireOperator(principal, sale);
      const status = PosSaleMachine.next(sale.status, 'void');
      assertExpectedRevision(input.expectedRevision, sale.revision);
      const card = await trx
        .selectFrom('pos_tenders')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('sale_id', '=', sale.id)
        .where('kind', '=', 'card')
        .where('status', 'in', ['pending', 'settled'])
        .executeTakeFirst();
      if (card) {
        throw errors.resourceConflict(
          'A card was charged or is being charged for this sale; complete it and return instead.',
          { code: 'SALE_HAS_CARD_TENDER' },
        );
      }
      await trx
        .updateTable('pos_sales')
        .set({
          status,
          void_reason: input.reason,
          voided_at: this.clock.now(),
          voided_by: json(snapshotActor(principal)),
          revision: sale.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', sale.id)
        .where('revision', '=', sale.revision)
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.operateRegister.id}.void`,
        targetType: 'pos_sale',
        targetId: sale.id,
        beforeRevision: sale.revision,
        afterRevision: sale.revision + 1,
        reason: input.reason,
        correlationId,
      });
      await this.finalizer.announce(trx, { ...sale, status }, correlationId);
    });
    return this.afterCommand(organizationId, saleId);
  }

  async createReturn(
    principal: Principal,
    saleId: string,
    input: CreatePosReturnInput,
    correlationId: string | null,
  ): Promise<PosSale> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) throw errors.accessDenied('A return is approved by a named person.');
    const approver = principal.personId;
    const refundId = await this.uow.run(async ({ trx }) => {
      const sale = await this.finalizer.lockSale(trx, organizationId, saleId);
      await this.authorization.require(principal, FinanceActions.approvePosReturn, {
        type: 'pos_sale',
        id: sale.id,
        organizationId,
        facilityId: sale.facility_id,
      });
      if (sale.status !== 'paid' && sale.status !== 'partially_returned') {
        throw errors.invalidTransition('PosSale', sale.status, 'return_part');
      }
      assertExpectedRevision(input.expectedRevision, sale.revision);
      const lines = await trx
        .selectFrom('pos_sale_lines')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('sale_id', '=', sale.id)
        .execute();
      const byId = new Map<string, PosSaleLineRow>(lines.map((l) => [l.id, l]));
      const earlier = await trx
        .selectFrom('pos_returns')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('sale_id', '=', sale.id)
        .execute();
      const units = returnedUnits(earlier);
      // MONEY-10: units this return already names for a line count as taken, so naming a line
      // twice never returns more than was sold (the database trigger refuses it as well).
      const named = new Map<string, number>();
      const returned: PosReturnLineRecord[] = [];
      for (const requested of input.lines) {
        const line = byId.get(requested.saleLineId);
        if (!line)
          throw errors.validation('A returned line is not on this sale.', {
            code: 'LINE_NOT_ON_SALE',
            saleLineId: requested.saleLineId,
          });
        const already = (units.get(line.id) ?? 0) + (named.get(line.id) ?? 0);
        named.set(line.id, (named.get(line.id) ?? 0) + requested.quantity);
        if (already + requested.quantity > line.quantity) {
          throw errors.validation('More units are returned than were sold.', {
            code: 'RETURN_EXCEEDS_QUANTITY',
            saleLineId: line.id,
            returnableQuantity: line.quantity - already,
          });
        }
        const share = returnedShare(
          {
            quantity: line.quantity,
            baseMinor: Number(line.base_minor),
            charges: line.charges as PosLineChargeRecord[],
            currency: sale.currency,
          },
          already,
          requested.quantity,
        );
        returned.push({
          saleLineId: line.id,
          quantity: requested.quantity,
          baseMinor: share.baseMinor,
          charges: share.charges,
          amountMinor: share.baseMinor + share.charges.reduce((sum, c) => sum + c.amountMinor, 0),
        });
      }
      const amount = returned.reduce((sum, l) => sum + l.amountMinor, 0);
      if (amount <= 0) {
        throw errors.validation('Nothing was paid for the returned units.', {
          code: 'NOTHING_TO_RETURN',
        });
      }
      const paidThatWay = await trx
        .selectFrom('pos_tenders')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_minor'), eb.lit(0)).as('total'))
        .where('organization_id', '=', organizationId)
        .where('sale_id', '=', sale.id)
        .where('kind', '=', input.tenderKind)
        .where('status', '=', 'settled')
        .executeTakeFirst();
      const returnedThatWay = earlier
        .filter((r) => r.tender_kind === input.tenderKind)
        .reduce((sum, r) => sum + Number(r.amount_minor), 0);
      if (returnedThatWay + amount > Number(paidThatWay?.total ?? 0)) {
        throw errors.resourceConflict(
          `The return exceeds what was paid by ${input.tenderKind} on this sale.`,
          {
            code: 'RETURN_EXCEEDS_TENDER',
            tenderKind: input.tenderKind,
            availableMinor: Number(paidThatWay?.total ?? 0) - returnedThatWay,
          },
        );
      }
      const returnId = newId();
      let drawer: string | null = null;
      let refund: { id: string } | null = null;
      if (input.tenderKind === 'cash') {
        drawer = input.registerSessionId ?? sale.register_session_id;
        const session = await this.setup.lockSession(trx, organizationId, drawer);
        if (
          session.status !== 'open' ||
          session.facility_id !== sale.facility_id ||
          session.currency !== sale.currency
        ) {
          throw errors.resourceConflict(
            "A cash return is paid from an open register session at the sale's facility.",
            { code: 'CASH_RETURN_NEEDS_OPEN_SESSION', registerSessionId: drawer },
          );
        }
      }
      if (input.tenderKind === 'card') {
        // §5.6, §4.7 invariant 11: refunds are refused while the legacy system writes them.
        await this.recordAuthority.assertNoLegacyAuthorityInEffect(organizationId, 'refund', trx);
        const candidates = await trx
          .selectFrom('pos_tenders')
          .innerJoin('payment_refundables', (join) =>
            join
              .onRef(
                'payment_refundables.payment_attempt_id',
                '=',
                'pos_tenders.payment_attempt_id',
              )
              .onRef('payment_refundables.organization_id', '=', 'pos_tenders.organization_id'),
          )
          .select([
            'pos_tenders.payment_attempt_id as payment_attempt_id',
            'payment_refundables.captured_minor as captured',
            'payment_refundables.refunded_minor as refunded',
            'payment_refundables.reserved_minor as reserved',
          ])
          .where('pos_tenders.organization_id', '=', organizationId)
          .where('pos_tenders.sale_id', '=', sale.id)
          .where('pos_tenders.kind', '=', 'card')
          .where('pos_tenders.status', '=', 'settled')
          .orderBy('pos_tenders.recorded_at', 'desc')
          .execute();
        const chosen =
          candidates.find(
            (c) => Number(c.captured) - Number(c.refunded) - Number(c.reserved) >= amount,
          ) ?? candidates[0];
        if (!chosen?.payment_attempt_id) {
          throw errors.resourceConflict('No captured card payment of this sale can be refunded.', {
            code: 'REFUND_EXCEEDS_REFUNDABLE',
          });
        }
        refund = await this.refunds.reserveInTrx(trx, {
          organizationId,
          paymentAttemptId: chosen.payment_attempt_id,
          amountMinor: amount,
          reason: input.reason,
          purpose: 'customer_refund',
          actor: principal,
          correlationId,
        });
      }
      const now = this.clock.now();
      await trx
        .insertInto('pos_returns')
        .values({
          id: returnId,
          organization_id: organizationId,
          sale_id: sale.id,
          currency: sale.currency,
          lines: json(returned),
          amount_minor: amount,
          tender_kind: input.tenderKind,
          refund_attempt_id: refund?.id ?? null,
          register_session_id: drawer,
          evidence: input.evidence ? json(input.evidence) : null,
          reason: input.reason,
          approved_by: json(snapshotActor(principal)),
          approved_by_person_id: approver,
          returned_at: now,
        })
        .execute();
      await this.finalizer.postReturn(
        trx,
        sale,
        returnId,
        returned,
        new Map(lines.map((l) => [l.id, l.kind])),
        input.tenderKind,
        principal,
        correlationId,
      );
      for (const line of returned)
        units.set(line.saleLineId, (units.get(line.saleLineId) ?? 0) + line.quantity);
      const all = lines.every((l) => (units.get(l.id) ?? 0) >= l.quantity);
      const status = PosSaleMachine.next(sale.status, all ? 'return_all' : 'return_part');
      await trx
        .updateTable('pos_sales')
        .set({ status, revision: sale.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', sale.id)
        .where('revision', '=', sale.revision)
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.approvePosReturn.id,
        targetType: 'pos_sale',
        targetId: sale.id,
        beforeRevision: sale.revision,
        afterRevision: sale.revision + 1,
        reason: input.reason,
        correlationId,
        details: {
          returnId,
          amountMinor: amount,
          tenderKind: input.tenderKind,
          refundAttemptId: refund?.id ?? null,
          lines: returned.map((l) => ({ saleLineId: l.saleLineId, quantity: l.quantity })),
        },
      });
      await this.finalizer.announce(trx, { ...sale, status }, correlationId);
      return refund?.id ?? null;
    });
    // SPK-PAY-008: the reserved card refund is executed outside the transaction (the worker
    // executes it if this process stops).
    if (refundId) await this.refunds.execute(organizationId, refundId, correlationId);
    return this.afterCommand(organizationId, saleId);
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<PosSale> {
    const organizationId = organizationOf(principal);
    if (principal.kind !== 'staff' && principal.kind !== 'system') throw errors.accessDenied();
    const sale = await this.load(this.db, organizationId, id);
    if (!sale) throw errors.notFound('pos sale', id);
    await requirePosRead(this.authorization, principal, FinanceActions.readPos, {
      type: 'pos_sale',
      id,
      organizationId,
      facilityId: sale.facility_id,
    });
    return this.view(this.db, sale);
  }

  /** Facility staff, or the customer the sale names; anyone else learns nothing (§4.10). */
  async receipt(principal: Principal, id: string): Promise<PosReceipt> {
    const organizationId = organizationOf(principal);
    const sale = await this.load(this.db, organizationId, id);
    if (!sale) throw errors.protectedNotFound('pos receipt');
    await requirePosRead(this.authorization, principal, FinanceActions.readPosReceipt, {
      type: 'pos_sale',
      id,
      organizationId,
      facilityId: sale.facility_id,
      subjectPersonIds: sale.customer_person_id ? [sale.customer_person_id] : [],
      protected: true,
    });
    if (!(PAID_SALE_STATES as readonly string[]).includes(sale.status)) {
      throw errors.resourceConflict('The sale is not paid; it has no receipt.', {
        code: 'RECEIPT_NOT_AVAILABLE',
        status: sale.status,
      });
    }
    return toPosReceipt(sale, await loadSaleParts(this.db, sale));
  }

  async myReceipts(principal: Principal, query: ListMyPosReceiptsQuery): Promise<Page<PosReceipt>> {
    const organizationId = organizationOf(principal);
    const self = await this.scope.selfIds(principal);
    if (self.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('pos_sales')
      .selectAll()
      .select(keysetAt('pos_sales').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('customer_person_id', 'in', self)
      .where('status', 'in', [...PAID_SALE_STATES])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (cursor) q = q.where(afterKeysetDesc('pos_sales', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: PosReceipt[] = [];
    for (const row of page.rows) items.push(toPosReceipt(row, await loadSaleParts(this.db, row)));
    return { items, nextCursor: page.nextCursor };
  }
}
