import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@sportspark/contracts';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { createCapturedPaymentFixture, RefundsService } from '../../finance';
import { createPersonFixture } from '../../identity';
import {
  at,
  createScheduledEvent,
  EventsService,
  SchedulingModule,
  seedPitchWithHalves,
} from '../../scheduling';
import { MigrationModule } from '../migration.module';
import { createAuthorityAssignmentFixture } from '../testing/migration-fixtures';

const HOUR = 3_600_000;

/**
 * §5.6 "a synchronized copy does not become an independent writer", §4.7 invariant 11: finance
 * guards its refund command itself (RECORD_AUTHORITY_PORT, implemented by this module), so an
 * in-process caller — support's refund helper, automation's refund proposal — is refused exactly
 * like `POST /payments/{id}/refunds` while the legacy system writes refunds (authority matrix
 * row 15). The automation proposal is tested in the automation module (SPK-AUTO-005: no other
 * module imports automation).
 */
describe('record authority in-process (§5.6, §4.7 invariant 11, authority matrix row 15)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [MigrationModule],
      principalResolver: 'module',
      clockStart: '2027-01-16T20:00:00.000Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const refundRows = (paymentAttemptId: string) =>
    t.db
      .selectFrom('refund_attempts')
      .select(['status', 'amount_minor'])
      .where('payment_attempt_id', '=', paymentAttemptId)
      .execute();

  const refundable = (paymentAttemptId: string) =>
    t.db
      .selectFrom('payment_refundables')
      .select(['reserved_minor', 'refunded_minor'])
      .where('payment_attempt_id', '=', paymentAttemptId)
      .executeTakeFirstOrThrow();

  it('§4.7 invariant 11: RefundsService.request called in-process is refused while the legacy system writes refunds, and runs once SportsPark is authoritative', async () => {
    const payer = await createPersonFixture(t, { kind: 'adult' });
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: payer,
      amountMinor: 3000,
    });
    // Legacy writes refunds until the cutover instant one hour from now.
    const assignmentId = await createAuthorityAssignmentFixture(t, {
      recordCategory: 'refund',
      authoritativeSystem: 'legacy',
      effectiveTo: new Date(t.clock.now().getTime() + HOUR),
    });
    const refunds = t.app.get(RefundsService, { strict: false });
    const principal = staffPrincipal(t.organizationId, ['finance_operator']);
    let caught: unknown = null;
    try {
      await refunds.request(
        principal,
        payment.paymentAttemptId,
        { amountMinor: 1000, reason: 'Duplicate charge' },
        null,
      );
    } catch (error) {
      caught = error;
    }
    expect(DomainError.is(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'ACCESS_DENIED',
      nextAction: 'write_in_authoritative_system',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'refund', assignmentId },
    });
    expect(await refundRows(payment.paymentAttemptId)).toEqual([]);
    expect(await refundable(payment.paymentAttemptId)).toEqual({
      reserved_minor: 0,
      refunded_minor: 0,
    });
    const audited = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'finance.refund')
      .execute();
    expect(audited).toEqual([]);

    // After the cutover instant SportsPark is authoritative: the same in-process call refunds once.
    t.clock.advance(2 * HOUR);
    const refund = await refunds.request(
      principal,
      payment.paymentAttemptId,
      { amountMinor: 1000, reason: 'Duplicate charge' },
      null,
    );
    expect(refund.status).toBe('succeeded');
    expect(await refundRows(payment.paymentAttemptId)).toEqual([
      { status: 'succeeded', amount_minor: 1000 },
    ]);
  });
});

/**
 * MIG-00, IF-42 (§5.6 "shared pitches require one effective scheduling authority", authority
 * matrix row 18): scheduling's port writes (SCH-02) assert the kernel's RECORD_AUTHORITY_PORT for
 * the event's facility, which this module implements, so an in-process caller cannot reserve a
 * pitch the legacy booking tool still owns.
 */
describe('scheduling port writes in-process (MIG-00, IF-42, §5.6 row 18)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [MigrationModule, SchedulingModule],
      principalResolver: 'module',
      clockStart: '2027-01-16T20:00:00.000Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('§5.6: an in-process event reservation is refused while the legacy system owns the facility schedule, and allowed after the cutover', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 4',
    });
    const events = t.app.get(EventsService, { strict: false });
    const assignmentId = await createAuthorityAssignmentFixture(t, {
      recordCategory: 'future_schedule',
      authoritativeSystem: 'legacy',
      facilityId: t.facilityId,
      effectiveTo: new Date(t.clock.now().getTime() + HOUR),
    });
    const reserve = () =>
      createScheduledEvent(events, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        start: at('2027-01-23', '10:00'),
        end: at('2027-01-23', '11:00'),
        title: 'Rental',
      });
    await expect(reserve()).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      nextAction: 'write_in_authoritative_system',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'future_schedule', assignmentId },
    });
    const written = await t.db
      .selectFrom('events')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .execute();
    expect(written).toEqual([]);
    t.clock.advance(2 * HOUR);
    const event = await reserve();
    expect(event.status).toBe('published');
  });
});
