/**
 * SCR-S-01 shell: header with the facility switcher, the SPK-UX-005 areas the API lists for this
 * principal (`GET /v1/me/permissions`, AreaNav) with Today as the operating home, the coach and
 * referee workspace link (SPK-UX-007), and the connectivity banner. Responsive: below 768 px the
 * navigation collapses behind a menu button so the workspace works on a phone beside a field. A
 * skip link and visible focus serve keyboard users (SPK-UX-009).
 */
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ConnectivityBanner } from '../connectivity/ConnectivityBanner';
import { OfflineQueueProvider } from '../features/operations/offline/OfflineQueueProvider';
import { WORKSPACE_PATH } from '../navigation/areas';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { UpdateRequiredNotice } from '../ui/UpdateRequiredNotice';
import { AreaNav } from './AreaNav';
import { FacilitySwitcher } from './FacilitySwitcher';

export function Shell() {
  const { signOut, updateRequired } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  if (updateRequired) return <UpdateRequiredNotice error={updateRequired} />;

  return (
    // One offline queue for the signed-in dashboard: it synchronises on reconnection wherever the
    // viewer is (§4.15, SPK-AT-018).
    <OfflineQueueProvider>
      <div className="shell">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="shell-header">
          <Button
            variant="secondary"
            className="menu-button"
            aria-expanded={menuOpen}
            aria-controls="main-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </Button>
          <h1>Sportspark staff</h1>
          <FacilitySwitcher />
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </header>
        <nav id="main-nav" className="shell-nav" aria-label="Main" data-open={menuOpen}>
          <AreaNav onNavigate={() => setMenuOpen(false)} />
          <ul aria-label="Workspace">
            <li>
              <NavLink to={WORKSPACE_PATH} onClick={() => setMenuOpen(false)}>
                My assignments
              </NavLink>
            </li>
          </ul>
        </nav>
        <main id="main" className="shell-main" tabIndex={-1} key={location.pathname}>
          <ConnectivityBanner />
          <Outlet />
        </main>
      </div>
    </OfflineQueueProvider>
  );
}
