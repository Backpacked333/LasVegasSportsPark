import { newId, type StaffRole } from '@sportspark/contracts';
import { json, pgErrorCode } from '@sportspark/db';
import { expect } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { ReportingModule } from '../reporting.module';

/** Shared helpers for the reporting API tests (not a spec file). */

/** Monday 2027-02-01, 08:00 in Los Angeles (the test facility's zone). */
export const CLOCK_START = '2027-02-01T16:00:00.000Z';
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const key = (): string => `k-${newId()}`;

/**
 * Reporting policy settings the API tests configure explicitly (REP-03): test values only, never a
 * default of the module (an absent setting is the conservative behaviour, tested on its own).
 */
export const TEST_REPORTING_SETTINGS: NodeJS.ProcessEnv = {
  REPORTING_EXPORT_LIFETIME_MINUTES: '1440',
  REPORTING_AGING_BANDS_DAYS: '30,60,90',
  REPORTING_UNKNOWN_DELIVERY_MINUTES: '60',
};

export function reportingTestApp(
  options: {
    clockStart?: string;
    imports?: NonNullable<Parameters<typeof createTestApp>[0]>['imports'];
    providers?: NonNullable<Parameters<typeof createTestApp>[0]>['providers'];
    /** Replaces TEST_REPORTING_SETTINGS (pass `{}` for an unconfigured module). */
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<TestApp> {
  return createTestApp({
    imports: [ReportingModule, ...(options.imports ?? [])],
    providers: options.providers,
    principalResolver: 'module',
    clockStart: options.clockStart ?? CLOCK_START,
    env: options.env ?? TEST_REPORTING_SETTINGS,
  });
}

export interface Actor {
  personId: string;
  accountId: string;
  header: { Authorization: string };
}

export async function staff(
  t: TestApp,
  roles: StaffRole[],
  options: { organizationId?: string; facilityIds?: string[]; effectiveTo?: Date } = {},
): Promise<Actor> {
  const member = await createStaffMemberFixture(t, {
    roles,
    organizationId: options.organizationId,
    facilityIds: options.facilityIds,
    effectiveTo: options.effectiveTo,
  });
  return {
    personId: member.personId,
    accountId: member.accountId,
    header: await authHeaderForPerson(t, member.personId),
  };
}

export async function customer(t: TestApp): Promise<Actor> {
  const personId = await createPersonFixture(t, { kind: 'adult' });
  const account = await createAccountFixture(t, { personId });
  return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
}

export function post(t: TestApp, path: string, actor: Actor, body: object, idempotencyKey = key()) {
  return t.http.post(path).set(actor.header).set('Idempotency-Key', idempotencyKey).send(body);
}

export function get(t: TestApp, path: string, actor: Actor, query: Record<string, string> = {}) {
  return t.http.get(path).set(actor.header).query(query);
}

export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(pgErrorCode(error)).toBe(code);
    return;
  }
  throw new Error(`expected PostgreSQL error ${code}`);
}

/** The value of one metric (and optional dimension) in a report response. */
export function valueOf(
  body: {
    values: Array<{
      metric: string;
      label: string;
      value: number | null;
      currency: string | null;
      dimensions: Record<string, string>;
    }>;
  },
  metric: string,
  label?: string,
  currency?: string,
): number | null {
  const found = body.values.find(
    (v) =>
      v.metric === metric &&
      (label === undefined || v.label === label) &&
      (currency === undefined || v.currency === currency),
  );
  if (!found)
    throw new Error(`no value ${metric} ${label ?? ''} in ${JSON.stringify(body.values)}`);
  return found.value;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'reporting-tests' };

/**
 * A paid and fulfilled order, written as the finance checkout would leave it (basket, quote,
 * order and their lines). Test helper only: the reporting module itself never writes these tables.
 */
export async function createFulfilledOrder(
  t: TestApp,
  input: {
    payerPersonId: string;
    fulfilledAt: Date;
    currency?: string;
    lines: Array<{
      offeringId: string;
      participantPersonId: string;
      priceRuleId: string;
      amountMinor: number;
    }>;
  },
): Promise<{ orderId: string; quoteId: string; basketId: string; lineIds: string[] }> {
  const currency = input.currency ?? 'USD';
  const org = t.organizationId;
  const total = input.lines.reduce((sum, l) => sum + l.amountMinor, 0);
  const basketId = newId();
  const quoteId = newId();
  const orderId = newId();
  const lineIds: string[] = [];
  await t.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('baskets')
      .values({
        id: basketId,
        organization_id: org,
        owner_person_id: input.payerPersonId,
        payer_person_id: input.payerPersonId,
        created_by: json(FIXTURE_ACTOR),
        created_by_person_id: null,
        assisted_by_person_id: null,
        partial_accepted_at: null,
        hold_expires_at: null,
        currency,
        order_ref: orderId,
        last_operation_id: null,
        fulfilled_at: null,
        released_at: null,
        release_reason: null,
      })
      .execute();
    await trx
      .insertInto('quotes')
      .values({
        id: quoteId,
        organization_id: org,
        basket_id: basketId,
        payer_person_id: input.payerPersonId,
        requested_by: json(FIXTURE_ACTOR),
        requested_by_person_id: null,
        currency,
        subtotal_minor: total,
        discount_minor: 0,
        tax_minor: 0,
        fee_minor: 0,
        total_minor: total,
        due_now_minor: total,
        policy_references: json({}),
        basket_revision: 1,
        expires_at: new Date(input.fulfilledAt.getTime() + HOUR),
        consumed_at: null,
        consumed_by_checkout_id: null,
        expired_at: null,
      })
      .execute();
    await trx
      .insertInto('orders')
      .values({
        id: orderId,
        organization_id: org,
        quote_id: quoteId,
        basket_id: basketId,
        payer_person_id: input.payerPersonId,
        currency,
        total_minor: total,
        due_now_minor: total,
        payment_status: 'paid',
        fulfillment_status: 'fulfilled',
        paid_at: input.fulfilledAt,
        fulfilled_at: input.fulfilledAt,
        canceled_at: null,
        cancel_reason: null,
        policy_references: json({}),
        created_by: json(FIXTURE_ACTOR),
        created_by_person_id: null,
      })
      .execute();
    let sequence = 0;
    for (const line of input.lines) {
      sequence += 1;
      const basketLineId = newId();
      const quoteLineId = newId();
      const orderLineId = newId();
      lineIds.push(orderLineId);
      await trx
        .insertInto('basket_lines')
        .values({
          id: basketLineId,
          organization_id: org,
          basket_id: basketId,
          sequence,
          participant_person_id: line.participantPersonId,
          offering_id: line.offeringId,
          session_id: null,
          team_entry_id: null,
          intent: 'youth',
          application_id: null,
          trial_participation_id: null,
          entitlement_definition_id: null,
          equivalence_key: null,
          price_snapshot: null,
          enrollment_id: null,
          outcome_reason: null,
        })
        .execute();
      await trx
        .insertInto('quote_lines')
        .values({
          id: quoteLineId,
          organization_id: org,
          quote_id: quoteId,
          sequence,
          basket_line_id: basketLineId,
          participant_person_id: line.participantPersonId,
          offering_id: line.offeringId,
          description: 'Test line',
          quantity: 1,
          price_rule_id: line.priceRuleId,
          unit_price_minor: line.amountMinor,
          base_amount_minor: line.amountMinor,
          total_minor: line.amountMinor,
          currency,
          policy_references: json({}),
          equivalence_key: null,
          enrollment_id: null,
        })
        .execute();
      await trx
        .insertInto('order_lines')
        .values({
          id: orderLineId,
          organization_id: org,
          order_id: orderId,
          quote_line_id: quoteLineId,
          sequence,
          basket_line_id: basketLineId,
          enrollment_id: null,
          participant_person_id: line.participantPersonId,
          offering_id: line.offeringId,
          description: 'Test line',
          quantity: 1,
          price_rule_id: line.priceRuleId,
          unit_price_minor: line.amountMinor,
          base_amount_minor: line.amountMinor,
          total_minor: line.amountMinor,
          currency,
          price_basis: json({}),
          policy_references: json({}),
        })
        .execute();
    }
  });
  return { orderId, quoteId, basketId, lineIds };
}

/**
 * The provider payment of an order's completed checkout and succeeded refunds of it, written as
 * finance would leave them. Test helper only: the reporting module never writes these tables.
 */
export async function createRefundedOrderPayment(
  t: TestApp,
  input: {
    order: { orderId: string; quoteId: string; basketId: string };
    payerPersonId: string;
    paidMinor: number;
    paidAt: Date;
    refunds: Array<{ amountMinor: number; resolvedAt: Date }>;
    currency?: string;
  },
): Promise<{ paymentAttemptId: string; refundAttemptIds: string[] }> {
  const currency = input.currency ?? 'USD';
  const org = t.organizationId;
  const operationId = newId();
  const checkoutId = newId();
  const paymentAttemptId = newId();
  const refundAttemptIds: string[] = [];
  await t.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('operations')
      .values({
        id: operationId,
        organization_id: org,
        kind: 'finance.checkout',
        status: 'succeeded',
        requested_by: json(FIXTURE_ACTOR),
        correlation_id: null,
        input: null,
        result: null,
        error: null,
        completed_at: input.paidAt,
      })
      .execute();
    await trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        organization_id: org,
        quote_id: input.order.quoteId,
        order_id: input.order.orderId,
        basket_id: input.order.basketId,
        payer_person_id: input.payerPersonId,
        requested_by: json(FIXTURE_ACTOR),
        requested_by_person_id: null,
        status: 'completed',
        payment_kind: 'provider',
        payment_attempt_id: null,
        cash_tender_id: null,
        operation_id: operationId,
        failure_code: null,
        failure_details: null,
        recovery: null,
        completed_at: input.paidAt,
        aborted_at: null,
        compensated_at: null,
        recovery_required_at: null,
      })
      .execute();
    await trx
      .insertInto('payment_attempts')
      .values({
        id: paymentAttemptId,
        organization_id: org,
        purpose: 'checkout',
        checkout_id: checkoutId,
        order_id: input.order.orderId,
        obligation_id: null,
        contribution_request_id: null,
        installment_id: null,
        payer_person_id: input.payerPersonId,
        amount_minor: input.paidMinor,
        currency,
        provider: 'fake-payments',
        payment_method_ref: 'pm_fake_visa',
        provider_reference: `fp_${paymentAttemptId}`,
        status: 'succeeded',
        action_required_payload: null,
        failure_reason: null,
        processor_fee_minor: 0,
        evidence_source: 'sync_response',
        evidence_inbox_event_id: null,
        evidence_sequence: null,
        requested_by: json(FIXTURE_ACTOR),
        requested_by_person_id: null,
        submitted_at: input.paidAt,
        unknown_since: null,
        resolved_at: input.paidAt,
      })
      .execute();
    await trx
      .updateTable('checkouts')
      .set({ payment_attempt_id: paymentAttemptId })
      .where('id', '=', checkoutId)
      .execute();
    for (const refund of input.refunds) {
      const id = newId();
      refundAttemptIds.push(id);
      await trx
        .insertInto('refund_attempts')
        .values({
          id,
          organization_id: org,
          payment_attempt_id: paymentAttemptId,
          amount_minor: refund.amountMinor,
          currency,
          purpose: 'customer_refund',
          checkout_id: null,
          status: 'succeeded',
          reservation_status: 'settled',
          reason: 'Test refund',
          provider: 'fake-payments',
          provider_reference: `fr_${id}`,
          failure_reason: null,
          evidence_source: 'sync_response',
          evidence_inbox_event_id: null,
          evidence_sequence: null,
          requested_by: json(FIXTURE_ACTOR),
          requested_by_person_id: null,
          operation_id: null,
          submitted_at: refund.resolvedAt,
          unknown_since: null,
          resolved_at: refund.resolvedAt,
        })
        .execute();
    }
  });
  return { paymentAttemptId, refundAttemptIds };
}
