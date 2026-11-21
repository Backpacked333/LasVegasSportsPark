/**
 * SCR-S-01 shell. Chrome floats as liquid glass above the page (`ui/glass`):
 *
 * - the sidebar, a frosted panel over a soft field of colour: the SPK-UX-005 areas the API lists for this
 *   principal (`GET /v1/me/permissions`, AreaNav) grouped by job, Today as the operating home, the
 *   coach and referee workspace link (SPK-UX-007) and the signed-in person. On wide screens it
 *   collapses to an icon rail (remembered in this browser); below 900 px it is a drawer over a
 *   modal drawer over a scrim: focus moves into it and stays there, Escape, "Close menu", the
 *   scrim or a route change closes it and focus returns to Menu (SPK-UX-009);
 * - the header groups, over the content scrolling beneath: the facility switcher, quick
 *   navigation ("Jump to", Ctrl+K or Command+K, or "/"; `CommandPalette`), the live or offline
 *   indicator and the Legends mode switch (`theme/`). While quick navigation is open the rest of
 *   the page is inert: it is a modal dialog.
 *
 * A skip link and visible focus serve keyboard users (SPK-UX-009). Feedback for speed (SPK-UX-008
 * "processing"): a thin line at the top of the window while any read is in flight, each page
 * starts at its top, and the browser tab is titled with the screen it shows.
 *
 * Redesign handoff (staff shell, BUILD_PLAN Phase 4):
 * - one responsive shell: the expanded glass sidebar on desktops (1280 px and up), the 84 px icon
 *   rail on desk tablets (601-1279 px; S 1b, S 2a), and under 600 px a floating glass tab bar
 *   (`PhoneTabBar`, S 1d) with everything else in the Menu drawer. A choice made with the
 *   collapse button is remembered and wins over the automatic one;
 * - the facility switcher is hidden when the viewer works at a single facility;
 * - "Live · 8:46 AM" is the facility's local time (SPK-SCHED-008);
 * - G then T, S, R or A goes to Today, Schedule, Registrations or Arrival (`useGoShortcuts`);
 * - the rail foot is the account menu (`UserMenu`: Profile, the shared-tablet lock, Switch user,
 *   Sign out) and rail items carry badges, which screens on this device can feed
 *   (`RailBadges`);
 * - toasts (`ui/Toast`) and the shared desk tablet lock (`lock/`, S 3h) live here, so they
 *   survive navigation.
 */
import { useIsFetching } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useFacilityDirectory } from '../api/facility-directory';
import { usePermissions } from '../api/permissions';
import { ConnectivityBanner } from '../connectivity/ConnectivityBanner';
import { DemoBar, TourPanel } from '../demo';
import { OfflineQueueProvider } from '../features/operations/offline/OfflineQueueProvider';
import { WORKSPACE_PATH } from '../navigation/areas';
import { destinationFor } from '../navigation/destinations';
import { useApp, useNow } from '../providers/AppProviders';
import { WorkspaceTabBar } from '../screens/workspace/WorkspaceTabBar';
import { LegendsToggle } from '../theme/LegendsToggle';
import { Glass } from '../ui/glass/Glass';
import { Icon } from '../ui/Icon';
import { ToastProvider } from '../ui/Toast';
import { UpdateRequiredNotice } from '../ui/UpdateRequiredNotice';
import { AreaNav } from './AreaNav';
import { CommandPalette, rememberRecent } from './CommandPalette';
import { FacilitySwitcher, useFacilityChoices } from './FacilitySwitcher';
import { LockProvider, useLock } from './lock/LockProvider';
import { LockScreen } from './lock/LockScreen';
import { PhoneTabBar } from './PhoneTabBar';
import { RailBadgeProvider } from './RailBadges';
import { QueuedCheckinRailBadge } from '../features/operations/offline/deskCheckins';
import { useGoShortcuts } from './useGoShortcuts';
import { PHONE_QUERY, TABLET_QUERY, useMediaQuery } from './useMediaQuery';
import { UserMenu } from './UserMenu';
import './shell.css';
import '../ui/primitives.css';

const RAIL_KEY = 'sportspark.sidebar';

const DRAWER_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

/** The time zone of the facility the viewer works in (the first of their scope when "all"). */
function useFacilityZone(): string | undefined {
  const { facilityId, session } = useApp();
  const { options } = useFacilityChoices();
  const directory = useFacilityDirectory(session.status === 'signed_in');
  const id = facilityId ?? options[0];
  return directory.data?.items.find((f) => f.id === id)?.timezone;
}

/** Live with the facility's local time, or offline, as text and glyph (SPK-UX-009). */
function LiveIndicator() {
  const { online } = useApp();
  const now = useNow();
  const timeZone = useFacilityZone();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone });
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

/** The stored sidebar choice: collapsed, expanded, or (null) automatic by screen width. */
function storedRail(value: string | null): boolean | null {
  return value === 'rail' ? true : value === 'expanded' ? false : null;
}

export function Shell() {
  const { updateRequired } = useApp();
  if (updateRequired) return <UpdateRequiredNotice error={updateRequired} />;
  return (
    // One offline queue for the signed-in dashboard: it synchronises on reconnection wherever the
    // viewer is (§4.15, SPK-AT-018). Badges, toasts and the lock outlive a page.
    <RailBadgeProvider>
      <OfflineQueueProvider>
        <QueuedCheckinRailBadge />
        <ToastProvider>
          <LockProvider>
            <ShellFrame />
          </LockProvider>
        </ToastProvider>
      </OfflineQueueProvider>
    </RailBadgeProvider>
  );
}

function ShellFrame() {
  const { preferences } = useApp();
  const permissions = usePermissions();
  const lock = useLock();
  const locked = lock?.state.locked === true && lock.hasPin;
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [railChoice, setRailChoice] = useState(() => storedRail(preferences.get(RAIL_KEY)));
  const tablet = useMediaQuery(TABLET_QUERY);
  const rail = railChoice ?? tablet;
  const { options: facilityOptions } = useFacilityChoices();
  const showSwitcher = facilityOptions.length > 1;
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const wasMenuOpen = useRef(false);
  const focusSidebarAfterResize = useRef(false);
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

  // The collapse button sets the opposite of what is shown; going back to what the width would
  // choose by itself forgets the choice.
  const toggleRail = useCallback(() => {
    const next = !rail;
    const choice = next === tablet ? null : next;
    preferences.set(RAIL_KEY, choice === null ? null : choice ? 'rail' : 'expanded');
    setRailChoice(choice);
  }, [preferences, rail, tablet]);

  // G then T / S / R / A (not while typing, not while locked or in a dialog).
  useGoShortcuts(
    (area) => permissions.isAreaVisible(area as never) === true,
    !locked && !paletteOpen && !menuOpen,
  );

  // Quick navigation from anywhere: Ctrl+K or Command+K; "/" when not typing.
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // SPK-UX-009: keep focus in the modal drawer and return it to Menu when dismissed.
  useEffect(() => {
    if (menuOpen) {
      wasMenuOpen.current = true;
      drawerRef.current?.querySelector<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR)?.focus();
    } else if (wasMenuOpen.current) {
      wasMenuOpen.current = false;
      if (focusSidebarAfterResize.current) {
        focusSidebarAfterResize.current = false;
        drawerRef.current?.querySelector<HTMLElement>('.brand')?.focus();
      } else {
        menuButtonRef.current?.focus();
      }
    }
  }, [menuOpen]);

  // Keep the modal state aligned with the sidebar's 600 px CSS breakpoint.
  useEffect(() => {
    if (!menuOpen || typeof window.matchMedia !== 'function') return;
    const narrowViewport = window.matchMedia(PHONE_QUERY);
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (!event.matches) {
        focusSidebarAfterResize.current = true;
        setMenuOpen(false);
      }
    };

    if (!narrowViewport.matches) {
      focusSidebarAfterResize.current = true;
      setMenuOpen(false);
      return;
    }

    narrowViewport.addEventListener('change', closeOnDesktop);
    return () => narrowViewport.removeEventListener('change', closeOnDesktop);
  }, [menuOpen]);

  const handleDrawerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;

    const drawer = drawerRef.current;
    if (!drawer) return;
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      drawer.focus();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (activeIndex === -1) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && activeIndex === 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
      event.preventDefault();
      first.focus();
    }
  };

  const close = () => setMenuOpen(false);
  return (
    <>
      <div className="shell" data-rail={rail} inert={locked} aria-hidden={locked || undefined}>
        <a className="skip-link" href="#main" inert={menuOpen}>
          Skip to main content
        </a>
        <RouteProgress />
        {menuOpen ? <div className="shell-scrim" onClick={close} /> : null}
        <aside
          ref={drawerRef}
          className="shell-side"
          data-open={menuOpen}
          inert={paletteOpen}
          role={menuOpen ? 'dialog' : undefined}
          aria-modal={menuOpen || undefined}
          aria-label={menuOpen ? 'Staff navigation' : undefined}
          tabIndex={menuOpen ? -1 : undefined}
          onKeyDown={menuOpen ? handleDrawerKeyDown : undefined}
        >
          <div className="shell-side-art" aria-hidden="true" />
          <Glass
            className="shell-side-glass"
            contentClassName="shell-side-inner"
            material="frost"
            radius={26}
            blur={14}
            squircle
          >
            {menuOpen ? (
              <button type="button" className="side-close" onClick={() => setMenuOpen(false)}>
                <Icon name="close" size={16} />
                Close menu
              </button>
            ) : null}
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
              <UserMenu />
            </div>
          </Glass>
        </aside>
        <div className="shell-body" inert={menuOpen || paletteOpen}>
          {DemoBar ? (
            <Suspense fallback={null}>
              <DemoBar />
            </Suspense>
          ) : null}
          <header className="shell-header">
            <h1 className="visually-hidden">Sportspark staff</h1>
            <Glass
              className={`header-group header-group-main${showSwitcher ? '' : ' header-group-bare'}`}
              radius={23}
              blur={5}
            >
              <button
                type="button"
                className="header-button menu-button"
                aria-expanded={menuOpen}
                aria-controls="main-nav"
                onClick={(event) => {
                  menuButtonRef.current = event.currentTarget;
                  setMenuOpen((open) => !open);
                }}
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
                <span className="jump-label">Jump to a person, team, booking…</span>
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
          <PhoneTabBar />
        </div>
        {paletteOpen ? (
          <CommandPalette onClose={closePalette} rail={rail} onToggleRail={toggleRail} />
        ) : null}
        {TourPanel ? (
          <Suspense fallback={null}>
            <TourPanel />
          </Suspense>
        ) : null}
      </div>
      {locked && lock ? <LockScreen lock={lock} /> : null}
    </>
  );
}
