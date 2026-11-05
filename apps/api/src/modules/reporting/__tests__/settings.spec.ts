import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../kernel';
import { TEST_CONFIG_ENV, type TestApp } from '../../../testing';
import { createObligationFixture } from '../../finance';
import { createPersonFixture } from '../../identity';
import { at, createScheduledEvent, EventsService, seedResource } from '../../scheduling';
import { get, HOUR, post, reportingTestApp, staff, type Actor } from './support';

const DATE = '2027-02-03';
type Row = Record<string, string | number | boolean | null>;
type SettingUse = { setting: string; configured: boolean; value: string | null };

function settingOf(body: { settings: SettingUse[] }, setting: string): SettingUse | undefined {
  return body.settings.find((s) => s.setting === setting);
}

/** An unknown delivery attempted at `attemptedAt` (written as the communications module leaves it). */
async function unknownDelivery(t: TestApp, attemptedAt: Date): Promise<void> {
  const notificationId = newId();
  const personId = await createPersonFixture(t, { kind: 'adult' });
  await t.db
    .insertInto('notifications')
    .values({
      id: notificationId,
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      kind: 'cancellation',
      category: 'operational',
      subject_type: null,
      subject_id: null,
      audience: json({}),
      title: 'Session canceled',
      body: 'Tonight is canceled.',
      details_before: null,
      details_after: null,
      protected: false,
      created_by: json({ kind: 'system' }),
      created_by_person_id: null,
      source_event_id: null,
      scheduled_for: null,
      status: 'dispatched',
      supersedes_notification_id: null,
      superseded_by_notification_id: null,
      suppression_reason: null,
      queued_at: attemptedAt,
      dispatched_at: attemptedAt,
      suppressed_at: null,
      correlation_id: null,
      operation_id: null,
    })
    .execute();
  const recipientId = newId();
  await t.db
    .insertInto('notification_recipients')
    .values({
      id: recipientId,
      organization_id: t.organizationId,
      notification_id: notificationId,
      person_id: personId,
      resolved_basis: 'self',
      basis_detail: null,
      resolved_at: attemptedAt,
      status: 'authorized',
      authorized_at: attemptedAt,
      revoked_at: null,
      revocation_reason: null,
    })
    .execute();
  await t.db
    .insertInto('delivery_attempts')
    .values({
      id: newId(),
      organization_id: t.organizationId,
      notification_id: notificationId,
      recipient_id: recipientId,
      channel: 'email',
      provider: 'fake-messaging',
      provider_message_id: null,
      status: 'unknown',
      queued_at: attemptedAt,
      ready_at: null,
      locked_until: null,
      attempted_at: attemptedAt,
      accepted_at: null,
      delivered_at: null,
      failed_at: null,
      read_at: null,
      acknowledged_at: null,
      provider_response: null,
      failure_code: null,
      error: null,
    })
    .execute();
}

describe('reporting settings without values: the conservative behaviour (REP-03, K-00 (i))', () => {
  let t: TestApp;
  let gm: Actor;
  let scheduler: Actor;
  let runId: string;

  beforeAll(async () => {
    // No reporting setting is configured: nothing is invented.
    t = await reportingTestApp({ env: {} });
    gm = await staff(t, ['general_manager']);
    scheduler = await staff(t, ['scheduler']);
    const debtor = await createPersonFixture(t, { kind: 'adult' });
    const now = t.clock.now().getTime();
    await createObligationFixture(t, {
      debtorPersonId: debtor,
      amountMinor: 5_000,
      dueAt: new Date(now - 40 * 24 * HOUR),
    });
    await createObligationFixture(t, {
      debtorPersonId: debtor,
      amountMinor: 2_500,
      dueAt: new Date(now + 10 * 24 * HOUR),
    });
    await unknownDelivery(t, t.clock.now());
    const run = await post(t, '/v1/reports/runs', scheduler, {
      report: 'utilization',
      parameters: { facilityId: t.facilityId, from: DATE, to: DATE },
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    runId = run.body.id;
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.14, DEC-060: without an export lifetime an export is refused', async () => {
    const refused = await post(t, '/v1/reports/exports', scheduler, {
      reportRunId: runId,
      format: 'csv',
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        code: 'EXPORT_LIFETIME_UNCONFIGURED',
        setting: 'REPORTING_EXPORT_LIFETIME_MINUTES',
        pendingDecision: 'DEC-060',
      },
    });
    expect(
      await t.db.selectFrom('exports').select('id').where('report_run_id', '=', runId).execute(),
    ).toHaveLength(0);
    // The independent export permission is still checked first (SPK-REPORT-007).
    const frontDesk = await staff(t, ['front_desk']);
    const run = await post(t, '/v1/reports/runs', frontDesk, {
      report: 'daily_schedule',
      parameters: { facilityId: t.facilityId, date: DATE },
    });
    expect(
      (await post(t, '/v1/reports/exports', frontDesk, { reportRunId: run.body.id, format: 'csv' }))
        .status,
    ).toBe(403);
  });

  it('DEC-007: aging without configured bands returns unbanded totals', async () => {
    const res = await get(t, '/v1/reports/outstanding-obligations', gm);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.rows as Row[];
    expect(rows).toEqual([
      expect.objectContaining({
        currency: 'USD',
        agingBand: 'unbanded',
        obligations: 2,
        remainingMinor: 7_500,
      }),
    ]);
    expect(settingOf(res.body, 'REPORTING_AGING_BANDS_DAYS')).toMatchObject({
      configured: false,
      value: null,
      pendingDecision: 'DEC-007',
    });
    expect((res.body.disclosures as string[]).join(' ')).toContain('No aging bands are configured');
  });

  it('DEC-015: without a threshold every unknown delivery counts as unresolved at once', async () => {
    const res = await get(t, '/v1/reports/communication-failures', gm, {
      periodStart: new Date(t.clock.now().getTime() - HOUR).toISOString(),
      periodEnd: new Date(t.clock.now().getTime() + HOUR).toISOString(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const met062 = (
      res.body.values as Array<{ metric: string; value: number; dimensions: object }>
    ).find((v) => v.metric === 'MET-062')!;
    expect(met062).toMatchObject({ value: 1, dimensions: { thresholdMinutes: 'unconfigured' } });
    expect(settingOf(res.body, 'REPORTING_UNKNOWN_DELIVERY_MINUTES')).toMatchObject({
      configured: false,
    });
  });

  it('DEC-001: without an operating day start a reported day is the calendar day, and says so', async () => {
    const res = await get(t, '/v1/reports/daily-schedule', gm, {
      facilityId: t.facilityId,
      date: DATE,
    });
    expect(res.status).toBe(200);
    expect(settingOf(res.body, 'REPORTING_OPERATING_DAY_START')).toMatchObject({
      configured: false,
      value: null,
      pendingDecision: 'DEC-001',
    });
    expect((res.body.disclosures as string[]).join(' ')).toContain(
      'from 00:00 to 00:00 the next day',
    );
    expect(res.body.freshness.consistency).toBe('snapshot');
  });
});

describe('reporting settings with values (REP-03)', () => {
  let t: TestApp;
  let scheduler: Actor;
  let gm: Actor;

  beforeAll(async () => {
    t = await reportingTestApp({
      env: {
        REPORTING_EXPORT_LIFETIME_MINUTES: '30',
        REPORTING_OPERATING_DAY_START: '05:00',
        REPORTING_AGING_BANDS_DAYS: '30,60',
      },
    });
    scheduler = await staff(t, ['scheduler']);
    gm = await staff(t, ['general_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.14: with an export lifetime an export expires on time', async () => {
    const run = await post(t, '/v1/reports/runs', scheduler, {
      report: 'utilization',
      parameters: { facilityId: t.facilityId, from: DATE, to: DATE },
    });
    expect(run.status).toBe(201);
    const created = await post(t, '/v1/reports/exports', scheduler, {
      reportRunId: run.body.id,
      format: 'csv',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(new Date(created.body.expiresAt).getTime() - t.clock.now().getTime()).toBe(30 * 60_000);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', created.body.id)
      .where('action', '=', 'reporting.export_created')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ lifetimeMinutes: 30 });

    // One minute before the expiry it is still ready…
    t.clock.advance(29 * 60_000);
    expect((await get(t, `/v1/reports/exports/${created.body.id}`, scheduler)).body.status).toBe(
      'ready',
    );
    // …at the expiry instant it is not.
    t.clock.advance(60_000);
    const late = await t.http
      .get(`/v1/reports/exports/${created.body.id}/download`)
      .set(scheduler.header)
      .set('X-Export-Token', created.body.downloadToken);
    expect(late.status).toBe(409);
    expect(late.body.details).toMatchObject({ machine: 'Export', from: 'expired' });
  });

  it('DEC-001: a configured operating day start moves the reported day', async () => {
    const events = t.app.get(EventsService);
    const room = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Late court',
    });
    // 02:00 on DATE belongs to the previous operating day; 02:00 the next morning to DATE.
    for (const [date, start, end] of [
      [DATE, '02:00', '03:00'],
      [DATE, '06:00', '07:00'],
      ['2027-02-04', '02:00', '03:00'],
      ['2027-02-04', '06:00', '07:00'],
    ] as const) {
      await createScheduledEvent(events, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [room.resourceId],
        start: at(date, start),
        end: at(date, end),
        kind: 'practice',
        title: `${date} ${start}`,
      });
    }
    const res = await get(t, '/v1/reports/daily-schedule', gm, {
      facilityId: t.facilityId,
      date: DATE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.rows as Row[]).map((r) => r.title).sort()).toEqual([
      '2027-02-03 06:00',
      '2027-02-04 02:00',
    ]);
    expect(settingOf(res.body, 'REPORTING_OPERATING_DAY_START')).toMatchObject({
      configured: true,
      value: '05:00',
    });
    expect((res.body.disclosures as string[]).join(' ')).toContain(
      'from 05:00 to 05:00 the next day',
    );
  });

  it('DEC-007: configured aging bands band the balances', async () => {
    const debtor = await createPersonFixture(t, { kind: 'adult' });
    await createObligationFixture(t, {
      debtorPersonId: debtor,
      amountMinor: 4_000,
      dueAt: new Date(t.clock.now().getTime() - 75 * 24 * HOUR),
    });
    const res = await get(t, '/v1/reports/outstanding-obligations', gm);
    expect(res.status).toBe(200);
    expect((res.body.rows as Row[]).map((r) => r.agingBand)).toEqual(['over_60']);
    expect(settingOf(res.body, 'REPORTING_AGING_BANDS_DAYS')).toMatchObject({
      configured: true,
      value: '30,60',
    });
  });

  it('a malformed reporting setting refuses boot (K-15)', () => {
    const boot = (env: NodeJS.ProcessEnv) => () => loadConfig({ ...TEST_CONFIG_ENV, ...env });
    expect(boot({ REPORTING_AGING_BANDS_DAYS: '60,30' })).toThrow(/REPORTING_AGING_BANDS_DAYS/);
    expect(boot({ REPORTING_AGING_BANDS_DAYS: '0,30' })).toThrow(/REPORTING_AGING_BANDS_DAYS/);
    expect(boot({ REPORTING_OPERATING_DAY_START: '25:00' })).toThrow(
      /REPORTING_OPERATING_DAY_START/,
    );
    expect(boot({ REPORTING_EXPORT_LIFETIME_MINUTES: '0' })).toThrow(
      /REPORTING_EXPORT_LIFETIME_MINUTES/,
    );
    expect(boot({ REPORTING_UNKNOWN_DELIVERY_MINUTES: 'soon' })).toThrow(
      /REPORTING_UNKNOWN_DELIVERY_MINUTES/,
    );
    // Absent values stay absent: no default is invented (K-00 (i)).
    expect(loadConfig({ ...TEST_CONFIG_ENV }).moduleSettings['reporting']).toEqual({});
    expect(
      loadConfig({ ...TEST_CONFIG_ENV, REPORTING_AGING_BANDS_DAYS: ' 30, 60 ,90' }).moduleSettings[
        'reporting'
      ],
    ).toEqual({ AGING_BANDS_DAYS: [30, 60, 90] });
  });
});
