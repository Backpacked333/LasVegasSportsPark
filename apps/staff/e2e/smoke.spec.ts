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

test('SPK-UX-010: Legends mode applies, survives a reload before first paint, and turns off', async ({
  page,
}) => {
  await signIn(page, 'dev-admin');
  await expect(page).toHaveURL(/\/today$/);
  const html = page.locator('html');
  const toggle = page.getByRole('switch', { name: 'Legends mode' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const pageColour = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const classic = await pageColour();

  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'legends');
  expect(await pageColour()).toBe('rgb(10, 9, 7)');

  // The stored choice is applied by /theme-init.js, before the application script runs.
  await page.reload({ waitUntil: 'commit' });
  await expect(html).toHaveAttribute('data-theme', 'legends');
  await expect(page.getByRole('switch', { name: 'Legends mode' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.getByRole('switch', { name: 'Legends mode' }).click();
  await expect(html).not.toHaveAttribute('data-theme', 'legends');
  expect(await pageColour()).toBe(classic);
});

test('SPK-UX-005: quick navigation opens a screen from the keyboard and titles the tab', async ({
  page,
}) => {
  await signIn(page, 'dev-admin');
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Quick navigation' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Search screens and actions' }).fill('capability');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/capabilities$/);
  await expect(dialog).toBeHidden();
  await expect(page).toHaveTitle('Capability switches · Sportspark staff');
});

test('SPK-UX-010: the chrome is liquid glass in Chromium (every glass body carries its bend filter)', async ({
  page,
}) => {
  await signIn(page, 'dev-admin');
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible();
  const bodies = await page.evaluate(() =>
    [...document.querySelectorAll('.glass__optic')]
      .filter((optic) => optic.getClientRects().length > 0)
      .map((optic) => /url\(/.test(getComputedStyle(optic).backdropFilter)),
  );
  expect(bodies.length).toBeGreaterThanOrEqual(4);
  expect(bodies.every(Boolean)).toBe(true);
  // The filters are SVG filter elements (an HTML element named "filter" would bend nothing).
  const filters = await page.evaluate(() =>
    [...document.querySelectorAll('.glass__defs filter')].map(
      (filter) => filter instanceof SVGFilterElement,
    ),
  );
  expect(filters.length).toBe(bodies.length);
  expect(filters.every(Boolean)).toBe(true);
});
