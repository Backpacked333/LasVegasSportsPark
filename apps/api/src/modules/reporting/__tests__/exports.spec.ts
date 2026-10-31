import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import { idempotencyStoreContains, type TestApp } from '../../../testing';
import { get, HOUR, post, reportingTestApp, staff, type Actor } from './support';

const DATE = '2027-02-03';

async function dispatchAll(t: TestApp): Promise<void> {
  const dispatcher = t.app.get(OutboxDispatcher);
  for (let i = 0; i < 20; i += 1) {
    const summary = await dispatcher.runOnce();
    if (summary.claimed === 0) return;
  }
}

describe('exports (SPK-REPORT-007, §4.14 expiring exports)', () => {
  let t: TestApp;
  let scheduler: Actor;
  let utilizationRunId: string;

  const download = (actor: Actor, id: string, token?: string) => {
    const req = t.http.get(`/v1/reports/exports/${id}/download`).set(actor.header);
    return token === undefined ? req : req.set('X-Export-Token', token);
  };
  const exportOf = (id: string) =>
    t.db.selectFrom('exports').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  beforeAll(async () => {
    t = await reportingTestApp();
    scheduler = await staff(t, ['scheduler']);
    const run = await post(t, '/v1/reports/runs', scheduler, {
      report: 'utilization',
      parameters: { facilityId: t.facilityId, from: DATE, to: DATE },
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    utilizationRunId = run.body.id;
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-007: an export needs its own permission, independent of viewing the report', async () => {
    // Finance may view utilization, and so this run, but may not export operational reports.
    const finance = await staff(t, ['finance_operator']);
    expect((await get(t, `/v1/reports/runs/${utilizationRunId}`, finance)).status).toBe(200);
    const refused = await post(t, '/v1/reports/exports', finance, {
      reportRunId: utilizationRunId,
      format: 'csv',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCESS_DENIED');

    // Front desk may view the daily schedule but not export it.
    const frontDesk = await staff(t, ['front_desk']);
    const schedule = await post(t, '/v1/reports/runs', frontDesk, {
      report: 'daily_schedule',
      parameters: { facilityId: t.facilityId, date: DATE },
    });
    expect(schedule.status).toBe(201);
    const deskExport = await post(t, '/v1/reports/exports', frontDesk, {
      reportRunId: schedule.body.id,
      format: 'csv',
    });
    expect(deskExport.status).toBe(403);

    // A financial report needs the financial export action; the scheduler cannot even see that run.
    const gm = await staff(t, ['general_manager']);
    const obligations = await post(t, '/v1/reports/runs', gm, {
      report: 'outstanding_obligations',
      parameters: {},
    });
    expect(obligations.status).toBe(201);
    expect(
      (
        await post(t, '/v1/reports/exports', scheduler, {
          reportRunId: obligations.body.id,
          format: 'csv',
        })
      ).status,
    ).toBe(404);
    const financial = await post(t, '/v1/reports/exports', gm, {
      reportRunId: obligations.body.id,
      format: 'json',
    });
    expect(financial.status).toBe(201);
    expect(financial.body.authorizedAction).toBe('reporting.export_financial');
    expect(
      await t.db
        .selectFrom('exports')
        .select('id')
        .where('report_run_id', '=', utilizationRunId)
        .execute(),
    ).toHaveLength(0);
  });

  it('SPK-REPORT-007: creating and downloading an export is audited; the download is single use and carries the definitions and as-of instant', async () => {
    const created = await post(t, '/v1/reports/exports', scheduler, {
      reportRunId: utilizationRunId,
      format: 'csv',
      reason: 'Monthly operations pack',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.status).toBe('ready');
    expect(created.body.authorizedAction).toBe('reporting.export_operational');
    expect(new Date(created.body.expiresAt).getTime() - t.clock.now().getTime()).toBe(24 * HOUR);
    expect(created.body.downloadToken).toMatch(/^spx_/);
    const stored = await exportOf(created.body.id);
    expect(stored.download_token_hash).not.toContain(created.body.downloadToken);

    const createdAudit = await t.db
      .selectFrom('audit_records')
      .selectAll()
      .where('target_id', '=', created.body.id)
      .where('action', '=', 'reporting.export_created')
      .executeTakeFirstOrThrow();
    expect(createdAudit.reason).toBe('Monthly operations pack');
    expect(createdAudit.details).toMatchObject({
      reportRunId: utilizationRunId,
      reportKey: 'utilization',
      format: 'csv',
      authorizedAction: 'reporting.export_operational',
      parameters: { facilityId: t.facilityId, from: DATE, to: DATE },
    });
    expect((createdAudit.details as { asOf: string }).asOf).toBeTruthy();

    const file = await download(scheduler, created.body.id, created.body.downloadToken);
    expect(file.status, file.text).toBe(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['x-report-run-id']).toBe(utilizationRunId);
    expect(file.text).toContain('# report: utilization (Field utilization)');
    expect(file.text).toContain('# as of: ');
    expect(file.text).toMatch(/# metric MET-065 v1: name=Reserved unit-hours \| question=/);
    expect(file.text).toContain('resourceId,resource,kind');
    expect((await exportOf(created.body.id)).status).toBe('downloaded');
    const downloadedAudit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', created.body.id)
      .where('action', '=', 'reporting.export_downloaded')
      .execute();
    expect(downloadedAudit).toHaveLength(1);

    const again = await download(scheduler, created.body.id, created.body.downloadToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  it('§4.14: the download token never rests in the idempotency store; a replay withholds it', async () => {
    const body = { reportRunId: utilizationRunId, format: 'csv', reason: 'Replay check' };
    const idempotencyKey = `k-export-replay-${utilizationRunId}`;
    const created = await post(t, '/v1/reports/exports', scheduler, body, idempotencyKey);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await idempotencyStoreContains(t.db, created.body.downloadToken as string)).toBe(false);
    const replay = await post(t, '/v1/reports/exports', scheduler, body, idempotencyKey);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({
      code: 'IDEMPOTENCY_SECRET_WITHHELD',
      details: { resourceId: created.body.id },
    });
  });

  it('§4.10: an export is bound to its requester and its one-time token', async () => {
    const created = await post(t, '/v1/reports/exports', scheduler, {
      reportRunId: utilizationRunId,
      format: 'json',
    });
    expect(created.status).toBe(201);
    const colleague = await staff(t, ['scheduler']);
    expect((await download(colleague, created.body.id, created.body.downloadToken)).status).toBe(
      404,
    );
    expect((await get(t, `/v1/reports/exports/${created.body.id}`, colleague)).status).toBe(404);
    expect((await download(scheduler, created.body.id, 'spx_wrong-token-value')).status).toBe(404);
    expect((await download(scheduler, created.body.id)).status).toBe(404);
    expect((await exportOf(created.body.id)).status).toBe('ready');
    const file = await download(scheduler, created.body.id, created.body.downloadToken);
    expect(file.status).toBe(200);
    const parsed = JSON.parse(file.text);
    expect(parsed.report.key).toBe('utilization');
    expect(parsed.metrics.length).toBeGreaterThan(0);
  });

  it("§4.14: a requester lists their exports with expiry; another account's exports never appear", async () => {
    const own = await t.db
      .selectFrom('exports')
      .select('id')
      .where('requested_by_account_id', '=', scheduler.accountId)
      .orderBy('requested_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    expect(own.length).toBeGreaterThanOrEqual(3);
    const listed = await get(t, '/v1/reports/exports', scheduler, { limit: '200' });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual(own.map((r) => r.id));
    expect(listed.body.nextCursor).toBeNull();
    for (const item of listed.body.items) {
      // Never a token or a download path (§4.14): only the export's facts and its expiry.
      expect(item).not.toHaveProperty('downloadToken');
      expect(item).not.toHaveProperty('downloadPath');
      expect(item.requestedBy.accountId).toBe(scheduler.accountId);
      expect(new Date(item.expiresAt).getTime()).toBeGreaterThan(
        new Date(item.requestedAt).getTime(),
      );
    }

    // Keyset paging, newest first.
    const first = await get(t, '/v1/reports/exports', scheduler, { limit: '2' });
    expect(first.body.items.map((i: { id: string }) => i.id)).toEqual(
      own.slice(0, 2).map((r) => r.id),
    );
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await get(t, '/v1/reports/exports', scheduler, {
      limit: '2',
      cursor: first.body.nextCursor,
    });
    expect(second.body.items.map((i: { id: string }) => i.id)).toEqual(
      own.slice(2, 4).map((r) => r.id),
    );

    // Status filter: the downloaded export only.
    const downloaded = await get(t, '/v1/reports/exports', scheduler, { status: 'downloaded' });
    expect(downloaded.body.items.length).toBeGreaterThan(0);
    expect(downloaded.body.items.every((i: { status: string }) => i.status === 'downloaded')).toBe(
      true,
    );

    // Another account's exports never appear — an administrator's list holds only their own.
    const admin = await staff(t, ['system_administrator', 'general_manager']);
    const adminList = await get(t, '/v1/reports/exports', admin);
    expect(adminList.status).toBe(200);
    expect(adminList.body.items).toEqual([]);
    const colleague = await staff(t, ['scheduler']);
    expect((await get(t, '/v1/reports/exports', colleague)).body.items).toEqual([]);

    // The read action is required on every request.
    const frontDesk = await staff(t, ['front_desk']);
    const refused = await get(t, '/v1/reports/exports', frontDesk);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCESS_DENIED');
  });

  it('§4.14: an export cannot be downloaded after it expires, and the expiry timer expires an unused one', async () => {
    const first = await post(t, '/v1/reports/exports', scheduler, {
      reportRunId: utilizationRunId,
      format: 'csv',
    });
    const second = await post(t, '/v1/reports/exports', scheduler, {
      reportRunId: utilizationRunId,
      format: 'csv',
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    t.clock.advance(24 * HOUR + 60_000);

    const late = await download(scheduler, first.body.id, first.body.downloadToken);
    expect(late.status).toBe(409);
    expect(late.body.details).toMatchObject({ machine: 'Export', from: 'expired' });
    const expired = await exportOf(first.body.id);
    expect(expired.status).toBe('expired');
    expect(expired.downloaded_at).toBeNull();

    await dispatchAll(t);
    const timed = await exportOf(second.body.id);
    expect(timed.status).toBe('expired');
    expect(timed.expired_at).not.toBeNull();
    const audits = await t.db
      .selectFrom('audit_records')
      .select('target_id')
      .where('action', '=', 'reporting.export_expired')
      .where('target_id', 'in', [first.body.id, second.body.id])
      .execute();
    expect(audits).toHaveLength(2);
    // Replaying the timer changes nothing (idempotent handler).
    await dispatchAll(t);
    expect((await exportOf(second.body.id)).revision).toBe(timed.revision);
  });

  it('§4.14: an expired export lists as expired', async () => {
    const created = await post(t, '/v1/reports/exports', scheduler, {
      reportRunId: utilizationRunId,
      format: 'json',
    });
    expect(created.status).toBe(201);
    const ready = await get(t, '/v1/reports/exports', scheduler, { status: 'ready' });
    expect(ready.body.items.map((i: { id: string }) => i.id)).toContain(created.body.id);

    // Past its expiry and before the timer runs: a read marks it expired by the timer's rule.
    t.clock.advance(24 * HOUR + 60_000);
    const stillReady = await get(t, '/v1/reports/exports', scheduler, { status: 'ready' });
    expect(stillReady.status).toBe(200);
    expect(stillReady.body.items.map((i: { id: string }) => i.id)).not.toContain(created.body.id);
    const expired = await get(t, '/v1/reports/exports', scheduler, { status: 'expired' });
    const item = expired.body.items.find((i: { id: string }) => i.id === created.body.id);
    expect(item).toMatchObject({ status: 'expired', revision: 2 });
    expect(item.expiredAt).toBe(t.clock.now().toISOString());
    expect((await exportOf(created.body.id)).status).toBe('expired');
    const audits = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', created.body.id)
      .where('action', '=', 'reporting.export_expired')
      .execute();
    expect(audits).toHaveLength(1);
    // The timer arriving later changes nothing (idempotent), and a single read agrees.
    await dispatchAll(t);
    const single = await get(t, `/v1/reports/exports/${created.body.id}`, scheduler);
    expect(single.body).toMatchObject({ status: 'expired', revision: 2 });
  });

  it('revocation: stale revision refused; a revoked export cannot be downloaded or revoked again', async () => {
    const created = await post(t, '/v1/reports/exports', scheduler, {
      reportRunId: utilizationRunId,
      format: 'csv',
    });
    expect(created.status).toBe(201);
    const stale = await post(t, `/v1/reports/exports/${created.body.id}/revoke`, scheduler, {
      reason: 'Sent to the wrong address',
      expectedRevision: 3,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const revoked = await post(t, `/v1/reports/exports/${created.body.id}/revoke`, scheduler, {
      reason: 'Sent to the wrong address',
      expectedRevision: 1,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect((await download(scheduler, created.body.id, created.body.downloadToken)).status).toBe(
      409,
    );
    const twice = await post(t, `/v1/reports/exports/${created.body.id}/revoke`, scheduler, {
      reason: 'Again',
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_TRANSITION');
  });

  it('SPK-REPORT-007: authority is re-checked at download — a requester whose staff access ended cannot download', async () => {
    const temporary = await staff(t, ['scheduler'], {
      effectiveTo: new Date(t.clock.now().getTime() + HOUR),
    });
    const created = await post(t, '/v1/reports/exports', temporary, {
      reportRunId: utilizationRunId,
      format: 'csv',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    t.clock.advance(2 * HOUR);
    const refused = await download(temporary, created.body.id, created.body.downloadToken);
    expect([403, 404]).toContain(refused.status);
    expect((await exportOf(created.body.id)).status).toBe('ready');
  });
});
