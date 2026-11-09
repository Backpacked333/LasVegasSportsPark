/**
 * Staff dashboard smoke in a real browser (§4.1, §4.9, SPK-UX-006): sign in, see Today, run one
 * command end to end through the API and the database.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support';

test('§4.13: the development sign-in mints a token and opens Today', async ({ page }) => {
  await signIn(page, 'dev-admin');
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  // The shell names the signed-in area navigation.
  await expect(page.getByRole('navigation').first()).toBeVisible();
});

test('§4.9: a command sends one Idempotency-Key, commits, and the screen shows the new state', async ({
  page,
}) => {
  await signIn(page, 'dev-admin');
  await expect(page).toHaveURL(/\/today$/);
  await page.goto('/admin');
  const form = page.getByRole('form', { name: 'Set the default currency' });
  await expect(form).toBeVisible();
  const command = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/v1/admin/settings/default-currency'),
  );
  await form.getByLabel('Currency code').fill('USD');
  await form.getByLabel('Reason').fill('Browser smoke test');
  await form.getByRole('button', { name: 'Save default currency' }).click();
  const request = await command;
  expect(request.headers()['idempotency-key']).toMatch(/.{8,}/);
  await expect(page.getByText('Default currency set to USD.')).toBeVisible();
  await expect(page.getByText('Default currency: USD')).toBeVisible();
});

test('SPK-UX-006: an unknown route inside the dashboard says so instead of failing blank', async ({
  page,
}) => {
  await signIn(page, 'dev-admin');
  await expect(page).toHaveURL(/\/today$/);
  await page.goto('/no-such-screen');
  await expect(page.getByText('Page not available')).toBeVisible();
  await expect(
    page.getByText('This address does not open anything in the dashboard.'),
  ).toBeVisible();
});
