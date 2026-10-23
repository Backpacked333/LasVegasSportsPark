import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { AuditWriter } from '../audit/audit.writer';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';

describe('unit of work, audit, and operational exceptions', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('runs after-commit hooks only after a successful commit', async () => {
    const uow = t.app.get(UnitOfWork);
    const calls: string[] = [];
    await uow.run(async (ctx) => {
      ctx.afterCommit(() => {
        calls.push('committed');
      });
      calls.push('inside');
    });
    expect(calls).toEqual(['inside', 'committed']);
    await expect(
      uow.run(async (ctx) => {
        ctx.afterCommit(() => {
          calls.push('should-not-run');
        });
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(calls).toEqual(['inside', 'committed']);
  });

  it('writes audit records with a principal snapshot inside the transaction', async () => {
    const uow = t.app.get(UnitOfWork);
    const audit = t.app.get(AuditWriter);
    const actor = staffPrincipal(t.organizationId, ['finance_operator']);
    const targetId = newId();
    await uow.run((ctx) =>
      audit.record(ctx.trx, {
        organizationId: t.organizationId,
        actor,
        action: 'finance.adjust',
        targetType: 'obligation',
        targetId,
        beforeRevision: 1,
        afterRevision: 2,
        reason: 'operator correction',
        correlationId: 'corr-audit-1',
      }),
    );
    const row = await t.db
      .selectFrom('audit_records')
      .selectAll()
      .where('target_id', '=', targetId)
      .executeTakeFirstOrThrow();
    expect(row.actor).toMatchObject({
      kind: 'staff',
      accountId: actor.accountId,
      staffRoles: ['finance_operator'],
    });
    expect(row).toMatchObject({
      action: 'finance.adjust',
      before_revision: 1,
      after_revision: 2,
      reason: 'operator correction',
    });
  });

  it('exceptions deduplicate while open, transition with authorization and revision checks, and are audited', async () => {
    const uow = t.app.get(UnitOfWork);
    const exceptions = t.app.get(OperationalExceptions);
    const raise = () =>
      uow.run((ctx) =>
        exceptions.raise(ctx.trx, {
          organizationId: t.organizationId,
          facilityId: t.facilityId,
          category: 'finance.unknown_payment_outcome',
          severity: 'critical',
          title: 'Payment outcome unknown',
          ownerQueue: 'finance_operator',
          dedupeKey: 'payment:abc',
        }),
      );
    const first = await raise();
    const second = await raise();
    expect(second).toEqual({ id: first.id, deduplicated: true });

    const frontDesk = staffPrincipal(t.organizationId, ['front_desk']);
    await expect(
      uow.run((ctx) => exceptions.transition(ctx.trx, frontDesk, first.id, 'acknowledged')),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    const gm = staffPrincipal(t.organizationId, ['general_manager']);
    await uow.run((ctx) =>
      exceptions.transition(ctx.trx, gm, first.id, 'acknowledged', { expectedRevision: 1 }),
    );
    await expect(
      uow.run((ctx) =>
        exceptions.transition(ctx.trx, gm, first.id, 'resolved', { expectedRevision: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await uow.run((ctx) =>
      exceptions.transition(ctx.trx, gm, first.id, 'closed', {
        expectedRevision: 2,
        reason: 'reconciled',
        resolution: { outcome: 'succeeded' },
      }),
    );
    await expect(
      uow.run((ctx) => exceptions.transition(ctx.trx, gm, first.id, 'resolved')),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    const third = await raise();
    expect(third.deduplicated).toBe(false);
    const open = await exceptions.listOpen(gm, t.organizationId, { facilityId: t.facilityId });
    expect(open.map((e) => e.id)).toContain(third.id);
    const auditRows = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', first.id)
      .orderBy('occurred_at')
      .execute();
    expect(auditRows.map((r) => r.action)).toEqual([
      'exceptions.acknowledged',
      'exceptions.closed',
    ]);
  });
});
