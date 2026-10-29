import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type Checkout,
  type ContributionRequest,
  type ListMyCheckoutsQuery,
  type ListMyContributionRequestsQuery,
  type ListMyOrdersQuery,
  type ListMyPaymentsQuery,
  type ListMyReceiptsQuery,
  type ListOrdersQuery,
  type ListPaymentsQuery,
  type ListRefundsQuery,
  type Order,
  type Page,
  type PaymentAttempt,
  type Principal,
  type Receipt,
  type Refund,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuthorizationService, DATABASE } from '../../../kernel';
import { FinanceActions } from '../finance.actions';
import {
  afterKeysetDesc,
  decodeKeyset,
  keysetAt,
  keysetPage,
  organizationOf,
  toReceipt,
} from '../finance.shared';
import { CheckoutService } from './checkout.service';
import { FinanceCustomerScope } from './customer-scope';
import { ObligationsService } from './obligations.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

/**
 * Money read models (FIN-01, FIN-02; SPK-PAY-004, SPK-PAY-005, SPK-PAY-007, SPK-PAY-008, §4.5).
 *
 * Customer lists (`/v1/me/...`): keyset pages, newest first (created_at desc, id desc), over the
 * people the caller pays for (`finance.read_checkout`: themselves as an adult and everyone they
 * hold `pay` over) or, for contribution requests, the people they may pay a contribution for
 * (`finance.pay_contribution`), each expanded with the people merged into them. A checkout is
 * also listed for whoever started it. Nothing here reveals another household's records: the
 * scope is computed from the caller's own authority, never from a request parameter.
 *
 * Staff lists (`/v1/orders`, `/v1/payments`, `/v1/refunds`): finance readers only; a customer
 * gets ACCESS_DENIED (their own lists are the `/v1/me` ones).
 */
@Injectable()
export class MoneyReadsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly authorization: AuthorizationService,
    private readonly scope: FinanceCustomerScope,
    private readonly checkouts: CheckoutService,
    private readonly obligations: ObligationsService,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Customer lists (FIN-01)
  // -------------------------------------------------------------------------------------------

  async myOrders(principal: Principal, query: ListMyOrdersQuery): Promise<Page<Order>> {
    const organizationId = organizationOf(principal);
    const payers = await this.scope.subjectIds(principal, FinanceActions.readCheckout);
    if (payers.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('orders')
      .selectAll()
      .select(keysetAt('orders').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('payer_person_id', 'in', payers)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.paymentStatus) q = q.where('payment_status', '=', query.paymentStatus);
    if (query.fulfillmentStatus) q = q.where('fulfillment_status', '=', query.fulfillmentStatus);
    if (cursor) q = q.where(afterKeysetDesc('orders', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: Order[] = [];
    for (const row of page.rows) items.push(await this.checkouts.orderView(this.db, row));
    return { items, nextCursor: page.nextCursor };
  }

  /** SPK-PAY-007, §4.11: a checkout in `recovery_required` is found again from the server. */
  async myCheckouts(principal: Principal, query: ListMyCheckoutsQuery): Promise<Page<Checkout>> {
    const organizationId = organizationOf(principal);
    const payers = await this.scope.subjectIds(principal, FinanceActions.readCheckout);
    const self = await this.scope.selfIds(principal);
    if (payers.length === 0 && self.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('checkouts')
      .selectAll()
      .select(keysetAt('checkouts').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where((eb) =>
        eb.or([
          ...(payers.length > 0 ? [eb('payer_person_id', 'in', payers)] : []),
          ...(self.length > 0 ? [eb('requested_by_person_id', 'in', self)] : []),
        ]),
      )
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(afterKeysetDesc('checkouts', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: Checkout[] = [];
    for (const row of page.rows) items.push(await this.checkouts.view(this.db, row));
    return { items, nextCursor: page.nextCursor };
  }

  async myPayments(
    principal: Principal,
    query: ListMyPaymentsQuery,
  ): Promise<Page<PaymentAttempt>> {
    const organizationId = organizationOf(principal);
    const payers = await this.scope.subjectIds(principal, FinanceActions.readCheckout);
    if (payers.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('payment_attempts')
      .selectAll()
      .select(keysetAt('payment_attempts').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('payer_person_id', 'in', payers)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.purpose) q = q.where('purpose', '=', query.purpose);
    if (cursor) q = q.where(afterKeysetDesc('payment_attempts', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map((row) => this.payments.view(row)), nextCursor: page.nextCursor };
  }

  async myReceipts(principal: Principal, query: ListMyReceiptsQuery): Promise<Page<Receipt>> {
    const organizationId = organizationOf(principal);
    const payers = await this.scope.subjectIds(principal, FinanceActions.readCheckout);
    if (payers.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('receipts')
      .selectAll()
      .select(keysetAt('receipts').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('payer_person_id', 'in', payers)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (cursor) q = q.where(afterKeysetDesc('receipts', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map(toReceipt), nextCursor: page.nextCursor };
  }

  /** SPK-PAY-004: a player finds the contributions asked of them (or of someone they pay for). */
  async myContributionRequests(
    principal: Principal,
    query: ListMyContributionRequestsQuery,
  ): Promise<Page<ContributionRequest>> {
    const organizationId = organizationOf(principal);
    const requested = await this.scope.subjectIds(principal, FinanceActions.payContribution);
    if (requested.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('contribution_requests')
      .select(['id'])
      .select(keysetAt('contribution_requests').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('requested_person_id', 'in', requested)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(afterKeysetDesc('contribution_requests', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: ContributionRequest[] = [];
    for (const row of page.rows) {
      items.push(await this.obligations.contributionView(this.db, organizationId, row.id));
    }
    return { items, nextCursor: page.nextCursor };
  }

  // -------------------------------------------------------------------------------------------
  // Staff lists (FIN-02; SCR-S-36/37)
  // -------------------------------------------------------------------------------------------

  private async requireStaffReader(principal: Principal, type: string): Promise<string> {
    const organizationId = organizationOf(principal);
    if (principal.kind !== 'staff' && principal.kind !== 'system') {
      throw errors.accessDenied('Finance lists are read by finance staff; use your own lists.', {
        action: FinanceActions.readCheckout.id,
      });
    }
    await this.authorization.require(principal, FinanceActions.readCheckout, {
      type,
      organizationId,
    });
    return organizationId;
  }

  async listOrders(principal: Principal, query: ListOrdersQuery): Promise<Page<Order>> {
    const organizationId = await this.requireStaffReader(principal, 'order');
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('orders')
      .selectAll()
      .select(keysetAt('orders').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.payerPersonId) q = q.where('payer_person_id', '=', query.payerPersonId);
    if (query.paymentStatus) q = q.where('payment_status', '=', query.paymentStatus);
    if (query.fulfillmentStatus) q = q.where('fulfillment_status', '=', query.fulfillmentStatus);
    if (query.from) q = q.where('created_at', '>=', new Date(query.from));
    if (query.to) q = q.where('created_at', '<', new Date(query.to));
    if (cursor) q = q.where(afterKeysetDesc('orders', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: Order[] = [];
    for (const row of page.rows) items.push(await this.checkouts.orderView(this.db, row));
    return { items, nextCursor: page.nextCursor };
  }

  async listPayments(
    principal: Principal,
    query: ListPaymentsQuery,
  ): Promise<Page<PaymentAttempt>> {
    const organizationId = await this.requireStaffReader(principal, 'payment_attempt');
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('payment_attempts')
      .selectAll()
      .select(keysetAt('payment_attempts').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.purpose) q = q.where('purpose', '=', query.purpose);
    if (query.payerPersonId) q = q.where('payer_person_id', '=', query.payerPersonId);
    if (query.orderId) q = q.where('order_id', '=', query.orderId);
    if (query.obligationId) q = q.where('obligation_id', '=', query.obligationId);
    if (cursor) q = q.where(afterKeysetDesc('payment_attempts', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map((row) => this.payments.view(row)), nextCursor: page.nextCursor };
  }

  async listRefunds(principal: Principal, query: ListRefundsQuery): Promise<Page<Refund>> {
    const organizationId = await this.requireStaffReader(principal, 'refund_attempt');
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('refund_attempts')
      .selectAll()
      .select(keysetAt('refund_attempts').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.paymentAttemptId) q = q.where('payment_attempt_id', '=', query.paymentAttemptId);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(afterKeysetDesc('refund_attempts', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: Refund[] = [];
    for (const row of page.rows) items.push(await this.refunds.view(this.db, row));
    return { items, nextCursor: page.nextCursor };
  }
}
