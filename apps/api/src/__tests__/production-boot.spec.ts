import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../modules';
import { CHANNEL_PROVIDERS, type ChannelProviderPort } from '../modules/communications/ports';
import { ACCESS_DEVICE_PORT, type AccessDevicePort } from '../modules/entry/entry.ports';
import {
  ACCOUNTING_EXPORT_PORT,
  PAYMENT_PROVIDER_PORT,
  type AccountingExportPort,
  type PaymentProviderPort,
} from '../modules/finance/finance.ports';
import {
  INTEGRATION_REGISTRY,
  loadConfig,
  PROVIDER_SELECTORS,
  type IntegrationRegistryPort,
} from '../kernel';
import { createTestApp, PRODUCTION_CONFIG_ENV, type TestApp } from '../testing';

/**
 * §5.2, §4.14 (DEC-018 to DEC-023): the assembled application boots with a production-shaped
 * configuration: managed identity with its decision recorded, a database URL, and every provider
 * gate explicitly set to `none` while its decision is pending. No fake adapter runs, and every
 * port that has no provider refuses its work with a recorded failure instead of a crash.
 */
describe('production boot without fake providers (§5.2, §4.14)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      env: PRODUCTION_CONFIG_ENV,
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§5.2: the assembled application boots in production with every gate set to none', async () => {
    expect(t.config.NODE_ENV).toBe('production');
    const res = await t.http.get('/v1/health');
    expect(res.status).toBe(200);
  });

  it('§5.2: no fake adapter is registered; only the managed identity adapter, under its decision', () => {
    const adapters = t.app.get<IntegrationRegistryPort>(INTEGRATION_REGISTRY).list();
    expect(adapters).toEqual([
      {
        id: 'kernel.identity_provider',
        gate: 'identity',
        port: 'IDENTITY_PROVIDER',
        adapter: { name: 'oidc-jwks', kind: 'provider' },
        productionAllowed: true,
        scenarios: [],
        reconciliationOwner: null,
      },
    ]);
  });

  it('§5.2, DEC-019: with no processor selected a payment fails with a readable reason and moves nothing', async () => {
    const payments = t.app.get<PaymentProviderPort>(PAYMENT_PROVIDER_PORT);
    expect(payments.name).toBe('none');
    const result = await payments.createPayment({
      idempotencyKey: 'attempt-1',
      amountMinor: 5000,
      currency: 'USD',
      paymentMethodRef: 'pm_anything',
      metadata: { organizationId: t.organizationId, paymentAttemptId: 'attempt-1' },
    });
    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'no_payment_provider_selected',
      feeMinor: null,
    });
    expect(await payments.retrievePayment('attempt-1')).toBeNull();
    expect(payments.verifyWebhook({}, 'any', Buffer.from('{}'))).toBe(false);
  });

  it('§5.2, DEC-020, DEC-022, DEC-023: messaging has no channel adapters; accounting and hardware refuse with a reason', async () => {
    expect(t.app.get<ChannelProviderPort[]>(CHANNEL_PROVIDERS)).toEqual([]);
    const accounting = t.app.get<AccountingExportPort>(ACCOUNTING_EXPORT_PORT);
    await expect(accounting.submitBatch({} as never)).resolves.toEqual({
      outcome: 'rejected',
      error: 'no_accounting_connection_selected',
    });
    const devices = t.app.get<AccessDevicePort>(ACCESS_DEVICE_PORT);
    await expect(devices.sendCommand({} as never)).resolves.toEqual({
      outcome: 'failed',
      error: 'no_access_hardware_selected',
    });
  });
});

describe('production configuration refuses fakes and unset gates (§5.2)', () => {
  it('§5.2: every provider selector must be set explicitly in production, naming its decision', () => {
    const { PAYMENT_PROVIDER: _p, ...withoutPayments } = PRODUCTION_CONFIG_ENV;
    expect(() => loadConfig(withoutPayments)).toThrow(
      /PAYMENT_PROVIDER must be set explicitly.*DEC-019/,
    );
    for (const [key, selector] of Object.entries(PROVIDER_SELECTORS)) {
      expect(() => loadConfig({ ...PRODUCTION_CONFIG_ENV, [key]: 'fake' })).toThrow(
        new RegExp(`${key}=fake .*cannot run in production.*${selector.decisionRef}`),
      );
    }
    expect(loadConfig(PRODUCTION_CONFIG_ENV).PAYMENT_PROVIDER).toBe('none');
  });

  it('§5.2: outside production an unset selector runs the deterministic fake', () => {
    const development = loadConfig({
      NODE_ENV: 'development',
      AUTH_LOCAL_SECRET: 'x'.repeat(40),
    });
    for (const key of Object.keys(PROVIDER_SELECTORS)) {
      expect(development[key as keyof typeof development]).toBeUndefined();
    }
  });
});
