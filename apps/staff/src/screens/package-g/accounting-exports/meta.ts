/**
 * SCR-S-57 Accounting export batches: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the accounting export batches screen group: edit only this directory.
 *
 * `pending` is what the built screen still cannot decide once the switch is on: the accounting
 * system, its connection and export format (DEC-022). Only the API's deterministic fake
 * connection exists; revenue recognition is not done.
 */
import type { PackageGScreen } from '../registry';

export const ACCOUNTING_EXPORTS = {
  id: 'SCR-S-57',
  slug: 'accounting-exports',
  title: 'Accounting export batches',
  capability: 'accounting',
  area: 'finance',
  path: '/finance/accounting-exports',
  purpose: 'Approved mappings, export or integration batches, reconciliation, correction handling.',
  requirements: 'SPK-PAY-010, SPK-PAY-011, §3.16 Accounting',
  pending: {
    subject: 'The accounting connection and its export format',
    decisions: ['DEC-022'],
    owner: 'Technical lead/account owners',
  },
} as const satisfies PackageGScreen;
