import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../kernel';
import { TEST_CONFIG_ENV, createTestApp, type TestApp } from '../../../testing';
import { DOMAIN_MODULES } from '../../index';
import { SupportModule } from '../../support';
import { AutomationModule } from '../automation.module';
import {
  AUTOMATION_SETTINGS,
  DEFAULT_AUTOMATION_SETTINGS,
  loadAutomationSettings,
} from '../automation.settings';
import { assistantProviderFor } from '../providers/assistant-provider.factory';
import { staffMember, type Actor } from './automation';

const MODULES_DIR = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * SPK-AUTO-005 "Core operations remain usable when the assistant is unavailable". The assistant is
 * off unless AUTOMATION_ENABLED=true: every automation endpoint then answers
 * INTEGRATION_UNAVAILABLE without touching anything, and no other module depends on automation.
 */
describe('SPK-AUTO-005: the assistant is optional', () => {
  describe('disabled (the default)', () => {
    let t: TestApp;
    let operator: Actor;

    beforeAll(async () => {
      // The default settings (AUTOMATION_ENABLED unset → false), pinned so the test does not
      // depend on the environment it runs in.
      t = await createTestApp({
        imports: [AutomationModule, SupportModule],
        principalResolver: 'module',
        configure: (builder) =>
          builder.overrideProvider(AUTOMATION_SETTINGS).useValue(loadAutomationSettings({})),
      });
      operator = await staffMember(t, ['support_operator', 'scheduler', 'general_manager']);
    });
    afterAll(async () => {
      await t.close();
    });

    it('SPK-AUTO-005: every automation endpoint answers INTEGRATION_UNAVAILABLE (even without an idempotency key or a valid body) and writes nothing', async () => {
      const id = newId();
      // Built one at a time: a supertest request starts listening when it is created.
      const calls = [
        () => t.http.post('/v1/assistant/requests').set(operator.header).send({ prompt: 'hello' }),
        () =>
          t.http
            .post('/v1/assistant/requests')
            .set(operator.header)
            .set('Idempotency-Key', `k-${newId()}`)
            .send({ prompt: 'hello' }),
        () => t.http.get(`/v1/assistant/requests/${id}`).set(operator.header),
        () => t.http.get('/v1/recommendations').set(operator.header),
        () => t.http.get(`/v1/recommendations/${id}`).set(operator.header),
        () => t.http.post(`/v1/recommendations/${id}/approve`).set(operator.header).send({}),
        () => t.http.post(`/v1/recommendations/${id}/reject`).set(operator.header).send({}),
        () => t.http.post(`/v1/recommendations/${id}/apply`).set(operator.header).send({}),
        () => t.http.post(`/v1/recommendations/${id}/settle-apply`).set(operator.header).send({}),
      ];
      for (const call of calls) {
        const res = await call();
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({
          code: 'INTEGRATION_UNAVAILABLE',
          nextAction: 'retry_later',
          details: { capability: 'automation', reason: 'disabled' },
        });
      }
      for (const table of ['assistant_requests', 'recommendations', 'tool_invocations'] as const) {
        expect(await t.db.selectFrom(table).select('id').execute()).toEqual([]);
      }
      const keys = await t.db.selectFrom('idempotency_keys').select('idempotency_key').execute();
      expect(keys).toEqual([]);
      // Authentication still comes first: an anonymous caller learns nothing about the module.
      expect((await t.http.get('/v1/recommendations')).status).toBe(401);
    });

    it('SPK-AUTO-005: core support operations keep working in the same application', async () => {
      const res = await t.http
        .post('/v1/cases')
        .set(operator.header)
        .set('Idempotency-Key', `k-${newId()}`)
        .send({ category: 'other', title: 'Assistant is off; work continues' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ status: 'open' });
    });
  });

  describe('absent', () => {
    it('SPK-AUTO-005: without the automation module the application boots and a support command works; automation routes do not exist', async () => {
      const t = await createTestApp({ imports: [SupportModule], principalResolver: 'module' });
      try {
        const operator = await staffMember(t, ['support_operator']);
        const res = await t.http
          .post('/v1/cases')
          .set(operator.header)
          .set('Idempotency-Key', `k-${newId()}`)
          .send({ category: 'other', title: 'No assistant at all' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const missing = await t.http.get('/v1/recommendations').set(operator.header);
        expect(missing.status).toBe(404);
      } finally {
        await t.close();
      }
    });

    it('SPK-AUTO-005: no other module imports the automation module, and it is composed last', () => {
      const offenders: string[] = [];
      for (const entry of readdirSync(MODULES_DIR)) {
        const dir = path.join(MODULES_DIR, entry);
        if (entry === 'automation' || !statSync(dir).isDirectory()) continue;
        for (const file of sourceFiles(dir)) {
          const text = readFileSync(file, 'utf8');
          if (/from\s+['"][./]*automation(['"/])/.test(text) || /modules\/automation/.test(text)) {
            offenders.push(path.relative(MODULES_DIR, file));
          }
        }
      }
      expect(offenders).toEqual([]);
      expect(DOMAIN_MODULES.at(-1)).toBe(AutomationModule);
    });
  });

  describe('configuration', () => {
    it('SPK-AUTO-005: AUTOMATION_ENABLED defaults to false; the policy values have their proposed defaults', () => {
      expect(loadAutomationSettings({})).toEqual(DEFAULT_AUTOMATION_SETTINGS);
      expect(loadAutomationSettings({ AUTOMATION_ENABLED: 'true' })).toMatchObject({
        enabled: true,
        recommendationTtlMinutes: 24 * 60,
        evidenceMaxAgeMinutes: 24 * 60,
        maxTurns: 4,
        maxToolCalls: 12,
      });
      expect(() => loadAutomationSettings({ AUTOMATION_ENABLED: 'yes' })).toThrow(
        /AUTOMATION_ENABLED/,
      );
      expect(() => loadAutomationSettings({ AUTOMATION_MAX_TURNS: '0' })).toThrow(
        /AUTOMATION_MAX_TURNS/,
      );
    });

    it('§5.2: the fake provider is refused in production; enabling the assistant there without a selected provider stops startup', async () => {
      const production = loadConfig({
        ...TEST_CONFIG_ENV,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        DATABASE_URL: 'postgres://unused',
      });
      expect(() =>
        assistantProviderFor(production, { ...DEFAULT_AUTOMATION_SETTINGS, enabled: true }),
      ).toThrow(/no assistant provider has been selected/);
      const off = assistantProviderFor(production, DEFAULT_AUTOMATION_SETTINGS);
      expect(off.name).toBe('none');
      await expect(off.respond({} as never)).rejects.toThrow(/No assistant provider/);
      const development = loadConfig(TEST_CONFIG_ENV);
      expect(assistantProviderFor(development, DEFAULT_AUTOMATION_SETTINGS).name).toBe(
        'fake-assistant',
      );
    });
  });
});
