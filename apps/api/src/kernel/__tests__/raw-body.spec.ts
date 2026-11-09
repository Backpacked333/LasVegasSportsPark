import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { Public } from '../auth/public.decorator';
import { RawBody } from '../http/raw-body';

@Controller('webhooks/rawtest')
class RawWebhookTestController {
  @Public()
  @Post(':provider')
  @HttpCode(200)
  receive(@Body() body: unknown, @RawBody() raw: Buffer | undefined) {
    return { parsed: body, raw: raw?.toString('utf8') ?? null };
  }
}

@Controller('rawtest')
class OrdinaryTestController {
  @Public()
  @Post()
  @HttpCode(200)
  receive(@RawBody() raw: Buffer | undefined) {
    return { raw: raw === undefined ? null : raw.toString('utf8') };
  }
}

describe('webhook raw bodies (§4.11)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ controllers: [RawWebhookTestController, OrdinaryTestController] });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§4.11: a webhook route receives the exact bytes the provider sent, beside the parsed body', async () => {
    // Key order and spacing a re-serialized body would not reproduce: a provider signs these bytes.
    const sent = '{ "type":"payment.succeeded",  "id": "evt_1", "a": {"z":1,"b":2} }';
    const res = await t.http
      .post('/v1/webhooks/rawtest/someprovider')
      .set('Content-Type', 'application/json')
      .send(sent);
    expect(res.status).toBe(200);
    expect(res.body.raw).toBe(sent);
    expect(res.body.parsed).toEqual({ type: 'payment.succeeded', id: 'evt_1', a: { z: 1, b: 2 } });
    expect(JSON.stringify(res.body.parsed)).not.toBe(sent);
  });

  it('§4.11: other routes do not keep a second copy of their body', async () => {
    const res = await t.http
      .post('/v1/rawtest')
      .set('Content-Type', 'application/json')
      .send('{"x":1}');
    expect(res.status).toBe(200);
    expect(res.body.raw).toBeNull();
  });
});
