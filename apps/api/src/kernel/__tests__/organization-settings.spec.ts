import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';

const key = () => `cur-${newId()}`;

/**
 * Organization default currency (migration 0018; SPK-PAY-001, §2.1 configuration; park UI
 * redesign gap): null until a system administrator sets it; every signed-in principal reads it.
 */
describe('organization default currency (SPK-PAY-001)', () => {
  let t: TestApp;
  let admin: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.authHeader(staffPrincipal(t.organizationId, ['system_administrator']));
  });
  afterAll(async () => {
    await t?.close();
  });

  const set = (header: Record<string, string>, body: Record<string, unknown>) =>
    t.http
      .post('/v1/admin/settings/default-currency')
      .set(header)
      .set('Idempotency-Key', key())
      .send(body);

  it('SPK-PAY-001: the default currency is null until set; a system administrator sets it with the expected revision and a reason', async () => {
    const customer = await t.authHeader(customerPrincipal(t.organizationId, newId()));
    const before = await t.http.get('/v1/organization').set(customer);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ id: t.organizationId, defaultCurrency: null });
    const revision = before.body.revision as number;

    const changed = await set(admin, {
      currency: 'USD',
      expectedRevision: revision,
      reason: 'Operator configuration',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ defaultCurrency: 'USD', revision: revision + 1 });
    const after = await t.http.get('/v1/organization').set(customer);
    expect(after.body.defaultCurrency).toBe('USD');
    const settings = await t.http.get('/v1/admin/settings').set(admin);
    expect(settings.body.organization.defaultCurrency).toBe('USD');
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('action', '=', 'core.set_default_currency')
      .execute();
    expect(audit).toEqual([
      { action: 'core.set_default_currency', reason: 'Operator configuration' },
    ]);

    // §4.9: a stale revision is refused; another role may not change it.
    const stale = await set(admin, {
      currency: 'CAD',
      expectedRevision: revision,
      reason: 'Stale',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const gm = await t.authHeader(staffPrincipal(t.organizationId, ['general_manager']));
    const denied = await set(gm, {
      currency: 'CAD',
      expectedRevision: revision + 1,
      reason: 'Not mine',
    });
    expect(denied.status).toBe(403);
    const invalid = await set(admin, {
      currency: 'usd',
      expectedRevision: revision + 1,
      reason: 'Lower case',
    });
    expect(invalid.status).toBe(400);
  });

  it('SPK-PAY-001 invariant: the database refuses a default currency that is not an ISO 4217 code', async () => {
    await expect(
      t.db
        .updateTable('organizations')
        .set({ default_currency: 'dollars' })
        .where('id', '=', t.organizationId)
        .execute(),
    ).rejects.toThrow(/organizations_default_currency_iso/);
  });
});
