/**
 * SCR-S-57 Accounting export batches placeholder: behind its capability switch, reachable from its area (Package G,
 * DEC-016). Replace with the screen's own tests when the screen is built.
 */
import { describePackageGPlaceholder } from '../../testing';
import { ACCOUNTING_EXPORTS } from '../meta';

describePackageGPlaceholder(ACCOUNTING_EXPORTS, {
  from: '/finance',
  nav: 'Finance',
  link: 'Accounting export batches (SCR-S-57)',
});
