import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Controller, HttpCode, Post } from '@nestjs/common';
import { errors, newId, z, type Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { UnitOfWork, type Trx } from '../database/unit-of-work';
import { IdempotencySweeper } from '../http/idempotency-sweeper';
import { Idempotent } from '../http/idempotency.interceptor';
import { ZodBody } from '../http/zod-validation.pipe';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { OperationsService } from '../operations/operations.service';

const Body = z.object({
  amount: z.number().int(),
  fail: z.enum(['none', 'domain', 'crash']).default('none'),
});

@Controller('test-commands')
class TestCommandsController {
  static executions = 0;

  @Post()
  @HttpCode(202)
  @Idempotent()
  run(@ZodBody(Body) body: z.infer<typeof Body>): { executions: number; amount: number } {
    TestCommandsController.executions += 1;
    if (body.fail === 'domain') throw errors.capacityUnavailable('Sold out.');
    if (body.fail === 'crash') throw new Error('boom');
    return { executions: TestCommandsController.executions, amount: body.amount };
  }
}

describe('idempotent commands (§4.9)', () => {
  let t: TestApp;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({ controllers: [TestCommandsController] });
    auth = await t.authHeader(customerPrincipal(t.organizationId));
  });
  afterAll(async () => {
    await t?.close();
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await t.http.post('/v1/test-commands').set(auth).send({ amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Idempotency-Key/);
  });

  it('replays the same key + payload without re-executing, and conflicts on a different payload', async () => {
    const before = TestCommandsController.executions;
    const first = await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0001')
      .send({ amount: 10, fail: 'none' });
    expect(first.status).toBe(202);
    expect(first.body.executions).toBe(before + 1);

    // same payload, different key order: still the same request
    const replay = await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0001')
      .send({ fail: 'none', amount: 10 });
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(TestCommandsController.executions).toBe(before + 1);

    const conflict = await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0001')
      .send({ amount: 11 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(TestCommandsController.executions).toBe(before + 1);
  });

  it('keys are scoped per account: another account may reuse the same key', async () => {
    const other = await t.authHeader(customerPrincipal(t.organizationId));
    const before = TestCommandsController.executions;
    const res = await t.http
      .post('/v1/test-commands')
      .set(other)
      .set('Idempotency-Key', 'order-0001')
      .send({ amount: 10 });
    expect(res.status).toBe(202);
    expect(TestCommandsController.executions).toBe(before + 1);
  });

  it('stores domain (4xx) failures so a replay returns the same outcome without re-executing', async () => {
    const before = TestCommandsController.executions;
    const first = await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0002')
      .send({ amount: 1, fail: 'domain' });
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('CAPACITY_UNAVAILABLE');
    const replay = await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0002')
      .send({ amount: 1, fail: 'domain' });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('CAPACITY_UNAVAILABLE');
    expect(replay.body.correlationId).not.toBe(first.body.correlationId);
    expect(TestCommandsController.executions).toBe(before + 1);
  });

  it('releases the key after an unexpected (5xx) failure so the client can retry', async () => {
    const before = TestCommandsController.executions;
    const first = await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0003')
      .send({ amount: 1, fail: 'crash' });
    expect(first.status).toBe(500);
    expect(first.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(first.body.details).toBeUndefined();
    const retry = await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0003')
      .send({ amount: 1, fail: 'none' });
    expect(retry.status).toBe(202);
    expect(TestCommandsController.executions).toBe(before + 2);
  });

  it('expired keys can be reused', async () => {
    const before = TestCommandsController.executions;
    await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0004')
      .send({ amount: 5 });
    t.clock.advance((t.config.IDEMPOTENCY_TTL_HOURS + 1) * 3600_000);
    const res = await t.http
      .post('/v1/test-commands')
      .set(auth)
      .set('Idempotency-Key', 'order-0004')
      .send({ amount: 6 });
    expect(res.status).toBe(202);
    expect(TestCommandsController.executions).toBe(before + 2);
  });
});

// ---------------------------------------------------------------------------------------------
// The idempotency record follows the business transaction (§4.9, §4.7 invariant 5, §4.12).
// ---------------------------------------------------------------------------------------------

const CommitBody = z.object({
  tag: z.string(),
  mode: z
    .enum([
      'ok',
      'commit_then_unavailable',
      'commit_then_crash',
      'crash_inside_unit_of_work',
      'read_then_crash',
      'stall_before_commit',
      'commit_then_stall',
    ])
    .default('ok'),
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A stalled request: `reached` resolves when it stops, `release` lets it continue. */
const stalls = new Map<string, { reached: Deferred; release: Deferred }>();
function stallFor(tag: string) {
  let stall = stalls.get(tag);
  if (!stall) {
    stall = { reached: deferred(), release: deferred() };
    stalls.set(tag, stall);
  }
  return stall;
}

@Controller('test-committing-commands')
class TestCommittingController {
  static executions = new Map<string, number>();
  static organizationId = '';

  constructor(private readonly uow: UnitOfWork) {}

  /** The command's business effect: one committed row per execution. */
  private static async effect(trx: Trx, tag: string): Promise<void> {
    await trx
      .insertInto('audit_records')
      .values({
        id: newId(),
        organization_id: TestCommittingController.organizationId,
        actor: JSON.stringify({ kind: 'system', actorLabel: 'idempotency-test' }),
        action: 'test.idempotent_effect',
        target_type: 'test',
        target_id: tag,
        before_revision: null,
        after_revision: null,
        reason: null,
        correlation_id: null,
        operation_id: null,
      })
      .execute();
  }

  @Post()
  @Idempotent()
  async run(@ZodBody(CommitBody) body: z.infer<typeof CommitBody>): Promise<{ tag: string }> {
    const executions = TestCommittingController.executions;
    const execution = (executions.get(body.tag) ?? 0) + 1;
    executions.set(body.tag, execution);
    // Only the first execution of a tag stalls; a retry that takes over runs straight through.
    const stall = execution === 1 ? stallFor(body.tag) : null;
    switch (body.mode) {
      case 'crash_inside_unit_of_work':
        await this.uow.run(async ({ trx }) => {
          await TestCommittingController.effect(trx, body.tag);
          throw new Error('failed before commit');
        });
        break;
      case 'read_then_crash':
        await this.uow.run(({ trx }) => trx.selectFrom('organizations').select('id').execute());
        throw new Error('failed after a read-only transaction');
      case 'stall_before_commit':
        stall?.reached.resolve();
        await stall?.release.promise;
        await this.uow.run(({ trx }) => TestCommittingController.effect(trx, body.tag));
        break;
      default:
        await this.uow.run(({ trx }) => TestCommittingController.effect(trx, body.tag));
    }
    if (body.mode === 'commit_then_unavailable') {
      // e.g. a provider call made after the commit (§4.11) fails
      throw errors.integrationUnavailable('Test provider');
    }
    if (body.mode === 'commit_then_crash') throw new Error('socket hang up after commit');
    if (body.mode === 'commit_then_stall') {
      stall?.reached.resolve();
      await stall?.release.promise;
    }
    return { tag: body.tag };
  }
}

describe('idempotency follows the business transaction (§4.9, §4.7 invariant 5)', () => {
  let t: TestApp;
  let auth: { Authorization: string };
  const path = '/v1/test-committing-commands';

  beforeAll(async () => {
    t = await createTestApp({ controllers: [TestCommittingController] });
    TestCommittingController.organizationId = t.organizationId;
    auth = await t.authHeader(customerPrincipal(t.organizationId));
    // Listen once, so requests can be sent while an earlier one is still stalled.
    const server = t.app.getHttpServer() as Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
  });
  afterAll(async () => {
    for (const stall of stalls.values()) stall.release.resolve();
    await t?.close();
  });

  const send = (key: string, body: z.input<typeof CommitBody>) =>
    t.http.post(path).set(auth).set('Idempotency-Key', key).send(body);
  const effects = async (tag: string) =>
    (
      await t.db
        .selectFrom('audit_records')
        .select('id')
        .where('action', '=', 'test.idempotent_effect')
        .where('target_id', '=', tag)
        .execute()
    ).length;
  const keyRow = (key: string) =>
    t.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  const leaseMs = () => t.config.IDEMPOTENCY_LEASE_SECONDS * 1000;

  it('§4.9/§4.7-5: a 5xx after the command committed is recorded and replayed, not re-executed', async () => {
    const body = { tag: 'after-commit-503', mode: 'commit_then_unavailable' } as const;
    const first = await send('commit-0001', body);
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const retry = await send('commit-0001', body);
    expect(retry.status).toBe(503);
    expect(retry.body.code).toBe('INTEGRATION_UNAVAILABLE');
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(TestCommittingController.executions.get(body.tag)).toBe(1);
    expect(await effects(body.tag)).toBe(1);
  });

  it('§4.9/§4.7-5: an unexpected error after the command committed is recorded and replayed, not re-executed', async () => {
    const body = { tag: 'after-commit-500', mode: 'commit_then_crash' } as const;
    const first = await send('commit-0002', body);
    expect(first.status).toBe(500);
    expect(first.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(first.body.details).toBeUndefined();
    const retry = await send('commit-0002', body);
    expect(retry.status).toBe(500);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual({ ...first.body, correlationId: retry.body.correlationId });
    expect(TestCommittingController.executions.get(body.tag)).toBe(1);
    expect(await effects(body.tag)).toBe(1);
  });

  it('§4.9: a 5xx whose unit of work rolled back, or that only read, still releases the key for retry', async () => {
    const rolledBack = { tag: 'rolled-back-500', mode: 'crash_inside_unit_of_work' } as const;
    expect((await send('commit-0003', rolledBack)).status).toBe(500);
    expect(await keyRow('commit-0003')).toBeUndefined();
    const retry = await send('commit-0003', rolledBack);
    expect(retry.status).toBe(500);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(TestCommittingController.executions.get(rolledBack.tag)).toBe(2);
    expect(await effects(rolledBack.tag)).toBe(0);

    const readOnly = { tag: 'read-only-500', mode: 'read_then_crash' } as const;
    expect((await send('commit-0004', readOnly)).status).toBe(500);
    expect(await keyRow('commit-0004')).toBeUndefined();
    expect((await send('commit-0004', readOnly)).headers['idempotent-replayed']).toBeUndefined();
    expect(TestCommittingController.executions.get(readOnly.tag)).toBe(2);
  });

  it('§4.9: a failure storing the response after a commit keeps the key; a retry never runs the command again', async () => {
    // Simulate the database failing the completion write (and only that write) for this key.
    await sql`
      create function test_fail_idempotency_completion() returns trigger language plpgsql as $$
      begin
        if new.idempotency_key = 'commit-0005' and new.status = 'completed' then
          raise exception 'simulated outage while storing the response';
        end if;
        return new;
      end $$
    `.execute(t.db);
    await sql`
      create trigger test_fail_idempotency_completion before update on idempotency_keys
      for each row execute function test_fail_idempotency_completion()
    `.execute(t.db);
    try {
      const body = { tag: 'store-fails', mode: 'ok' } as const;
      const first = await send('commit-0005', body);
      expect(first.status).toBe(500);
      expect(await effects(body.tag)).toBe(1);
      expect(await keyRow('commit-0005')).toMatchObject({ status: 'in_progress' });

      const whileLeased = await send('commit-0005', body);
      expect(whileLeased.status).toBe(409);
      expect(whileLeased.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');

      t.clock.advance(leaseMs() + 1000);
      const afterLease = await send('commit-0005', body);
      expect(afterLease.status).toBe(409);
      expect(afterLease.body).toMatchObject({
        code: 'IDEMPOTENCY_OUTCOME_UNAVAILABLE',
        nextAction: 'reload_current_state',
      });
      expect(TestCommittingController.executions.get(body.tag)).toBe(1);
      expect(await effects(body.tag)).toBe(1);
    } finally {
      await sql`drop trigger test_fail_idempotency_completion on idempotency_keys`.execute(t.db);
      await sql`drop function test_fail_idempotency_completion()`.execute(t.db);
    }
  });

  it('§4.9 / §4.12: a retry while the first request still runs gets IDEMPOTENCY_IN_PROGRESS; a request that committed and then stopped is never run again', async () => {
    const body = { tag: 'committed-then-stopped', mode: 'commit_then_stall' } as const;
    const stall = stallFor(body.tag);
    const first = send('commit-0006', body).then((res) => res);
    await stall.reached.promise;
    expect(await effects(body.tag)).toBe(1);

    const running = await send('commit-0006', body);
    expect(running.status).toBe(409);
    expect(running.body).toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      nextAction: 'retry_later_with_same_key',
    });

    // The first request's process "died" after committing: the lease lapses, the key is not
    // handed to the retry, because that would run the committed command a second time.
    t.clock.advance(leaseMs() + 1000);
    const afterLease = await send('commit-0006', body);
    expect(afterLease.status).toBe(409);
    expect(afterLease.body.code).toBe('IDEMPOTENCY_OUTCOME_UNAVAILABLE');
    expect(TestCommittingController.executions.get(body.tag)).toBe(1);

    // If the first request does finish, its response is stored and replayed.
    stall.release.resolve();
    expect((await first).status).toBe(201);
    const replay = await send('commit-0006', body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(TestCommittingController.executions.get(body.tag)).toBe(1);
    expect(await effects(body.tag)).toBe(1);
  });

  it('§4.9 / §4.12: a request that stopped before committing is retried once its lease lapses, and the stalled request can no longer commit', async () => {
    const body = { tag: 'stopped-before-commit', mode: 'stall_before_commit' } as const;
    const stall = stallFor(body.tag);
    const first = send('commit-0007', body).then((res) => res);
    await stall.reached.promise;

    const running = await send('commit-0007', body);
    expect(running.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');

    // The first request's process "died" before committing anything: once its lease lapses, the
    // retry takes the key over and runs the command.
    t.clock.advance(leaseMs() + 1000);
    const takeover = await send('commit-0007', body);
    expect(takeover.status).toBe(201);
    expect(takeover.headers['idempotent-replayed']).toBeUndefined();
    expect(TestCommittingController.executions.get(body.tag)).toBe(2);
    expect(await effects(body.tag)).toBe(1);

    // The stalled request resumes but no longer holds the key: the fence rolls its commit back.
    stall.release.resolve();
    const stalled = await first;
    expect(stalled.status).toBe(409);
    expect(stalled.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(await effects(body.tag)).toBe(1);

    const replay = await send('commit-0007', body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await effects(body.tag)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The key names the operation its command started (§4.9: a replay returns the same operation).
// ---------------------------------------------------------------------------------------------

const OperationBody = z.object({
  tag: z.string(),
  mode: z.enum([
    'ok',
    'commit_then_crash',
    'commit_then_stall',
    'rolled_back',
    'nested_then_primary',
  ]),
});

@Controller('test-operation-commands')
class TestOperationController {
  static organizationId = '';
  static created = new Map<string, string[]>();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly operations: OperationsService,
  ) {}

  @Post()
  @HttpCode(202)
  @Idempotent()
  async run(
    @ZodBody(OperationBody) body: z.infer<typeof OperationBody>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ operationId: string }> {
    const create = (trx: Trx, kind: string, primary?: boolean) =>
      this.operations
        .create(trx, {
          organizationId: TestOperationController.organizationId,
          kind,
          requestedBy: principal,
          status: 'running',
          primary,
        })
        .then((id) => {
          TestOperationController.created.set(body.tag, [
            ...(TestOperationController.created.get(body.tag) ?? []),
            id,
          ]);
          return id;
        });
    if (body.mode === 'rolled_back') {
      await this.uow.run(async ({ trx }) => {
        await create(trx, 'test.rolled_back');
        throw new Error('failed before commit');
      });
    }
    const operationId = await this.uow.run(async ({ trx }) => {
      if (body.mode === 'nested_then_primary') {
        // e.g. a nested hold that opens its own operation before the coordinator's
        await this.uow.run(({ trx: inner }) => create(inner, 'test.nested_step'));
        return create(trx, 'test.coordinator', true);
      }
      return create(trx, 'test.multi_step');
    });
    if (body.mode === 'commit_then_crash') throw new Error('step 2 failed after the commit');
    if (body.mode === 'commit_then_stall') {
      const stall = stallFor(body.tag);
      stall.reached.resolve();
      await stall.release.promise;
    }
    return { operationId };
  }
}

describe('§4.9: an idempotency key names the operation its command started', () => {
  let t: TestApp;
  let auth: { Authorization: string };
  const path = '/v1/test-operation-commands';

  beforeAll(async () => {
    t = await createTestApp({ controllers: [TestOperationController] });
    TestOperationController.organizationId = t.organizationId;
    auth = await t.authHeader(customerPrincipal(t.organizationId));
    const server = t.app.getHttpServer() as Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });
  afterAll(async () => {
    for (const stall of stalls.values()) stall.release.resolve();
    await t?.close();
  });

  const send = (key: string, body: z.input<typeof OperationBody>) =>
    t.http.post(path).set(auth).set('Idempotency-Key', key).send(body);
  const keyRow = (key: string) =>
    t.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();

  it('§4.9: a 5xx after the operation committed names it in the response and in every replay', async () => {
    const body = { tag: 'op-crash', mode: 'commit_then_crash' } as const;
    const first = await send('operation-0001', body);
    const [operationId] = TestOperationController.created.get(body.tag) ?? [];
    expect(operationId).toBeDefined();
    expect(first.status).toBe(500);
    expect(first.body).toMatchObject({ code: 'INTERNAL_ERROR', details: { operationId } });
    const replay = await send('operation-0001', body);
    expect(replay.status).toBe(500);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.details).toEqual({ operationId });
    expect(await keyRow('operation-0001')).toMatchObject({ operation_id: operationId });
    // the requester polls the operation for the real outcome (§4.8)
    const polled = await t.http.get(`/v1/operations/${operationId}`).set(auth);
    expect(polled.status).toBe(200);
    expect(polled.body).toMatchObject({ id: operationId, status: 'running' });
  });

  it('§4.9: IDEMPOTENCY_OUTCOME_UNAVAILABLE after a lapsed lease names the operation', async () => {
    const body = { tag: 'op-stall', mode: 'commit_then_stall' } as const;
    const stall = stallFor(body.tag);
    const first = send('operation-0002', body).then((res) => res);
    await stall.reached.promise;
    const [operationId] = TestOperationController.created.get(body.tag) ?? [];
    t.clock.advance(t.config.IDEMPOTENCY_LEASE_SECONDS * 1000 + 1000);
    const retry = await send('operation-0002', body);
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({
      code: 'IDEMPOTENCY_OUTCOME_UNAVAILABLE',
      details: { operationId },
    });
    stall.release.resolve();
    expect((await first).body).toEqual({ operationId });
  });

  it('§4.9: an operation whose transaction rolled back is not linked and the key is released', async () => {
    const body = { tag: 'op-rolled-back', mode: 'rolled_back' } as const;
    expect((await send('operation-0003', body)).status).toBe(500);
    expect(await keyRow('operation-0003')).toBeUndefined();
  });

  it('§4.9: the first operation is linked, unless a coordinator marks its own as primary', async () => {
    const ok = await send('operation-0004', { tag: 'op-ok', mode: 'ok' });
    expect(ok.status).toBe(202);
    expect(await keyRow('operation-0004')).toMatchObject({ operation_id: ok.body.operationId });

    const body = { tag: 'op-primary', mode: 'nested_then_primary' } as const;
    const res = await send('operation-0005', body);
    const [nested, coordinator] = TestOperationController.created.get(body.tag) ?? [];
    expect(res.body).toEqual({ operationId: coordinator });
    expect(nested).not.toBe(coordinator);
    expect(await keyRow('operation-0005')).toMatchObject({ operation_id: coordinator });
  });
});

// ---------------------------------------------------------------------------------------------
// One-time secrets are never stored with the key; expired keys are swept (§4.9, §4.14).
// ---------------------------------------------------------------------------------------------

const SecretBody = z.object({ label: z.string(), fail: z.boolean().default(false) });

@Controller('test-secret-commands')
class TestSecretController {
  static executions = 0;

  @Post()
  @Idempotent({ withhold: ['token', 'path'] })
  issue(@ZodBody(SecretBody) body: z.infer<typeof SecretBody>): {
    id: string;
    label: string;
    token: string;
    path: string;
  } {
    TestSecretController.executions += 1;
    if (body.fail) throw errors.validation('Label refused.');
    const token = `secret-${newId()}`;
    return { id: newId(), label: body.label, token, path: `/v1/feeds/${token}.ics` };
  }
}

describe('§4.14: one-time secrets never rest in the idempotency store', () => {
  let t: TestApp;
  let auth: { Authorization: string };
  const path = '/v1/test-secret-commands';

  beforeAll(async () => {
    t = await createTestApp({ controllers: [TestSecretController] });
    auth = await t.authHeader(customerPrincipal(t.organizationId));
  });
  afterAll(async () => {
    await t?.close();
  });

  const send = (key: string, body: z.input<typeof SecretBody>) =>
    t.http.post(path).set(auth).set('Idempotency-Key', key).send(body);
  const stored = async (key: string) =>
    (
      await sql<{ body: string | null }>`
        select response_body::text as body from idempotency_keys where idempotency_key = ${key}
      `.execute(t.db)
    ).rows[0]?.body ?? null;

  it('§4.14: the original response carries the secret but the stored body never does', async () => {
    const res = await send('secret-0001', { label: 'feed' });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^secret-/);
    const body = await stored('secret-0001');
    expect(body).not.toBeNull();
    expect(body).not.toContain(res.body.token as string);
    expect(JSON.parse(body as string)).toEqual({ id: res.body.id, label: 'feed' });
  });

  it('§4.9: a replay names the created record and withholds the secret instead of re-executing', async () => {
    const first = await send('secret-0002', { label: 'feed' });
    const before = TestSecretController.executions;
    const replay = await send('secret-0002', { label: 'feed' });
    expect(replay.status).toBe(409);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toMatchObject({
      code: 'IDEMPOTENCY_SECRET_WITHHELD',
      nextAction: 'revoke_and_reissue',
      details: { resourceId: first.body.id },
    });
    expect(JSON.stringify(replay.body)).not.toContain(first.body.token as string);
    expect(TestSecretController.executions).toBe(before);
  });

  it('§4.9: a stored domain failure still replays as itself', async () => {
    const first = await send('secret-0003', { label: 'x', fail: true });
    expect(first.status).toBe(400);
    const replay = await send('secret-0003', { label: 'x', fail: true });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('VALIDATION_FAILED');
  });

  it('§4.9, §4.14: the sweep deletes records past their expiry and keeps live ones', async () => {
    const sweeper = t.app.get(IdempotencySweeper);
    await send('secret-0004', { label: 'old' });
    t.clock.advance((t.config.IDEMPOTENCY_TTL_HOURS + 1) * 3600_000);
    await send('secret-0005', { label: 'live' });
    const deleted = await sweeper.sweep(2);
    expect(deleted).toBeGreaterThanOrEqual(4);
    const keys = (
      await t.db.selectFrom('idempotency_keys').select('idempotency_key').execute()
    ).map((r) => r.idempotency_key);
    expect(keys).toEqual(['secret-0005']);
  });
});
