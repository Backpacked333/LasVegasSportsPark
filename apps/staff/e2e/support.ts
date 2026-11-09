import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { SEED_SUMMARY } from '../playwright.config';

interface SeedSummary {
  accounts: Array<{ subject: string; accountId: string }>;
}

/** The account id of a development seed account (`dev-admin`, `dev-desk`, ...). */
export function seededAccountId(subject: string): string {
  const summary = JSON.parse(readFileSync(SEED_SUMMARY, 'utf8')) as SeedSummary;
  const account = summary.accounts.find((a) => a.subject === subject);
  if (!account) throw new Error(`the development seed has no account ${subject}`);
  return account.accountId;
}

/** Signs in through the development sign-in (POST /v1/dev/tokens). */
export async function signIn(page: Page, subject: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Account id').fill(seededAccountId(subject));
  await page.getByRole('button', { name: 'Sign in' }).click();
}
