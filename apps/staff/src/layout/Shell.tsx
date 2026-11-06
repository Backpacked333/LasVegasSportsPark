/**
 * SCR-S-01 shell: a "night pitch" sidebar with the SPK-UX-005 areas the API lists for this
 * principal (`GET /v1/me/permissions`, AreaNav) grouped by job, Today as the operating home, the
 * coach and referee workspace link (SPK-UX-007) and the signed-in person; a sticky header with the
 * facility switcher and the live/offline indicator; and the connectivity banner. Responsive: below
 * 900 px the sidebar collapses behind a menu button so the workspace works on a phone beside a
 * field. A skip link and visible focus serve keyboard users (SPK-UX-009).
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useApiQuery } from '../api/useApiQuery';
import { ConnectivityBanner } from '../connectivity/ConnectivityBanner';
import { OfflineQueueProvider } from '../features/operations/offline/OfflineQueueProvider';
import { WORKSPACE_PATH } from '../navigation/areas';
import { useApp, useNow } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { UpdateRequiredNotice } from '../ui/UpdateRequiredNotice';
import { AreaNav } from './AreaNav';
import { FacilitySwitcher } from './FacilitySwitcher';

const ROLE_LABELS: Record<string, string> = {
  front_desk: 'Front desk',
  league_manager: 'League manager',
  program_manager: 'Program manager',
  scheduler: 'Scheduler',
  finance_operator: 'Finance operator',
  facilities_operator: 'Facilities operator',
  general_manager: 'General manager',
  system_administrator: 'System administrator',
  support_operator: 'Support operator',
  coach: 'Coach',
  official: 'Official',
};

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** The signed-in person in the sidebar foot: name and first staff role from `GET /v1/me`. */
function SignedInPerson() {
  const { session, signOut } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const person = me.data?.person ?? null;
  const name = [person?.givenName, person?.familyName].filter(Boolean).join(' ') || 'Signed in';
  const role = me.data?.principal.staffRoles[0];
  return (
    <div className="side-user">
      <span className="avatar" aria-hidden="true">
        {initialsOf(name) || '•'}
      </span>
      <span className="side-user-text">
        <span className="side-user-name">{name}</span>
        <span className="side-user-role">
          {role ? (ROLE_LABELS[role] ?? role) : 'Staff dashboard'}
        </span>
      </span>
      <Button variant="secondary" className="button-sm" onClick={() => void signOut()}>
        <Icon name="logout" size={16} />
        Sign out
      </Button>
    </div>
  );
}

/** Live (online, with the facility-agnostic clock) or offline, as text and glyph (SPK-UX-009). */
function LiveIndicator() {
  const { online } = useApp();
  const now = useNow();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <span className="live-pill" data-online={online} data-testid="live-indicator">
      {online ? (
        <span className="live-dot" aria-hidden="true" />
      ) : (
        <Icon name="wifi_off" size={16} />
      )}
      {online ? `Live · ${time}` : 'Offline'}
    </span>
  );
}

export function Shell() {
  const { updateRequired } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // A route change closes the phone menu.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  if (updateRequired) return <UpdateRequiredNotice error={updateRequired} />;

  const close = () => setMenuOpen(false);
  return (
    // One offline queue for the signed-in dashboard: it synchronises on reconnection wherever the
    // viewer is (§4.15, SPK-AT-018).
    <OfflineQueueProvider>
      <div className="shell">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <aside className="shell-side" data-open={menuOpen}>
          <div className="shell-side-inner">
            <NavLink to="/today" className="brand" onClick={close} aria-label="Sportspark home">
              <span className="brand-mark" aria-hidden="true">
                <Icon name="sports_soccer" size={22} filled />
              </span>
              <span className="brand-text" aria-hidden="true">
                <span className="brand-kicker">Sportspark</span>
                <span className="brand-name">Park staff</span>
              </span>
            </NavLink>
            <nav id="main-nav" className="shell-nav" aria-label="Main" data-open={menuOpen}>
              <AreaNav onNavigate={close} />
              <div className="shell-side-foot">
                <ul aria-label="Workspace">
                  <li>
                    <NavLink to={WORKSPACE_PATH} onClick={close} className="side-link">
                      {({ isActive }) => (
                        <>
                          <Icon name="sports" filled={isActive} />
                          <span>My assignments</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                </ul>
              </div>
            </nav>
            <div className="shell-side-foot">
              <SignedInPerson />
            </div>
          </div>
        </aside>
        <div className="shell-body">
          <header className="shell-header">
            <Button
              variant="secondary"
              className="menu-button"
              aria-expanded={menuOpen}
              aria-controls="main-nav"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icon name="menu" size={18} />
              Menu
            </Button>
            <h1>Sportspark staff</h1>
            <FacilitySwitcher />
            <span className="spacer" />
            <LiveIndicator />
          </header>
          <main id="main" className="shell-main" tabIndex={-1} key={location.pathname}>
            <ConnectivityBanner />
            <Outlet />
          </main>
        </div>
      </div>
    </OfflineQueueProvider>
  );
}
