/**
 * In-area navigation for "Programs and camps", "Registrations and waitlists" and "Finance"
 * (SPK-UX-005): a labelled list of links, the current one marked with `aria-current`, operable by
 * keyboard (SPK-UX-009).
 */
import { NavLink } from 'react-router';

export interface SectionLink {
  to: string;
  label: string;
  /** Match only this exact path (the area's home). */
  end?: boolean;
}

export function SectionNav({ label, links }: { label: string; links: readonly SectionLink[] }) {
  return (
    <nav aria-label={label} className="rf-section-nav">
      <ul>
        {links.map((link) => (
          <li key={link.to}>
            <NavLink to={link.to} end={link.end}>
              {link.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export const REGISTRATION_LINKS: readonly SectionLink[] = [
  { to: '/registrations', label: 'Overview', end: true },
  { to: '/registrations/queue', label: 'Approvals (SCR-S-24)' },
  { to: '/registrations/assisted', label: 'Assisted registration (SCR-S-25)' },
  { to: '/registrations/waitlists', label: 'Waitlists (SCR-S-26)' },
  { to: '/registrations/enrollments', label: 'Cancellations and transfers (SCR-S-27)' },
];

export const FINANCE_LINKS: readonly SectionLink[] = [
  { to: '/finance', label: 'Overview', end: true },
  { to: '/finance/obligations', label: 'Obligations and orders (SCR-S-35)' },
  { to: '/finance/payments', label: 'Payment attempts (SCR-S-36)' },
  { to: '/finance/credits', label: 'Refunds and credits (SCR-S-37)' },
  { to: '/finance/reconciliation', label: 'Reconciliation (SCR-S-38)' },
  // Conditional Package G screens (src/screens/package-g/), behind their capability switches.
  { to: '/finance/memberships', label: 'Memberships (SCR-S-53)' },
  { to: '/finance/session-packages', label: 'Session packages (SCR-S-54)' },
  { to: '/finance/point-of-sale', label: 'Point of sale (SCR-S-55)' },
  { to: '/finance/accounting-exports', label: 'Accounting export batches (SCR-S-57)' },
];
