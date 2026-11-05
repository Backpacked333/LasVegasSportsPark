import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_REGISTRY, loadConfig, type IntegrationRegistryPort } from '../../../kernel';
import { TEST_CONFIG_ENV, createTestApp, type TestApp } from '../../../testing';
import { AutomationModule } from '../automation.module';
import { DEFAULT_AUTOMATION_SETTINGS } from '../automation.settings';
import { assistantProviderFor } from '../providers/assistant-provider.factory';
import { get, staffMember, automationTestApp } from './automation';

const ASSISTANT_ADAPTER = {
  id: 'automation.assistant_provider',
  gate: 'assistant',
  port: 'ASSISTANT_PROVIDER_PORT',
  adapter: { name: 'fake-assistant', kind: 'fake' },
  productionAllowed: false,
  scenarios: ['success', 'failure', 'timeout_unknown'],
  reconciliationOwner: 'system_administrator',
};

async function assistantGate(t: TestApp) {
  const admin = await staffMember(t, ['system_administrator']);
  const res = await get(t, '/v1/admin/integrations', admin);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.gates as Array<{ gate: string }>).find((g) => g.gate === 'assistant');
}

/**
 * AUT-01 (§5.1 integration register, §5.2 provider-selection gate, DEC-013): the adapter behind
 * ASSISTANT_PROVIDER_PORT is in the register whether or not the assistant is enabled, so the
 * register states which adapter would answer. No behaviour changes.
 */
describe('assistant adapter in the integration register (AUT-01, §5.1, §5.2)', () => {
  describe('assistant enabled', () => {
    let t: TestApp;
    beforeAll(async () => {
      ({ t } = await automationTestApp());
    });
    afterAll(async () => {
      await t.close();
    });

    it('§5.2: the assistant adapter is listed as a fake that production refuses', async () => {
      const gate = await assistantGate(t);
      expect(gate).toMatchObject({
        gate: 'assistant',
        decisionRef: 'DEC-013',
        status: 'pending_decision',
        evidenceLevel: null,
        adapters: [ASSISTANT_ADAPTER],
      });
      expect(
        t.app
          .get<IntegrationRegistryPort>(INTEGRATION_REGISTRY)
          .list()
          .filter((r) => r.gate === 'assistant'),
      ).toEqual([ASSISTANT_ADAPTER]);
      // Production refuses the fake: enabling the assistant there stops startup (DEC-013 pending),
      // and with the assistant off the port is the no-provider stand-in, which is not registered.
      const production = loadConfig({
        ...TEST_CONFIG_ENV,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        DATABASE_URL: 'postgres://unused',
      });
      expect(() =>
        assistantProviderFor(production, { ...DEFAULT_AUTOMATION_SETTINGS, enabled: true }),
      ).toThrow(/DEC-013/);
      expect(assistantProviderFor(production, DEFAULT_AUTOMATION_SETTINGS).name).toBe('none');
    });
  });

  describe('assistant disabled (the default)', () => {
    let t: TestApp;
    beforeAll(async () => {
      // No override: the module reads AUTOMATION_ENABLED (absent: false) from the kernel config.
      t = await createTestApp({ imports: [AutomationModule], principalResolver: 'module' });
    });
    afterAll(async () => {
      await t.close();
    });

    it('§5.2: with the assistant disabled the register still names the adapter that would answer', async () => {
      const gate = await assistantGate(t);
      expect(gate).toMatchObject({ decisionRef: 'DEC-013', adapters: [ASSISTANT_ADAPTER] });
    });
  });
});
