/**
 * Screen links inside one navigation area (SPK-UX-005), as a labelled nav with `aria-current` on
 * the current screen (SPK-UX-009 keyboard navigation; the current screen is marked by weight and a
 * border, not colour alone).
 */
import { NavLink } from 'react-router';

export interface AreaTab {
  path: string;
  title: string;
  /** Match the path exactly (an area's index screen). */
  end?: boolean;
}

export function AreaTabs({ label, tabs }: { label: string; tabs: readonly AreaTab[] }) {
  return (
    <nav className="ops-tabs" aria-label={label}>
      <ul>
        {tabs.map((tab) => (
          <li key={tab.path}>
            <NavLink to={tab.path} end={tab.end}>
              {tab.title}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export const ARRIVAL_TABS: readonly AreaTab[] = [
  { path: '/arrival', title: 'Arrival scanner', end: true },
  { path: '/arrival/attendance', title: 'Session attendance' },
  { path: '/arrival/release', title: 'Supervised release' },
  { path: '/arrival/offline', title: 'Offline queue' },
];

export const STAFF_TABS: readonly AreaTab[] = [
  { path: '/staff', title: 'Assignments and replacement', end: true },
  { path: '/staff/availability', title: 'Availability and qualifications' },
  { path: '/staff/fees', title: 'Fee and hours approvals' },
];

export const COMMUNICATIONS_TABS: readonly AreaTab[] = [
  { path: '/communications', title: 'Delivery status', end: true },
  { path: '/communications/compose', title: 'Compose a message' },
];

export const WORKSPACE_TABS: readonly AreaTab[] = [
  { path: '/workspace', title: 'My assignments', end: true },
  { path: '/workspace/fees', title: 'Hours and fees' },
  { path: '/workspace/assessments', title: 'Assessments' },
];
