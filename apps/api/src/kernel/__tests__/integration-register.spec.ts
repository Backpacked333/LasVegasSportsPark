import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import {
  INTEGRATION_REGISTRY,
  PROVIDER_GATES,
  type IntegrationRegistryPort,
} from '../integrations/integration-registry';

describe('integration register (K-09, §5.1, §5.2)', () => {
  let t: TestApp;
  let registry: IntegrationRegistryPort;

  beforeAll(async () => {
    t = await createTestApp();
    registry = t.app.get(INTEGRATION_REGISTRY);
    registry.register({
      id: 'kerneltest.payment_provider',
      gate: 'payments',
      port: 'KERNELTEST_PAYMENT_PORT',
      adapter: { name: 'fake-payments', kind: 'fake' },
      productionAllowed: false,
      scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
      reconciliationOwner: 'finance_operator',
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§5.2: every provider gate is listed as pending its decision with no vendor', async () => {
    const gm = await t.authHeader(staffPrincipal(t.organizationId, ['general_manager']));
    const res = await t.http.get('/v1/admin/integrations').set(gm);
    expect(res.status).toBe(200);
    expect(
      res.body.gates.map((g: { gate: string; decisionRef: string }) => [g.gate, g.decisionRef]),
    ).toEqual([
      ['identity', 'DEC-018'],
      ['payments', 'DEC-019'],
      ['messaging', 'DEC-020'],
      ['hosting', 'DEC-021'],
      ['accounting', 'DEC-022'],
      ['hardware', 'DEC-023'],
      ['assistant', 'DEC-013'],
    ]);
    for (const gate of res.body.gates) {
      expect(gate.status).toBe('pending_decision');
      expect(gate.evidenceLevel).toBeNull();
      expect(Object.values(gate.register).every((v) => v === null)).toBe(true);
      expect(Object.keys(gate.register)).toHaveLength(12);
      for (const adapter of gate.adapters) expect(adapter.adapter.kind).not.toBe('provider');
    }
    // The kernel's local identity adapter (development and tests only).
    const identity = res.body.gates.find((g: { gate: string }) => g.gate === 'identity');
    expect(identity.adapters).toEqual([
      {
        id: 'kernel.identity_provider',
        gate: 'identity',
        port: 'IDENTITY_PROVIDER',
        adapter: { name: 'local-hs256', kind: 'local' },
        productionAllowed: false,
        scenarios: [],
        reconciliationOwner: null,
      },
    ]);
    expect(PROVIDER_GATES).toHaveLength(7);
    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    expect((await t.http.get('/v1/admin/integrations').set(desk)).status).toBe(403);
  });

  it('a registered fake adapter lists its scenarios and is never production-allowed', async () => {
    const admin = await t.authHeader(staffPrincipal(t.organizationId, ['system_administrator']));
    const res = await t.http.get('/v1/admin/integrations').set(admin);
    const payments = res.body.gates.find((g: { gate: string }) => g.gate === 'payments');
    expect(payments.adapters).toEqual([
      {
        id: 'kerneltest.payment_provider',
        gate: 'payments',
        port: 'KERNELTEST_PAYMENT_PORT',
        adapter: { name: 'fake-payments', kind: 'fake' },
        productionAllowed: false,
        scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
        reconciliationOwner: 'finance_operator',
      },
    ]);
    const base = {
      gate: 'payments' as const,
      port: 'P',
      adapter: { name: 'fake', kind: 'fake' as const },
      productionAllowed: false,
      scenarios: ['success' as const],
      reconciliationOwner: null,
    };
    expect(() => registry.register({ ...base, id: 'kerneltest.payment_provider' })).toThrow(
      /already registered/,
    );
    expect(() =>
      registry.register({ ...base, id: 'kerneltest.prod_fake', productionAllowed: true }),
    ).toThrow(/never production-allowed/);
    expect(() =>
      registry.register({
        ...base,
        id: 'kerneltest.vendor',
        adapter: { name: 'v', kind: 'provider' },
      }),
    ).toThrow(/no provider is selected/);
    expect(() =>
      registry.register({ ...base, id: 'kerneltest.no_scenarios', scenarios: [] }),
    ).toThrow(/scenarios/);
    expect(() => registry.register({ ...base, id: 'Not An Id' })).toThrow(/<module>.<port>/);
  });
});
