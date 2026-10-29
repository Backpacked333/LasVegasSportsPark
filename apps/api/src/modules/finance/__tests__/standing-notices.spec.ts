import type { DomainEvent } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
} from '../../catalog';
import {
  addRosterMemberFixture,
  createCompetitionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { BASKET_PORT, BasketsService, createEnrollmentFixture } from '../../enrollment';
import { EntryModule, FINANCIAL_STANDING_PORT, type FinancialStandingPort } from '../../entry';
import { createPersonFixture } from '../../identity';
import { at } from '../../scheduling';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { FinanceNotices } from '../services/finance-notices.service';
import { FinancialStandingService } from '../services/financial-standing.service';
import { createObligationFixture } from '../testing/finance-fixtures';
import {
  adult,
  basketFor,
  child,
  drain,
  financeTestApp,
  offering,
  post,
  quoteFor,
  staff,
  type Actor,
} from './support';

describe('financial standing at arrival (FIN-03, IF-39; SPK-ENTRY-004)', () => {
  let t: TestApp;
  let desk: Actor;

  beforeAll(async () => {
    // Saturday 2027-01-16, 09:00 in Los Angeles (the seeded facility's zone).
    t = await financeTestApp({ imports: [EntryModule], clockStart: '2027-01-16T17:00:00Z' });
    desk = await staff(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('finance is the registered FINANCIAL_STANDING_IMPL entry reads', () => {
    const port = t.app.get<FinancialStandingPort>(FINANCIAL_STANDING_PORT);
    expect(port).toBeDefined();
    expect(t.app.get(FinancialStandingService)).toBeInstanceOf(FinancialStandingService);
  });

  it('SPK-ENTRY-004: an unrelated overdue obligation shows as an informational issue and does not block without an approved policy', async () => {
    const manager = await staff(t, ['program_manager']);
    const setup = await createOfferingFixture(t, { responsibleManagerPersonId: manager.personId });
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date(at('2027-01-16', '10:00')),
      scheduledEnd: new Date(at('2027-01-16', '11:00')),
    });
    const guardian = await createPersonFixture(t, { kind: 'adult' });
    const kid = await createPersonFixture(t, { kind: 'child' });
    await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      status: 'confirmed',
    });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: kid,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: guardian,
    });
    // A manual charge to the child, overdue since yesterday, unrelated to this activity.
    const overdue = await createObligationFixture(t, {
      debtorPersonId: kid,
      amountMinor: 12_000,
      dueAt: new Date('2027-01-15T17:00:00Z'),
    });
    const standing = await t.app
      .get(FinancialStandingService)
      .standingOf(t.organizationId, kid, { offeringId: setup.offeringId, at: t.clock.now() });
    expect(standing).toEqual({
      status: 'outstanding',
      related: false,
      amountMinor: 12_000,
      currency: 'USD',
      reference: overdue,
    });
    const res = await post(t, '/v1/session-checkins', desk.header, {
      personId: kid,
      activity: { type: 'session', offeringId: setup.offeringId, sessionId },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('admitted');
    const issues = (res.body.issues as Array<{ code: string; severity: string }>).map(
      (i) => `${i.code}:${i.severity}`,
    );
    expect(issues).toContain('outstanding_balance:info');
  });

  it('a person with nothing due is clear; an obligation not yet due is not outstanding', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const service = t.app.get(FinancialStandingService);
    expect(
      await service.standingOf(t.organizationId, person, { offeringId: null, at: t.clock.now() }),
    ).toEqual({ status: 'clear' });
    await createObligationFixture(t, {
      debtorPersonId: person,
      amountMinor: 5_000,
      dueAt: new Date(t.clock.now().getTime() + 86_400_000),
    });
    expect(
      await service.standingOf(t.organizationId, person, { offeringId: null, at: t.clock.now() }),
    ).toEqual({ status: 'clear' });
  });
});

describe('related standing, checkout operation and finance notices (FIN-03, FIN-04, FIN-05)', () => {
  let t: TestApp;
  let parent: Actor;
  const startCalls: unknown[][] = [];
  const finishCalls: unknown[][] = [];

  beforeAll(async () => {
    t = await financeTestApp({
      configure: (builder) =>
        builder.overrideProvider(BASKET_PORT).useFactory({
          inject: [BasketsService],
          factory: (real: BasketsService) =>
            new Proxy(real, {
              get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver) as unknown;
                if (typeof value !== 'function') return value;
                const fn = (value as (...a: unknown[]) => unknown).bind(target);
                if (prop === 'startCheckout') {
                  return (...args: unknown[]) => {
                    startCalls.push(args);
                    return fn(...args);
                  };
                }
                if (prop === 'finishCheckout') {
                  return (...args: unknown[]) => {
                    finishCalls.push(args);
                    return fn(...args);
                  };
                }
                return fn;
              },
            }),
        }),
    });
    parent = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('a related outstanding amount is reported as related', async () => {
    const setup = await offering(t, { basePriceMinor: 9_000 });
    const other = await offering(t, { basePriceMinor: 1_000 });
    const kid = await child(t, [parent]);
    const { basketId } = await basketFor(t, parent, [setup], { participants: [kid] });
    const quote = await quoteFor(t, parent, basketId, {
      paymentPlan: { kind: 'installments', count: 2 },
    });
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      authorizeFutureInstallments: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    const open = await t.db
      .selectFrom('obligations')
      .select(['id', 'amount_minor', 'due_at'])
      .where('order_id', '=', res.body.orderId as string)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    const service = t.app.get(FinancialStandingService);
    const later = new Date(new Date(open.due_at).getTime() + 60_000);
    // The parent owes the second installment of the child's own registration.
    expect(
      await service.standingOf(t.organizationId, kid, { offeringId: setup.offeringId, at: later }),
    ).toEqual({
      status: 'outstanding',
      related: true,
      amountMinor: Number(open.amount_minor),
      currency: 'USD',
      reference: open.id,
    });
    expect(
      await service.standingOf(t.organizationId, kid, { offeringId: other.offeringId, at: later }),
    ).toMatchObject({ status: 'outstanding', related: false, reference: open.id });
    // Not due yet at arrival today: nothing outstanding.
    expect(
      await service.standingOf(t.organizationId, kid, {
        offeringId: setup.offeringId,
        at: t.clock.now(),
      }),
    ).toEqual({ status: 'clear' });
  });

  it('SPK-UX-001: after checkout starts, GET /v1/enrollments/{id} names the checkout operation', async () => {
    startCalls.length = 0;
    finishCalls.length = 0;
    const setup = await offering(t, { basePriceMinor: 4_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId);
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.processing },
    });
    expect(res.status).toBe(201);
    const operationId = res.body.operationId as string;
    // §4.11 step 4 (ENR-06): the basket's checkout entry point receives the checkout operation,
    // which enrollment records as the pending enrollments' last operation.
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.[2]).toBe(basketId);
    expect(startCalls[0]?.[5]).toBe(operationId);
    const enrollmentId = (res.body.enrollmentIds as string[])[0] as string;
    const enrollment = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header);
    expect(enrollment.status).toBe(200);
    expect(enrollment.body.status).toBe('pending');
    const operation = await t.http.get(`/v1/operations/${operationId}`).set(parent.header);
    expect(operation.body).toMatchObject({
      id: operationId,
      kind: 'finance.registration_checkout',
    });
  });

  it('SPK-PAY-004: a contribution request queues one notice to the requested player', async () => {
    const captain = await adult(t);
    const competitionId = await createCompetitionFixture(t);
    const { seasonId } = await createSeasonFixture(t, { competitionId });
    const entry = await createTeamEntryFixture(t, { seasonId, captainPersonId: captain.personId });
    const player = await adult(t);
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: player.personId });
    const obligationId = await createObligationFixture(t, {
      debtorTeamEntryId: entry.teamEntryId,
      amountMinor: 40_000,
      description: 'Winter team fee',
    });
    const requested = await post(
      t,
      `/v1/obligations/${obligationId}/contribution-requests`,
      captain.header,
      { requestedPersonId: player.personId, amountMinor: 12_500 },
    );
    expect(requested.status).toBe(201);
    await drain(t);
    const notices = await t.db
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .where('subject_type', '=', 'contribution_request')
      .where('subject_id', '=', requested.body.id as string)
      .execute();
    expect(notices).toHaveLength(1);
    const notice = notices[0] as (typeof notices)[number];
    expect(notice).toMatchObject({ kind: 'payment_attention', protected: true });
    expect(notice.body).toContain('$125.00');
    expect(notice.body).toContain('Winter team fee');
    expect((notice.audience as { subjectPersonIds: string[] }).subjectPersonIds).toEqual([
      player.personId,
    ]);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'finance.contribution_requested')
      .where('aggregate_id', '=', requested.body.id as string)
      .executeTakeFirstOrThrow();
    expect(notice.source_event_id).toBe(event.id);
    const recipients = await t.db
      .selectFrom('notification_recipients')
      .select('person_id')
      .where('notification_id', '=', notice.id)
      .execute();
    expect(recipients.map((r) => r.person_id)).toContain(player.personId);
  });

  it('a replayed payment_failed event queues nothing new', async () => {
    const debtor = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: debtor.personId,
      amountMinor: 3_300,
    });
    const paid = await post(t, `/v1/obligations/${obligationId}/payments`, debtor.header, {
      paymentMethodToken: FakePaymentTokens.decline,
    });
    expect(paid.body.payment.status).toBe('failed');
    await drain(t);
    const row = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', 'finance.payment_failed')
      .where('aggregate_id', '=', paid.body.payment.id as string)
      .executeTakeFirstOrThrow();
    const count = async () =>
      (
        await t.db
          .selectFrom('notifications')
          .select('id')
          .where('organization_id', '=', t.organizationId)
          .where('source_event_id', '=', row.id)
          .execute()
      ).length;
    expect(await count()).toBe(1);
    const notice = await t.db
      .selectFrom('notifications')
      .selectAll()
      .where('source_event_id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(notice.title).toBe('A payment did not go through');
    expect(notice.body).toContain('$33.00');
    expect(notice.body).not.toMatch(/charged|taken/i);

    // The dispatcher delivers the event again: the handler's consumption is already recorded.
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', available_at: t.clock.now(), dispatched_at: null })
      .where('id', '=', row.id)
      .execute();
    await drain(t);
    expect(await count()).toBe(1);

    // The handler itself runs again with the same event: the notice's source key holds.
    const event: DomainEvent<{
      organizationId: string;
      paymentAttemptId: string;
      purpose: string;
      status: 'failed' | 'canceled';
      failureReason: string | null;
    }> = {
      id: row.id,
      type: row.event_type,
      organizationId: row.organization_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      occurredAt: new Date(row.occurred_at).toISOString(),
      payload: row.payload as never,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      operationId: row.operation_id,
    };
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) => t.app.get(FinanceNotices).paymentFailed(trx, event));
    expect(await count()).toBe(1);
  });
});
