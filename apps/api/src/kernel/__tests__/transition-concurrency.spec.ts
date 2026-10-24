import type { Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { OperationsService } from '../operations/operations.service';

/**
 * §4.9 (a stale edit must fail rather than overwrite newer work), §4.6, §4.7 invariant 9 (no silent
 * rewriting of history): two transitions of the same operation or exception race. On PostgreSQL
 * they overlap (the first holds its transaction open with pg_sleep); under PGlite they run one
 * after the other. Either way exactly one wins and the other is refused, never silently lost.
 */
describe('concurrent kernel transitions (§4.9, §4.7 invariant 9)', () => {
  let t: TestApp;
  let uow: UnitOfWork;
  let operations: OperationsService;
  let exceptions: OperationalExceptions;
  let manager: Principal;

  beforeAll(async () => {
    t = await createTestApp();
    uow = t.app.get(UnitOfWork);
    operations = t.app.get(OperationsService);
    exceptions = t.app.get(OperationalExceptions);
    manager = staffPrincipal(t.organizationId, ['general_manager']);
  });
  afterAll(async () => {
    await t?.close();
  });

  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (error: { code?: string }) => `err:${error.code ?? String(error)}`,
    );
  /** Holds the first transaction open after its transition so the second one overlaps it. */
  const hold = async (trx: Parameters<Parameters<UnitOfWork['run']>[0]>[0]['trx']) => {
    if (t.database.concurrent) await sql`select pg_sleep(0.2)`.execute(trx);
  };
  const stagger = () =>
    t.database.concurrent ? new Promise((resolve) => setTimeout(resolve, 50)) : Promise.resolve();

  it('§4.9/§4.6: of two concurrent operation transitions, one wins and the other is refused', async () => {
    const id = await uow.run(({ trx }) =>
      operations.create(trx, {
        organizationId: t.organizationId,
        kind: 'test.race',
        requestedBy: manager,
        status: 'running',
      }),
    );
    const a = outcome(
      uow.run(async ({ trx }) => {
        await operations.transition(trx, id, 'succeeded', { result: { by: 'A' } });
        await hold(trx);
      }),
    );
    await stagger();
    const b = outcome(
      uow.run(({ trx }) =>
        operations.transition(trx, id, 'failed', { error: { code: 'X', message: 'by B' } }),
      ),
    );
    const outcomes = await Promise.all([a, b]);
    expect([...outcomes].sort()).toEqual(['err:INVALID_TRANSITION', 'ok']);
    const row = await t.db
      .selectFrom('operations')
      .select(['status', 'revision', 'result', 'error'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    // The state is the winner's, and the loser was told so instead of believing it succeeded.
    expect(row).toMatchObject(
      outcomes[0] === 'ok'
        ? { status: 'succeeded', revision: 2, result: { by: 'A' }, error: null }
        : { status: 'failed', revision: 2, result: null, error: { message: 'by B' } },
    );
  });

  const raise = (dedupeKey: string) =>
    uow.run((ctx) =>
      exceptions.raise(ctx.trx, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        category: 'test.race',
        severity: 'high',
        title: 'Race',
        ownerQueue: 'general_manager',
        dedupeKey,
      }),
    );
  const auditsFor = (id: string) =>
    t.db
      .selectFrom('audit_records')
      .select(['action', 'before_revision', 'after_revision'])
      .where('target_id', '=', id)
      .execute();

  it('§4.7 invariant 9: two concurrent resolutions of one exception write one transition and one audit record', async () => {
    const { id } = await raise('race-resolve');
    const a = outcome(
      uow.run(async ({ trx }) => {
        await exceptions.transition(trx, manager, id, 'resolved', { resolution: { by: 'A' } });
        await hold(trx);
      }),
    );
    await stagger();
    const b = outcome(
      uow.run(({ trx }) =>
        exceptions.transition(trx, manager, id, 'resolved', { resolution: { by: 'B' } }),
      ),
    );
    const outcomes = await Promise.all([a, b]);
    expect([...outcomes].sort()).toEqual(['err:INVALID_TRANSITION', 'ok']);
    const row = await t.db
      .selectFrom('operational_exceptions')
      .select(['status', 'revision', 'resolution'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'resolved',
      revision: 2,
      resolution: { by: outcomes[0] === 'ok' ? 'A' : 'B' },
    });
    expect(await auditsFor(id)).toEqual([
      { action: 'exceptions.resolved', before_revision: 1, after_revision: 2 },
    ]);
  });

  it('§4.9: two concurrent transitions with the same expected revision: the second is STALE_REVISION and is not audited', async () => {
    const { id } = await raise('race-revision');
    const a = outcome(
      uow.run(async ({ trx }) => {
        await exceptions.transition(trx, manager, id, 'resolved', { expectedRevision: 1 });
        await hold(trx);
      }),
    );
    await stagger();
    const b = outcome(
      uow.run(({ trx }) =>
        exceptions.transition(trx, manager, id, 'acknowledged', { expectedRevision: 1 }),
      ),
    );
    const outcomes = await Promise.all([a, b]);
    expect([...outcomes].sort()).toEqual(['err:STALE_REVISION', 'ok']);
    const winner = outcomes[0] === 'ok' ? 'resolved' : 'acknowledged';
    const row = await t.db
      .selectFrom('operational_exceptions')
      .select(['status', 'revision'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: winner, revision: 2 });
    // No audit record for the transition that did not happen.
    expect(await auditsFor(id)).toEqual([
      { action: `exceptions.${winner}`, before_revision: 1, after_revision: 2 },
    ]);
  });

  it('a sequential operation lifecycle still advances one revision per transition', async () => {
    const id = await uow.run(({ trx }) =>
      operations.create(trx, {
        organizationId: t.organizationId,
        kind: 'test.sequential',
        requestedBy: manager,
      }),
    );
    await uow.run(({ trx }) => operations.transition(trx, id, 'running'));
    await uow.run(({ trx }) => operations.transition(trx, id, 'succeeded', { result: { ok: 1 } }));
    expect(
      await t.db
        .selectFrom('operations')
        .select(['status', 'revision'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'succeeded', revision: 3 });
  });
});
