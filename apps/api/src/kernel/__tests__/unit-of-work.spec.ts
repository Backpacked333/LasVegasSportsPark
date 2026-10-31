import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { AuditWriter } from '../audit/audit.writer';
import { currentTransaction } from '../database/transaction-context';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';

describe('unit of work, audit, and operational exceptions', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
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

  it('exposes the active transaction through async context so ports read the command snapshot', async () => {
    const uow = t.app.get(UnitOfWork);
    expect(currentTransaction()).toBeUndefined();
    expect(uow.reader()).toBe(t.db);
    await uow
      .run(async (ctx) => {
        expect(currentTransaction()).toBe(ctx.trx);
        expect(uow.current()).toBe(ctx.trx);
        expect(uow.reader()).toBe(ctx.trx);
        // a nested async call (what a port does) still sees the transaction
        await Promise.resolve().then(() => expect(currentTransaction()).toBe(ctx.trx));
        // reading through the context sees this transaction's uncommitted write without a second connection
        await ctx.trx
          .insertInto('organizations')
          .values({ id: '00000000-0000-7000-8000-00000000c0de', slug: 'ctx-visible', name: 'ctx' })
          .execute();
        const seen = await uow
          .reader()
          .selectFrom('organizations')
          .select('id')
          .where('slug', '=', 'ctx-visible')
          .executeTakeFirst();
        expect(seen).toBeDefined();
        throw new Error('rollback');
      })
      .catch((e: Error) => expect(e.message).toBe('rollback'));
    expect(currentTransaction()).toBeUndefined();
    const after = await t.db
      .selectFrom('organizations')
      .select('id')
      .where('slug', '=', 'ctx-visible')
      .executeTakeFirst();
    expect(after).toBeUndefined();
  });

  it('work that outlives a unit of work reads through the root database, not its finished transaction', async () => {
    const uow = t.app.get(UnitOfWork);
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const later: { continuation?: Promise<{ current: boolean; reader: boolean; rows: number }> } =
      {};
    await uow.run(async () => {
      // e.g. a worker nudge scheduled from inside a command
      later.continuation = resumed.then(async () => {
        const reader = uow.reader();
        const rows = await reader.selectFrom('organizations').select('id').execute();
        return {
          current: currentTransaction() !== undefined,
          reader: reader === t.db,
          rows: rows.length,
        };
      });
    });
    resume();
    const result = await later.continuation;
    expect(result).toMatchObject({ current: false, reader: true });
    expect(result?.rows).toBeGreaterThan(0);
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

  it('SPK-UX-006 listOpen limits facility-scoped staff to their facilities and organization-wide exceptions', async () => {
    const uow = t.app.get(UnitOfWork);
    const exceptions = t.app.get(OperationalExceptions);
    const other = await t.db
      .insertInto('facilities')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        slug: `scope-${newId().slice(-8)}`,
        name: 'Other facility',
        timezone: 'America/Los_Angeles',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const raise = (facilityId: string | null, title: string) =>
      uow.run((ctx) =>
        exceptions.raise(ctx.trx, {
          organizationId: t.organizationId,
          facilityId,
          category: 'scope.check',
          severity: 'warning',
          title,
          ownerQueue: 'front_desk',
        }),
      );
    const own = await raise(t.facilityId, 'OWN');
    const elsewhere = await raise(other.id, 'OTHER');
    const orgWide = await raise(null, 'ORGWIDE');
    const mine = [own.id, elsewhere.id, orgWide.id];
    const idsOf = (rows: { id: string }[]) =>
      rows
        .map((r) => r.id)
        .filter((id) => mine.includes(id))
        .sort();

    const scoped = staffPrincipal(t.organizationId, ['front_desk'], {
      facilityIds: [t.facilityId],
    });
    expect(idsOf(await exceptions.listOpen(scoped, t.organizationId))).toEqual(
      [own.id, orgWide.id].sort(),
    );
    const gm = staffPrincipal(t.organizationId, ['general_manager']);
    expect(idsOf(await exceptions.listOpen(gm, t.organizationId))).toEqual([...mine].sort());
    expect(
      idsOf(await exceptions.listOpen(scoped, t.organizationId, { facilityId: t.facilityId })),
    ).toEqual([own.id]);
    await expect(
      exceptions.listOpen(scoped, t.organizationId, { facilityId: other.id }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
