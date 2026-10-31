/**
 * "Finance" area home (SPK-UX-005): SCR-S-35 to SCR-S-38 built here. The conditional finance
 * screens (SCR-S-53 memberships, SCR-S-54 session packages, SCR-S-55 point of sale, SCR-S-57
 * accounting export) are linked to their own pages (src/screens/package-g/), each behind its
 * capability switch (DEC-016); accounting export also waits on DEC-022.
 */
import { Link } from 'react-router';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { StateView } from '../../ui/StateView';
import { PACKAGE_G_LIST } from '../package-g/registry';

const CONDITIONAL = PACKAGE_G_LIST.filter((screen) => screen.area === 'finance');

const SCREENS = [
  {
    to: '/finance/obligations',
    title: 'Obligations and orders',
    id: 'SCR-S-35',
    purpose:
      'Obligations per customer and team with total, received, allocated and remaining; orders by payment and fulfillment state, lines and installment plans.',
  },
  {
    to: '/finance/payments',
    title: 'Payment attempts and unknown outcomes',
    id: 'SCR-S-36',
    purpose:
      'Payment attempts by state, unknown and conflicting outcomes to reconcile from provider evidence before any retry, provider events, and checkouts needing recovery.',
  },
  {
    to: '/finance/credits',
    title: 'Refunds and credits',
    id: 'SCR-S-37',
    purpose:
      'Refunds by payment and state, each reserving the refundable amount before execution; credits with owner, currency, uses, expiry, balance and history.',
  },
  {
    to: '/finance/reconciliation',
    title: 'Reconciliation',
    id: 'SCR-S-38',
    purpose:
      'Orders, obligations, receipts, refunds, credits, fees, disputes, settlements and cash kept apart; settlement and cash records.',
  },
] as const;

export function FinanceScreen() {
  return (
    <section aria-labelledby="finance-title">
      <h2 id="finance-title">Finance</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <ul className="list" aria-label="Finance screens">
        {SCREENS.map((screen) => (
          <li key={screen.id}>
            <div className="row-text">
              <Link className="row-title" to={screen.to}>
                {screen.title}
              </Link>
              <span>{screen.purpose}</span>
              <span className="caption">{screen.id}</span>
            </div>
          </li>
        ))}
      </ul>
      <h3 id="finance-conditional">Conditional capabilities</h3>
      <ul className="list" aria-labelledby="finance-conditional">
        {CONDITIONAL.map((screen) => (
          <li key={screen.id}>
            <div className="row-text">
              <Link className="row-title" to={screen.path}>
                {screen.title}
              </Link>
              <span>{screen.purpose}</span>
              <span className="caption">{screen.id}, used only when turned on (DEC-016)</span>
            </div>
          </li>
        ))}
      </ul>
      <StateView
        variant="pending-decision"
        subject={PENDING.accounting.subject}
        decisions={PENDING.accounting.ids}
        owner={PENDING.accounting.owner}
      />
    </section>
  );
}
