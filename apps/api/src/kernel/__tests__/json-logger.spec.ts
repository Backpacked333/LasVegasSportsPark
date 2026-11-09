import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import type { LogLevel } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_CONFIG_ENV, type TestApp } from '../../testing/test-app';
import { Public } from '../auth/public.decorator';
import { loadConfig } from '../config';
import { createLogger, JsonLogger } from '../logging/json-logger';
import { currentLogContext, runWithLogContext } from '../logging/log-context';

function capture(level: LogLevel = 'log') {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger({
    level,
    service: 'api',
    version: '1.2.3',
    now: () => new Date('2026-11-09T12:00:00.000Z'),
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('structured logs (§5.11, §4.10, §4.14)', () => {
  it('§4.10: a line written while serving a request carries its correlation id, context and service', () => {
    const { logger, lines } = capture();
    runWithLogContext({ correlationId: 'corr-1234567890' }, () => {
      logger.log('enrollment confirmed', 'EnrollmentService');
    });
    logger.log('outside any request', 'Worker');
    expect(lines).toEqual([
      {
        time: '2026-11-09T12:00:00.000Z',
        level: 'log',
        service: 'api',
        version: '1.2.3',
        context: 'EnrollmentService',
        message: 'enrollment confirmed',
        correlationId: 'corr-1234567890',
      },
      {
        time: '2026-11-09T12:00:00.000Z',
        level: 'log',
        service: 'api',
        version: '1.2.3',
        context: 'Worker',
        message: 'outside any request',
      },
    ]);
  });

  it('§5.11: errors keep their stack; levels below the threshold are not written', () => {
    const { logger, lines } = capture('warn');
    logger.log('routine', 'X');
    logger.debug('detail', 'X');
    logger.warn('backlog growing', 'Outbox');
    const error = new Error('handler failed');
    logger.error('dispatch failed', error.stack, 'OutboxDispatcher');
    expect(lines.map((l) => l['level'])).toEqual(['warn', 'error']);
    expect(lines[1]).toMatchObject({ context: 'OutboxDispatcher', message: 'dispatch failed' });
    expect(String(lines[1]?.['stack'])).toContain('handler failed');
  });

  it('§4.14: secret-looking fields of a structured message are never written', () => {
    const { logger, lines } = capture();
    logger.log(
      {
        message: 'request',
        authorization: 'Bearer abc',
        passcode: 'p',
        apiToken: 't',
        status: 200,
      },
      'HttpAccess',
    );
    expect(lines[0]).toMatchObject({
      message: 'request',
      authorization: '[redacted]',
      passcode: '[redacted]',
      apiToken: '[redacted]',
      status: 200,
    });
  });

  it('§5.11: production writes JSON lines by default; elsewhere the readable console', () => {
    const production = loadConfig({
      ...TEST_CONFIG_ENV,
      NODE_ENV: 'development',
      LOG_FORMAT: 'json',
    });
    expect(createLogger(production, 'api')).toBeInstanceOf(JsonLogger);
    expect(createLogger(loadConfig(TEST_CONFIG_ENV), 'api')).toEqual(['error']);
  });
});

@Controller('logtest')
class LogContextTestController {
  @Public()
  @Post()
  @HttpCode(200)
  receive(@Body() body: { n: number }) {
    return { n: body.n, correlationId: currentLogContext()?.correlationId ?? null };
  }
}

describe('request log context and access log (§4.10, §5.11)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ controllers: [LogContextTestController] });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§4.10: the route runs inside the request log context, also after a JSON body was parsed', async () => {
    const res = await t.http
      .post('/v1/logtest')
      .set('X-Correlation-Id', 'corr-route-123456')
      .send({ n: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ n: 7, correlationId: 'corr-route-123456' });
  });

  it('§5.11, §4.14: one access line per request, with identifiers masked and no query string', async () => {
    const spy = vi.spyOn(Logger.prototype, 'log');
    try {
      await t.http
        .post('/v1/logtest?search=Jane%20Doe')
        .set('X-Correlation-Id', 'corr-access-123456')
        .send({ n: 1 });
      await t.http.get('/v1/people/01a1b21d-60d9-7f51-b3f7-88b995319799');
      const access = spy.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .filter((m) => typeof m === 'object' && m !== null && m['message'] === 'request');
      expect(access[0]).toMatchObject({
        method: 'POST',
        path: '/v1/logtest',
        status: 200,
        correlationId: 'corr-access-123456',
      });
      expect(typeof access[0]?.['durationMs']).toBe('number');
      // No identity module in this app: the route is unknown, and the id is still masked.
      expect(access[1]).toMatchObject({ method: 'GET', path: '/v1/people/:id', status: 404 });
      expect(JSON.stringify(access)).not.toContain('Jane');
    } finally {
      spy.mockRestore();
    }
  });
});
