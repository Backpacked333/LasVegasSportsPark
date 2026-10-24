import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json } from '@sportspark/db';
import type { TestApp } from '../../../testing';
import {
  stagedCredit,
  stagedObligation,
  stagedPerson,
  stagedRelationship,
} from '../testing/migration-fixtures';
import {
  customer,
  get,
  grantLegacyAuthority,
  importSnapshot,
  migrationTestApp,
  post,
  rowsOf,
  staff,
  type Actor,
} from './support';

interface Discrepancy {
  level: string;
  area: string;
  entityType: string;
  code: string;
  externalId: string | null;
  currency: string | null;
  differenceMinor: number | null;
  countDifference: number | null;
  expected: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
}

describe('reconciliation (§5.5)', () => {
  let t: TestApp;
  let operator: Actor;
  let finance: Actor;
  let support: Actor;

  beforeAll(async () => {
    t = await migrationTestApp();
    operator = await staff(t, ['general_manager']);
    finance = await staff(t, ['finance_operator']);
    support = await staff(t, ['support_operator']);
    await grantLegacyAuthority(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('§5.5: a control-total mismatch is reported per category and currency and never netted against another', async () => {
    const rows = [
      stagedPerson('N-1'),
      stagedPerson('N-2'),
      stagedObligation('N-OB-1', { debtorExternalId: 'N-1', amountMinor: 20_000 }),
      stagedObligation('N-OB-2', { debtorExternalId: 'N-2', amountMinor: 10_500 }),
      stagedCredit('N-CR-1', { ownerExternalId: 'N-1', amountMinor: 4_500 }),
      stagedCredit('N-CR-2', { ownerExternalId: 'N-2', amountMinor: 1_000, currency: 'CAD' }),
    ];
    // The source declares obligations of 30,000 and credits of 5,000 USD: +500 and -500, which
    // would cancel out if netted. It also declares one person fewer than it sent and no CAD total.
    const applied = await importSnapshot(t, operator, rows, {
      controlTotals: {
        counts: { person: 1, open_obligation: 2, credit: 2 },
        amounts: [
          { entityType: 'open_obligation', currency: 'USD', totalMinor: 30_000 },
          { entityType: 'credit', currency: 'USD', totalMinor: 5_000 },
        ],
      },
    });
    const generated = await post(
      t,
      `/v1/import-batches/${applied.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    const report = generated.body;
    expect(report.status).toBe('discrepancy');
    expect(report.requiredAreas).toEqual(['identity', 'finance']);
    const control = (report.discrepancies as Discrepancy[]).filter(
      (d) => d.level === 'control_totals',
    );
    expect(
      control
        .map((d) => [d.entityType, d.code, d.currency, d.differenceMinor, d.countDifference])
        .sort(),
    ).toEqual(
      [
        ['credit', 'amount_mismatch', 'USD', -500, null],
        ['credit', 'undeclared_total', 'CAD', 1_000, null],
        ['open_obligation', 'amount_mismatch', 'USD', 500, null],
        ['person', 'count_mismatch', null, null, 1],
      ].sort(),
    );
    expect(
      report.levels.find((l: { level: string }) => l.level === 'control_totals'),
    ).toMatchObject({
      status: 'discrepancy',
      discrepancyCount: 4,
    });
    // The applied records themselves reconcile: identities exist, balances hold staged amounts.
    for (const level of ['record_identity', 'relationships', 'operational_outcomes']) {
      expect(report.levels.find((l: { level: string }) => l.level === level)).toMatchObject({
        status: 'balanced',
        discrepancyCount: 0,
      });
    }

    // Approvals per area (§5.5): finance approves opening balances; accepting needs a reason.
    const noReason = await post(
      t,
      `/v1/import-reconciliation-reports/${report.id}/approvals`,
      finance,
      {
        area: 'finance',
        decision: 'approved',
      },
    );
    expect(noReason.status).toBe(400);
    const wrongArea = await post(
      t,
      `/v1/import-reconciliation-reports/${report.id}/approvals`,
      support,
      {
        area: 'finance',
        decision: 'approved',
        reason: 'x',
      },
    );
    expect(wrongArea.status).toBe(403);
    const approvedFinance = await post(
      t,
      `/v1/import-reconciliation-reports/${report.id}/approvals`,
      finance,
      {
        area: 'finance',
        decision: 'approved',
        reason: 'The legacy summary report double-counted a fee; balances verified row by row.',
      },
    );
    expect(approvedFinance.status, JSON.stringify(approvedFinance.body)).toBe(200);
    expect(approvedFinance.body.approvalStatus).toBe('pending');
    expect(approvedFinance.body.approvals[0]).toMatchObject({
      area: 'finance',
      approverRole: 'finance_operator',
      acknowledgedDiscrepancies: 3,
    });
    // The accepted discrepancies stay listed (never netted away).
    expect(approvedFinance.body.discrepancyCount).toBe(4);
    const twice = await post(
      t,
      `/v1/import-reconciliation-reports/${report.id}/approvals`,
      finance,
      {
        area: 'finance',
        decision: 'approved',
        reason: 'again',
      },
    );
    expect(twice.status).toBe(409);
    const identity = await post(
      t,
      `/v1/import-reconciliation-reports/${report.id}/approvals`,
      support,
      {
        area: 'identity',
        decision: 'approved',
        reason: 'One person was missing from the legacy count; identities verified.',
      },
    );
    expect(identity.status, JSON.stringify(identity.body)).toBe(200);
    expect(identity.body.approvalStatus).toBe('approved');
    const late = await post(
      t,
      `/v1/import-reconciliation-reports/${report.id}/approvals`,
      support,
      {
        area: 'identity',
        decision: 'rejected',
        reason: 'late',
      },
    );
    expect(late.status).toBe(409);
  });

  it('§5.5: a balanced import reconciles at all four levels; regenerating supersedes the pending report', async () => {
    const rows = [
      stagedPerson('B-1'),
      stagedObligation('B-OB', { debtorExternalId: 'B-1', amountMinor: 900 }),
    ];
    const applied = await importSnapshot(t, operator, rows);
    const first = await post(
      t,
      `/v1/import-batches/${applied.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(first.body).toMatchObject({
      status: 'balanced',
      discrepancyCount: 0,
      approvalStatus: 'pending',
    });
    t.clock.advance(1_000);
    const second = await post(
      t,
      `/v1/import-batches/${applied.id}/reconciliation-reports`,
      finance,
      {},
    );
    expect(second.status).toBe(201);
    const superseded = await get(t, `/v1/import-reconciliation-reports/${first.body.id}`, operator);
    expect(superseded.body).toMatchObject({
      approvalStatus: 'superseded',
      supersededByReportId: second.body.id,
    });
    const list = await get(t, `/v1/import-batches/${applied.id}/reconciliation-reports`, operator);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([second.body.id, first.body.id]);
    // A balanced area is approved without a reason.
    const ok = await post(
      t,
      `/v1/import-reconciliation-reports/${second.body.id}/approvals`,
      finance,
      {
        area: 'finance',
        decision: 'approved',
      },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const rejected = await post(
      t,
      `/v1/import-reconciliation-reports/${second.body.id}/approvals`,
      operator,
      {
        area: 'identity',
        decision: 'rejected',
        reason: 'Identity sample check failed; repeat the extraction.',
      },
    );
    expect(rejected.body.approvalStatus).toBe('rejected');
  });

  it('§5.5 levels 2-4: unresolved rows, authority that is no longer effective, and active records the owning module cannot import are all reported', async () => {
    const rows = [
      stagedPerson('L-1', { dateOfBirth: '1980-02-02' }),
      stagedPerson('L-2', { dateOfBirth: '2015-02-02' }),
      stagedRelationship('L-R', {
        actorExternalId: 'L-1',
        subjectExternalId: 'L-2',
        permissions: ['view', 'pay'],
      }),
      {
        entityType: 'roster' as const,
        externalId: 'RO-1',
        payload: { teamExternalId: 'T-1', personExternalId: 'L-1', active: 'true' },
      },
      {
        entityType: 'roster' as const,
        externalId: 'RO-2',
        payload: { teamExternalId: 'T-1', personExternalId: 'L-2', active: false },
      },
      {
        entityType: 'future_schedule' as const,
        externalId: 'FS-1',
        payload: { startsAt: '2027-03-01T17:00:00Z' },
      },
    ];
    const applied = await importSnapshot(t, operator, rows);
    expect(applied.outcomeCounts).toEqual({
      created: 3,
      matched: 0,
      updated: 0,
      skipped: 3,
      exception: 0,
    });
    const applyRows = await rowsOf(t, operator, applied.id);
    const relationshipId = applyRows.find((r) => r.externalId === 'L-R')?.internalId as string;
    // The grant is revoked in identity after the import (simulated revocation).
    await t.db
      .updateTable('access_grants')
      .set({
        revoked_at: t.clock.now(),
        revocation_reason: 'test revocation',
        revoked_by: json({ kind: 'system' }),
      })
      .where('relationship_id', '=', relationshipId)
      .where('permission', '=', 'pay')
      .execute();
    const report = await post(
      t,
      `/v1/import-batches/${applied.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const found = (report.body.discrepancies as Discrepancy[]).map((d) => [
      d.level,
      d.entityType,
      d.code,
      d.externalId,
      d.countDifference,
    ]);
    expect(found).toContainEqual([
      'relationships',
      'relationship_evidence',
      'permission_not_effective',
      'L-R',
      null,
    ]);
    expect(found).toContainEqual([
      'operational_outcomes',
      'roster',
      'active_records_not_applied',
      null,
      -1,
    ]);
    expect(found).toContainEqual([
      'operational_outcomes',
      'future_schedule',
      'active_records_not_applied',
      null,
      -1,
    ]);
    expect(report.body.requiredAreas).toEqual(['identity', 'participation', 'schedule']);
    // The schedule area is approved by operations (scheduler), not by finance.
    const byFinance = await post(
      t,
      `/v1/import-reconciliation-reports/${report.body.id}/approvals`,
      finance,
      {
        area: 'schedule',
        decision: 'approved',
        reason: 'x',
      },
    );
    expect(byFinance.status).toBe(403);
    const scheduler = await staff(t, ['scheduler']);
    const bySchedule = await post(
      t,
      `/v1/import-reconciliation-reports/${report.body.id}/approvals`,
      scheduler,
      {
        area: 'schedule',
        decision: 'approved',
        reason: 'Future games are rebuilt in SportsPark scheduling before cutover.',
      },
    );
    expect(bySchedule.status, JSON.stringify(bySchedule.body)).toBe(200);
  });

  it('§4.10: reconciliation reports are protected; a batch must be applied before it is reconciled', async () => {
    const parent = await customer(t);
    const rows = [stagedPerson('Q-1')];
    const applied = await importSnapshot(t, operator, rows);
    const report = await post(
      t,
      `/v1/import-batches/${applied.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(
      (await get(t, `/v1/import-reconciliation-reports/${report.body.id}`, parent)).status,
    ).toBe(404);
    const desk = await staff(t, ['front_desk']);
    expect((await get(t, `/v1/import-reconciliation-reports/${report.body.id}`, desk)).status).toBe(
      404,
    );
    expect(
      (
        await post(t, `/v1/import-reconciliation-reports/${report.body.id}/approvals`, desk, {
          area: 'identity',
          decision: 'approved',
        })
      ).status,
    ).toBe(404);
    const staged = await post(t, '/v1/import-batches', operator, {
      sourceSystem: 'legacy-registration',
      snapshotTakenAt: '2027-01-16T08:00:00.000Z',
      transformationVersion: 'staging-v1',
      controlTotals: { counts: { person: 1 }, amounts: [] },
      rows: [stagedPerson('Q-2')],
    });
    const early = await post(
      t,
      `/v1/import-batches/${staged.body.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_TRANSITION');
  });
});
