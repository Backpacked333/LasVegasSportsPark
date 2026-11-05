import { defineEvent, errors, newId, z } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { withCommitFence } from '../database/commit-fence';
import { currentTransaction } from '../database/transaction-context';
import { UnitOfWork, type Trx } from '../database/unit-of-work';
import { EventHandlerRegistry } from '../outbox/event-handler.registry';
import { Outbox } from '../outbox/outbox';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';

const NestedPing = defineEvent(
  'test.nested_ping',
  z.object({ slug: z.string(), fail: z.boolean() }),
);

/**
 * §4.7 invariants 3 and 12, §4.11: a command of another module called from inside a command or an
 * outbox handler joins the caller's transaction (UnitOfWork.run is reentrant), so the two commit
 * or roll back together and nothing is left half-applied.
 */
describe('reentrant unit of work (§4.7 invariants 3 and 12, §4.11)', () => {
  let t: TestApp;
  let uow: UnitOfWork;
  const log: string[] = [];

  const insertOrg = (trx: Trx, slug: string) =>
    trx.insertInto('organizations').values({ id: newId(), slug, name: slug }).execute();
  const orgExists = async (slug: string) =>
    (await t.db
      .selectFrom('organizations')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst()) !== undefined;

  beforeAll(async () => {
    t = await createTestApp();
    uow = t.app.get(UnitOfWork);
    t.app
      .get(EventHandlerRegistry)
      .on<{ slug: string; fail: boolean }>(
        NestedPing.type,
        'test.nested_command',
        async (event) => {
          // what a module handler does when it calls another module's command
          await uow.run(async (inner) => {
            await insertOrg(inner.trx, event.payload.slug);
            inner.afterCommit(() => {
              log.push(`hook:${event.payload.slug}`);
            });
          });
          log.push(`handler-done:${event.payload.slug}`);
          if (event.payload.fail) throw new Error('handler failed after the nested command');
        },
      );
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§4.7-3: a nested run joins the enclosing transaction and commits with it', async () => {
    await uow.run(async (outer) => {
      await uow.run(async (inner) => {
        expect(inner.trx).toBe(outer.trx);
        expect(currentTransaction()).toBe(outer.trx);
        await insertOrg(inner.trx, 'joined-commit');
      });
      // the nested write is visible to the caller without a second connection
      const seen = await outer.trx
        .selectFrom('organizations')
        .select('id')
        .where('slug', '=', 'joined-commit')
        .executeTakeFirst();
      expect(seen).toBeDefined();
    });
    expect(await orgExists('joined-commit')).toBe(true);
  });

  it('§4.7-12: when the caller fails after the nested command succeeded, both roll back', async () => {
    await expect(
      uow.run(async () => {
        await uow.run((inner) => insertOrg(inner.trx, 'joined-rollback'));
        throw new Error('step 3 failed');
      }),
    ).rejects.toThrow('step 3 failed');
    expect(await orgExists('joined-rollback')).toBe(false);
  });

  it('§4.11: a failing nested command rolls back only its own writes and the caller may carry on', async () => {
    await uow.run(async (outer) => {
      await insertOrg(outer.trx, 'outer-kept');
      await expect(
        uow.run(async (inner) => {
          await insertOrg(inner.trx, 'inner-dropped');
          // a failed statement: without the savepoint it would abort the whole transaction
          await insertOrg(inner.trx, 'outer-kept');
        }),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        uow.run(async (inner) => {
          await insertOrg(inner.trx, 'inner-domain-error');
          throw errors.resourceConflict('already there');
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      await insertOrg(outer.trx, 'outer-after-failures');
    });
    expect(await orgExists('outer-kept')).toBe(true);
    expect(await orgExists('outer-after-failures')).toBe(true);
    expect(await orgExists('inner-dropped')).toBe(false);
    expect(await orgExists('inner-domain-error')).toBe(false);
  });

  it('defers nested after-commit hooks to the outermost commit, and drops them on rollback', async () => {
    const calls: string[] = [];
    await uow.run(async (outer) => {
      await uow.run(async (inner) => {
        inner.afterCommit(() => {
          calls.push('inner');
        });
      });
      expect(calls).toEqual([]);
      outer.afterCommit(() => {
        calls.push('outer');
      });
      calls.push('body-done');
    });
    expect(calls).toEqual(['body-done', 'inner', 'outer']);

    const dropped: string[] = [];
    await expect(
      uow.run(async () => {
        await uow.run(async (inner) => {
          inner.afterCommit(() => {
            dropped.push('inner');
          });
        });
        throw new Error('outer rolled back');
      }),
    ).rejects.toThrow('outer rolled back');
    expect(dropped).toEqual([]);
  });

  it('§4.9: the commit fence runs once, for the outermost transaction only', async () => {
    let fenced = 0;
    const fence = withCommitFence(
      {
        beforeCommit: async () => {
          fenced += 1;
          return undefined;
        },
        linkOperation: async () => undefined,
      },
      () =>
        uow.run(async (outer) => {
          await uow.run((inner) => insertOrg(inner.trx, 'fenced-inner'));
          await insertOrg(outer.trx, 'fenced-outer');
        }),
    );
    await fence.result;
    fence.close();
    expect(fenced).toBe(1);
  });

  it('retries a serialization failure at the outermost level only', async () => {
    let attempts = 0;
    await uow.run(async () => {
      attempts += 1;
      await uow.run(async () => {
        if (attempts === 1)
          throw Object.assign(new Error('could not serialize'), { code: '40001' });
      });
    });
    expect(attempts).toBe(2);
  });

  it('refuses a nested isolation level that differs from the enclosing transaction', async () => {
    await expect(
      uow.run(() => uow.run(async () => undefined, { isolationLevel: 'serializable' })),
    ).rejects.toThrow(/cannot join an enclosing read committed transaction/);
    // the same level joins
    await uow.run(() => uow.run(async () => undefined, { isolationLevel: 'serializable' }), {
      isolationLevel: 'serializable',
    });
  });

  it('refuses two nested units running side by side in one transaction', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect(
      uow.run(async () => {
        const first = uow.run(async () => {
          await gate;
        });
        const second = uow.run(async () => undefined).finally(release);
        await Promise.all([first, second]);
      }),
    ).rejects.toThrow(/one at a time/);
  });

  it('§4.12: a command called from an outbox handler joins the handler transaction', async () => {
    const outbox = t.app.get(Outbox);
    const dispatcher = t.app.get(OutboxDispatcher);
    const enqueue = (slug: string, fail: boolean) =>
      uow.run((ctx) =>
        outbox.enqueue(ctx.trx, NestedPing, {
          organizationId: t.organizationId,
          aggregateType: 'ping',
          aggregateId: slug,
          payload: { slug, fail },
          maxAttempts: 1,
        }),
      );
    await enqueue('handler-ok', false);
    await enqueue('handler-fails', true);
    await dispatcher.runOnce();
    // the nested command committed with the consumption; its hook ran after that commit
    expect(await orgExists('handler-ok')).toBe(true);
    expect(log).toContain('handler-done:handler-ok');
    expect(log.indexOf('hook:handler-ok')).toBeGreaterThan(log.indexOf('handler-done:handler-ok'));
    // the handler failed after the nested command: nothing of it committed, and no hook ran
    expect(await orgExists('handler-fails')).toBe(false);
    expect(log).toContain('handler-done:handler-fails');
    expect(log).not.toContain('hook:handler-fails');
  });
});
