import { Controller, HttpCode, Post } from '@nestjs/common';
import { errors, z } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { Idempotent } from '../http/idempotency.interceptor';
import { ZodBody } from '../http/zod-validation.pipe';

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
