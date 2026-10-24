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

export function reportingTestApp(
  options: {
    clockStart?: string;
    imports?: NonNullable<Parameters<typeof createTestApp>[0]>['imports'];
  } = {},
): Promise<TestApp> {
  return createTestApp({
    imports: [ReportingModule, ...(options.imports ?? [])],
    principalResolver: 'module',
    clockStart: options.clockStart ?? CLOCK_START,
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
): Promise<{ orderId: string; lineIds: string[] }> {
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
  return { orderId, lineIds };
}
