/**
 * Section navigation inside an area (SPK-UX-005): a labelled list of links, the current one marked
 * with `aria-current` by React Router and a visible border (not colour alone, SPK-UX-009).
 */
import { NavLink } from 'react-router';

export interface SubNavItem {
  to: string;
  label: string;
}

export function SubNav({ label, items }: { label: string; items: readonly SubNavItem[] }) {
  return (
    <nav aria-label={label} className="sub-nav">
      <ul>
        {items.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to}>{item.label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
