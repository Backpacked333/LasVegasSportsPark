/**
 * SCR-S-55 Point of sale: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the point of sale screen group: edit only this directory.
 *
 * `pending` is what the built screen still cannot decide once the switch is on: which taxes and
 * fees are approved (DEC-057; the API applies only approved `tax_fee` versions), the card
 * processor and its card-present flow (DEC-019; release builds take no card tender), and the cash
 * procedure and variance tolerance (POL-018; every difference is raised for finance).
 */
import type { PackageGScreen } from '../registry';

export const POINT_OF_SALE = {
  id: 'SCR-S-55',
  slug: 'point-of-sale',
  title: 'Point of sale',
  capability: 'point_of_sale',
  area: 'finance',
  path: '/finance/point-of-sale',
  purpose:
    'Products, prices, approved taxes, tenders, receipts, returns, permissions, reconciliation; tenders bypass no registration or capacity check.',
  requirements: 'SPK-PAY-002, SPK-PAY-012, §3.16 POS',
  pending: {
    subject: 'Approved taxes and fees on sales, card tenders and the cash procedure',
    decisions: ['DEC-057', 'DEC-019', 'POL-018'],
    owner: 'Finance (DEC-057, POL-018); Technical lead/account owners (DEC-019)',
  },
} as const satisfies PackageGScreen;
