/**
 * Phone bottom tab bar for the coach and referee workspace (SPK-UX-007 phone-first beside a field;
 * SPK-UX-009 each tab is a link with an icon and a written label, the current one marked with
 * `aria-current`). Shown only on workspace pages and, by its stylesheet, only at phone width; the
 * workspace's own tabs stay for wider screens and keyboard users. Every tab is an existing
 * workspace screen: nothing here decides what the viewer may do.
 *
 * The bar is a liquid glass capsule floating above the page that scrolls beneath it (`ui/glass`);
 * its tabs are flat, the current one a tinted pill with a filled glyph and heavier text.
 */
import { Link, useLocation } from 'react-router';
import { WORKSPACE_PATH } from '../../navigation/areas';
import { Glass } from '../../ui/glass/Glass';
import { Icon } from '../../ui/Icon';
import { isFullScreenWorkspacePath, isTabCurrent } from './workspace-tabs';
// Phase 8: the coach, referee and field crew each get their own tabs (crew/workspace-kind.ts).
import { useWorkspaceTabs } from '../crew/workspace-kind';
import './workspace.css';

export function WorkspaceTabBar() {
  const { pathname } = useLocation();
  const TABS = useWorkspaceTabs();
  if (pathname !== WORKSPACE_PATH && !pathname.startsWith(`${WORKSPACE_PATH}/`)) return null;
  if (isFullScreenWorkspacePath(pathname)) return null;
  return (
    <nav className="ws-tabbar" aria-label="Workspace tabs">
      <Glass radius={32} blur={5}>
        <ul>
          {TABS.map((tab) => (
            <li key={tab.to}>
              <Link
                to={tab.to}
                className={isTabCurrent(tab, pathname) ? 'ws-tab active' : 'ws-tab'}
                aria-current={isTabCurrent(tab, pathname) ? 'page' : undefined}
              >
                <Icon name={tab.icon} size={22} filled={isTabCurrent(tab, pathname)} />
                <span>{tab.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Glass>
    </nav>
  );
}
