/**
 * SCR-S-01 shell. Chrome floats as liquid glass above the page (`ui/glass`):
 *
 * - the sidebar, a frosted panel over a soft field of colour: the SPK-UX-005 areas the API lists for this
 *   principal (`GET /v1/me/permissions`, AreaNav) grouped by job, Today as the operating home, the
 *   coach and referee workspace link (SPK-UX-007) and the signed-in person. On wide screens it
 *   collapses to an icon rail (remembered in this browser); below 900 px it is a drawer over a
 *   scrim that closes on Escape, on the scrim and on a route change;
 * - the header groups, over the content scrolling beneath: the facility switcher, quick
 *   navigation ("Jump to", Ctrl+K or Command+K, or "/"; `CommandPalette`), the live or offline
 *   indicator and the Legends mode switch (`theme/`). While quick navigation is open the rest of
 *   the page is inert: it is a modal dialog.
 *
 * A skip link and visible focus serve keyboard users (SPK-UX-009). Feedback for speed (SPK-UX-008
 * "processing"): a thin line at the top of the window while any read is in flight, each page
 * starts at its top, and the browser tab is titled with the screen it shows.
 */
import { useIsFetching } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useApiQuery } from '../api/useApiQuery';
import { ConnectivityBanner } from '../connectivity/ConnectivityBanner';
import { OfflineQueueProvider } from '../features/operations/offline/OfflineQueueProvider';
import { WORKSPACE_PATH } from '../navigation/areas';
import { destinationFor } from '../navigation/destinations';
import { useApp, useNow } from '../providers/AppProviders';
import { WorkspaceTabBar } from '../screens/workspace/WorkspaceTabBar';
import { LegendsToggle } from '../theme/LegendsToggle';
import { Glass } from '../ui/glass/Glass';
import { Icon } from '../ui/Icon';
import { UpdateRequiredNotice } from '../ui/UpdateRequiredNotice';
import { AreaNav } from './AreaNav';
import { CommandPalette, rememberRecent } from './CommandPalette';
import { FacilitySwitcher } from './FacilitySwitcher';
import './shell.css';

const RAIL_KEY = 'sportspark.sidebar';

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

/** "⌘K" on Apple keyboards, "Ctrl K" elsewhere. */
function shortcutLabel(): string {
  const apple =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return apple ? '⌘K' : 'Ctrl K';
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
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
      <button
        type="button"
        className="side-icon-button"
        aria-label="Sign out"
        title="Sign out"
        onClick={() => void signOut()}
      >
        <Icon name="logout" size={18} />
      </button>
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
      {online ? (
        <span>
          Live<span className="live-time"> · {time}</span>
        </span>
      ) : (
        'Offline'
      )}
    </span>
  );
}

/** Reads in flight anywhere in the dashboard: a quiet line, never a blocking overlay. */
function RouteProgress() {
  const fetching = useIsFetching();
  return <div className="route-progress" data-active={fetching > 0} aria-hidden="true" />;
}

export function Shell() {
  const { updateRequired, preferences } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [rail, setRail] = useState(() => preferences.get(RAIL_KEY) === 'rail');
  const location = useLocation();

  // A route change closes the phone menu, starts the page at its top and is remembered for
  // quick navigation's "Recent".
  useEffect(() => {
    setMenuOpen(false);
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
    rememberRecent(preferences, location.pathname);
    // The browser tab and history name the screen, not only the product.
    const screen = destinationFor(location.pathname);
    document.title = screen ? `${screen.title} · Sportspark staff` : 'Sportspark staff';
  }, [location.pathname, preferences]);

  const toggleRail = useCallback(() => {
    setRail((current) => {
      preferences.set(RAIL_KEY, current ? null : 'rail');
      return !current;
    });
  }, [preferences]);

  // Quick navigation from anywhere: Ctrl+K or Command+K; "/" when not typing. Escape closes the
  // phone menu.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isEditable(event.target)
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  if (updateRequired) return <UpdateRequiredNotice error={updateRequired} />;

  const close = () => setMenuOpen(false);
  return (
    // One offline queue for the signed-in dashboard: it synchronises on reconnection wherever the
    // viewer is (§4.15, SPK-AT-018).
    <OfflineQueueProvider>
      <div className="shell" data-rail={rail}>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <RouteProgress />
        {menuOpen ? <div className="shell-scrim" onClick={close} /> : null}
        <aside className="shell-side" data-open={menuOpen} inert={paletteOpen}>
          <div className="shell-side-art" aria-hidden="true" />
          <Glass
            className="shell-side-glass"
            contentClassName="shell-side-inner"
            material="frost"
            radius={26}
            blur={14}
            squircle
          >
            <div className="shell-side-head">
              <NavLink
                to="/today"
                className="brand"
                onClick={close}
                aria-label="Sportspark home"
                title="Sportspark home"
              >
                <span className="brand-mark" aria-hidden="true">
                  <Icon name="sports_soccer" size={22} filled />
                </span>
                <span className="brand-text" aria-hidden="true">
                  <span className="brand-kicker">Sportspark</span>
                  <span className="brand-name">Park staff</span>
                </span>
              </NavLink>
              <button
                type="button"
                className="rail-button"
                aria-pressed={rail}
                aria-label="Collapse the sidebar"
                title={rail ? 'Expand the sidebar' : 'Collapse the sidebar'}
                onClick={toggleRail}
              >
                <Icon name="chevron_left" size={20} />
              </button>
            </div>
            <nav id="main-nav" className="shell-nav" aria-label="Main" data-open={menuOpen}>
              <AreaNav onNavigate={close} />
              <div className="shell-side-foot">
                <ul aria-label="Workspace">
                  <li>
                    <NavLink
                      to={WORKSPACE_PATH}
                      onClick={close}
                      className="side-link"
                      title="My assignments"
                    >
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
          </Glass>
        </aside>
        <div className="shell-body" inert={paletteOpen}>
          <header className="shell-header">
            <h1 className="visually-hidden">Sportspark staff</h1>
            <Glass className="header-group header-group-main" radius={23} blur={5}>
              <button
                type="button"
                className="header-button menu-button"
                aria-expanded={menuOpen}
                aria-controls="main-nav"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Icon name="menu" size={18} />
                <span>Menu</span>
              </button>
              <FacilitySwitcher />
            </Glass>
            <Glass className="header-group header-group-jump" radius={23} blur={5}>
              <button
                type="button"
                className="header-button jump-button"
                aria-haspopup="dialog"
                aria-expanded={paletteOpen}
                aria-keyshortcuts="Control+K Meta+K"
                aria-label="Jump to a screen or an action"
                onClick={() => setPaletteOpen(true)}
              >
                <Icon name="search" size={18} />
                <span className="jump-label">Jump to…</span>
                <kbd aria-hidden="true">{shortcutLabel()}</kbd>
              </button>
            </Glass>
            <span className="spacer" />
            <Glass className="header-group" radius={23} blur={5}>
              <LiveIndicator />
              <span className="header-separator" aria-hidden="true" />
              <LegendsToggle />
            </Glass>
          </header>
          <main id="main" className="shell-main" tabIndex={-1} key={location.pathname}>
            <ConnectivityBanner />
            <Outlet />
          </main>
          <WorkspaceTabBar />
        </div>
        {paletteOpen ? (
          <CommandPalette onClose={closePalette} rail={rail} onToggleRail={toggleRail} />
        ) : null}
      </div>
    </OfflineQueueProvider>
  );
}
