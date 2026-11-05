import { newId, systemPrincipal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { AuditWriter } from '../audit/audit.writer';
import { databaseConstraintOf } from '../database/constraint-error';
import { UnitOfWork } from '../database/unit-of-work';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';
import { Outbox } from '../outbox/outbox';
import { OutboxHistory, type OutboxHistoryCursor } from '../outbox/outbox-history';

describe('outbox history and joined units (K-07, §4.12, §4.7)', () => {
  let t: TestApp;
  let other: { organizationId: string; facilityId: string };

  beforeAll(async () => {
    t = await createTestApp({ clockStart: '2026-11-02T10:00:00Z' });
    other = await seedOrganization(t.db);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('paging across two organizations never returns the other organization’s events', async () => {
    const uow = t.app.get(UnitOfWork);
    const outbox = t.app.get(Outbox);
    const ours: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await uow.run(async ({ trx }) => {
        for (const organizationId of [t.organizationId, other.organizationId]) {
          const event = await outbox.enqueue(trx, 'kerneltest.history_fact', {
            organizationId,
            aggregateType: 'probe',
            aggregateId: `probe-${i}`,
            payload: { i },
          });
          if (organizationId === t.organizationId) ours.push(event.id);
        }
        await outbox.enqueue(trx, 'kerneltest.other_type', {
          organizationId: t.organizationId,
          aggregateType: 'probe',
          aggregateId: `probe-${i}`,
          payload: { i },
        });
      });
      t.clock.advance(1000);
    }
    // Dispatched events stay in the history (any dispatch status).
    await t.app.get(OutboxDispatcher).runOnce(100);

    const history = t.app.get(OutboxHistory);
    const seen: string[] = [];
    let after: OutboxHistoryCursor | null = null;
    let pages = 0;
    do {
      const page = await history.page({
        organizationId: t.organizationId,
        eventTypes: ['kerneltest.history_fact'],
        after,
        limit: 2,
      });
      for (const event of page.items) {
        expect(event.organizationId).toBe(t.organizationId);
        expect(event.type).toBe('kerneltest.history_fact');
        seen.push(event.id);
      }
      after = page.next;
      pages += 1;
    } while (after && pages < 10);
    expect(seen).toEqual(ours);
    expect(pages).toBe(3);

    const bounded = await history.page({
      organizationId: t.organizationId,
      eventTypes: ['kerneltest.history_fact', 'kerneltest.other_type'],
      after: null,
      until: '2026-11-02T10:00:01.000Z',
      limit: 500,
    });
    expect(bounded.items).toHaveLength(4);
    expect(bounded.next).toBeNull();
    expect(
      (
        await history.page({
          organizationId: t.organizationId,
          eventTypes: [],
          after: null,
          limit: 10,
        })
      ).items,
    ).toEqual([]);
    await expect(
      history.page({ organizationId: t.organizationId, eventTypes: ['x'], after: null, limit: 0 }),
    ).rejects.toThrow(/1..500/);
  });

  it('a joined unit that hits a unique violation rolls back only its own writes, the caller continues, and databaseConstraintOf names the constraint (PGlite and TEST_DATABASE_URL)', async () => {
    const uow = t.app.get(UnitOfWork);
    const audit = t.app.get(AuditWriter);
    const before = newId();
    const inner = newId();
    const after = newId();
    let classified: ReturnType<typeof databaseConstraintOf> = null;
    await uow.run(async ({ trx }) => {
      await audit.record(trx, {
        organizationId: t.organizationId,
        actor: systemPrincipal(t.organizationId, 'kernel.test'),
        action: 'kerneltest.before',
        targetType: 'probe',
        targetId: before,
      });
      try {
        await uow.run(async ({ trx: joined }) => {
          await joined
            .insertInto('facilities')
            .values({
              id: inner,
              organization_id: t.organizationId,
              slug: 'joined-unit-probe',
              name: 'Joined unit probe',
              timezone: 'UTC',
              address: null,
            })
            .execute();
          // The seeded facility already uses the slug 'main' in this organization.
          await joined
            .insertInto('facilities')
            .values({
              id: newId(),
              organization_id: t.organizationId,
              slug: 'main',
              name: 'Duplicate',
              timezone: 'UTC',
              address: null,
            })
            .execute();
        });
      } catch (error) {
        classified = databaseConstraintOf(error);
        if (!classified) throw error;
      }
      await audit.record(trx, {
        organizationId: t.organizationId,
        actor: systemPrincipal(t.organizationId, 'kernel.test'),
        action: 'kerneltest.after',
        targetType: 'probe',
        targetId: after,
      });
    });
    expect(classified).toEqual({
      code: '23505',
      constraint: 'facilities_organization_id_slug_key',
    });
    const audited = await t.db
      .selectFrom('audit_records')
      .select('target_id')
      .where('target_id', 'in', [before, after])
      .execute();
    expect(audited.map((r) => r.target_id).sort()).toEqual([before, after].sort());
    const facility = await t.db
      .selectFrom('facilities')
      .select('id')
      .where('id', '=', inner)
      .executeTakeFirst();
    expect(facility).toBeUndefined();
  });

  it('databaseConstraintOf classifies only the four integrity violations', () => {
    expect(databaseConstraintOf({ code: '23P01', constraint: 'x_excl' })).toEqual({
      code: '23P01',
      constraint: 'x_excl',
    });
    expect(databaseConstraintOf({ cause: { code: '23514', constraint: 'x_check' } })).toEqual({
      code: '23514',
      constraint: 'x_check',
    });
    expect(databaseConstraintOf({ code: '23503' })).toEqual({ code: '23503', constraint: null });
    expect(databaseConstraintOf({ code: '40001' })).toBeNull();
    expect(databaseConstraintOf(new Error('boom'))).toBeNull();
    expect(databaseConstraintOf(null)).toBeNull();
  });
});
