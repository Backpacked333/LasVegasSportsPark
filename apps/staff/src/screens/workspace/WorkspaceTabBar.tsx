/**
 * Phone bottom tab bar for the coach and referee workspace (SPK-UX-007 phone-first beside a field;
 * SPK-UX-009 each tab is a link with an icon and a written label, the current one marked with
 * `aria-current`). Shown only on workspace pages and, by its stylesheet, only at phone width; the
 * workspace's own tabs stay for wider screens and keyboard users. Every tab is an existing
 * workspace screen: nothing here decides what the viewer may do.
 */
import { NavLink, useLocation } from 'react-router';
import { WORKSPACE_PATH } from '../../navigation/areas';
import { Icon, type IconName } from '../../ui/Icon';
import './workspace.css';

const TABS: readonly { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: WORKSPACE_PATH, label: 'Now', icon: 'stadium', end: true },
  { to: `${WORKSPACE_PATH}/assessments`, label: 'Assess', icon: 'checklist' },
  { to: `${WORKSPACE_PATH}/fees`, label: 'Fees', icon: 'payments' },
  { to: `${WORKSPACE_PATH}/report-problem`, label: 'Issues', icon: 'construction' },
  { to: `${WORKSPACE_PATH}/offline`, label: 'Queue', icon: 'sync' },
];

export function WorkspaceTabBar() {
  const { pathname } = useLocation();
  if (pathname !== WORKSPACE_PATH && !pathname.startsWith(`${WORKSPACE_PATH}/`)) return null;
  return (
    <nav className="ws-tabbar" aria-label="Workspace tabs">
      <ul>
        {TABS.map((tab) => (
          <li key={tab.to}>
            <NavLink to={tab.to} end={tab.end} className="ws-tab">
              {({ isActive }) => (
                <>
                  <Icon name={tab.icon} size={22} filled={isActive} />
                  <span>{tab.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
