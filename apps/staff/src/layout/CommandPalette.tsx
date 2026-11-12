/**
 * Quick navigation (SPK-UX-005, SPK-UX-010): one field that opens any screen the viewer's areas
 * hold, switches the facility they work in, turns Legends mode on or off, or signs out. Opened
 * from the header ("Jump to"), with Ctrl+K or Command+K anywhere, or "/" outside a field.
 *
 * What it offers follows `GET /v1/me/permissions` exactly as the sidebar does (an area the API
 * does not list is not offered, nor are its screens); the workspace is always offered. It decides
 * nothing: the screen it opens renders what the API answers.
 *
 * Keyboard (SPK-UX-009): a modal dialog holding a combobox and its listbox. Focus stays in the
 * field; Up and Down move through the options (`aria-activedescendant`), Home and End jump, Enter
 * opens, Escape closes and focus returns to where it was. Each option is also a pointer target.
 *
 * States (SPK-UX-008): while the areas load only the workspace and the actions are offered and
 * the dialog says so; a query that matches nothing says so and suggests an area name.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { usePermissions } from '../api/permissions';
import {
  DESTINATIONS,
  destinationFor,
  scoreDestination,
  type Destination,
} from '../navigation/destinations';
import { useApp } from '../providers/AppProviders';
import type { PreferenceStore } from '../providers/preferences';
import { useTheme } from '../theme/ThemeProvider';
import { Glass } from '../ui/glass/Glass';
import { Icon, type IconName } from '../ui/Icon';
import { facilityLabel, useFacilityChoices } from './FacilitySwitcher';
import './command-palette.css';

const RECENT_KEY = 'sportspark.recent';
const RECENT_LIMIT = 5;
const RESULT_LIMIT = 12;

/** Paths of the screens opened most recently in this browser, newest first. */
export function readRecent(store: PreferenceStore): string[] {
  try {
    const parsed: unknown = JSON.parse(store.get(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Remembers the screen a path is in (not the record: paths with ids are never stored). */
export function rememberRecent(store: PreferenceStore, pathname: string): void {
  const destination = destinationFor(pathname);
  if (!destination) return;
  const next = [destination.path, ...readRecent(store).filter((p) => p !== destination.path)];
  store.set(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_LIMIT)));
}

interface PaletteItem {
  id: string;
  title: string;
  context: string;
  icon: IconName;
  keywords?: string;
  kind: 'screen' | 'action';
  run(): void;
}

interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

export function CommandPalette({
  onClose,
  rail,
  onToggleRail,
}: {
  onClose(): void;
  rail: boolean;
  onToggleRail(): void;
}) {
  const { signOut, facilityId, setFacilityId, preferences } = useApp();
  const { legends, toggleLegends } = useTheme();
  const permissions = usePermissions();
  const facilities = useFacilityChoices();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const areasKnown = permissions.data !== undefined;

  // Focus the field on open; give focus back to what had it on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const groups = useMemo<PaletteGroup[]>(() => {
    const go = (path: string) => () => navigate(path);
    const screenItem = (d: Destination): PaletteItem => ({
      id: `screen:${d.path}`,
      title: d.title,
      context: d.context,
      icon: d.icon,
      keywords: d.keywords,
      kind: 'screen',
      run: go(d.path),
    });
    const offered = DESTINATIONS.filter(
      (d) => d.area === null || permissions.isAreaVisible(d.area) === true,
    );
    const actions: PaletteItem[] = [
      {
        id: 'action:legends',
        title: legends ? 'Turn off Legends mode' : 'Turn on Legends mode',
        context: 'Appearance',
        icon: 'crown',
        keywords: 'dark night gold theme light colours legends mode',
        kind: 'action',
        run: toggleLegends,
      },
      ...(facilities.isStaff && facilities.options.length > 1
        ? [
            ...(facilityId !== null
              ? [
                  {
                    id: 'action:facility:all',
                    title:
                      facilities.scoped.length > 0
                        ? 'Work in all my facilities'
                        : 'Work in all facilities',
                    context: 'Facility',
                    icon: 'location_on' as const,
                    keywords: 'switch facility',
                    kind: 'action' as const,
                    run: () => setFacilityId(null),
                  },
                ]
              : []),
            ...facilities.options
              .filter((id) => id !== facilityId)
              .map((id): PaletteItem => ({
                id: `action:facility:${id}`,
                title: `Work in ${facilityLabel(id, facilities.names)}`,
                context: 'Facility',
                icon: 'location_on',
                keywords: 'switch facility',
                kind: 'action',
                run: () => setFacilityId(id),
              })),
          ]
        : []),
      {
        id: 'action:rail',
        title: rail ? 'Expand the sidebar' : 'Collapse the sidebar',
        context: 'Layout',
        icon: 'menu',
        keywords: 'navigation menu rail wide narrow',
        kind: 'action',
        run: onToggleRail,
      },
      {
        id: 'action:sign-out',
        title: 'Sign out',
        context: 'Session',
        icon: 'logout',
        keywords: 'log out leave',
        kind: 'action',
        run: () => void signOut(),
      },
    ];

    const trimmed = query.trim();
    if (trimmed === '') {
      // Not the screen being shown, nor the area it is in (an area's home often opens a screen).
      const here = location.pathname;
      const recent = readRecent(preferences)
        .filter((path) => here !== path && !here.startsWith(`${path}/`))
        .map((path) => offered.find((d) => d.path === path))
        .filter((d): d is Destination => d !== undefined)
        .slice(0, 4)
        .map(screenItem);
      const recentIds = new Set(recent.map((item) => item.id));
      // Before anything is typed: the areas and the workspace home.
      const places = offered
        .filter((d) => d.top)
        .map(screenItem)
        .filter((item) => !recentIds.has(item.id));
      return [
        { label: 'Recent', items: recent },
        { label: 'Go to', items: places },
        { label: 'Actions', items: actions },
      ].filter((group) => group.items.length > 0);
    }
    const scored = [...offered.map(screenItem), ...actions]
      .map((item, index) => ({ item, index, score: scoreDestination(item, trimmed) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, RESULT_LIMIT)
      .map((entry) => entry.item);
    return scored.length > 0 ? [{ label: 'Results', items: scored }] : [];
  }, [
    query,
    permissions,
    legends,
    toggleLegends,
    facilities,
    facilityId,
    setFacilityId,
    rail,
    onToggleRail,
    signOut,
    navigate,
    location.pathname,
    preferences,
  ]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const activeIndex = Math.min(active, Math.max(flat.length - 1, 0));

  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, flat]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(flat.length === 0 ? 0 : (activeIndex + 1) % flat.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(flat.length === 0 ? 0 : (activeIndex - 1 + flat.length) % flat.length);
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(Math.max(flat.length - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        run(flat[activeIndex]);
        break;
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
      case 'Tab':
        // One focus stop: the field. The options are reached with the arrow keys.
        event.preventDefault();
        break;
    }
  };

  let index = -1;
  return (
    <div className="palette-layer" data-testid="quick-navigation">
      <div className="palette-dim" onClick={onClose} />
      <div
        className="palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Quick navigation"
        onKeyDown={onKeyDown}
      >
        <Glass
          className="palette"
          contentClassName="palette-content"
          material="frost"
          radius={26}
          blur={16}
          squircle
        >
          <div className="palette-search">
            <Icon name="search" size={20} />
            <input
              ref={inputRef}
              role="combobox"
              aria-label="Search screens and actions"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat.length > 0 ? optionId(activeIndex) : undefined}
              placeholder="Where to? Type a screen or an action"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
            />
            <kbd>Esc</kbd>
          </div>
          <div
            className="palette-list"
            id={listId}
            role="listbox"
            aria-label="Results"
            ref={listRef}
          >
            {groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <div className="palette-group-label" aria-hidden="true">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  index += 1;
                  const at = index;
                  const selected = at === activeIndex;
                  return (
                    <div
                      key={item.id}
                      id={optionId(at)}
                      role="option"
                      aria-selected={selected}
                      data-active={selected}
                      className="palette-option"
                      onMouseMove={() => setActive(at)}
                      onClick={() => run(item)}
                    >
                      <span className="palette-option-icon" aria-hidden="true">
                        <Icon name={item.icon} size={18} />
                      </span>
                      <span className="palette-option-text">
                        <span className="palette-option-title">{item.title}</span>
                        <span className="palette-option-context">{item.context}</span>
                      </span>
                      <span className="palette-option-hint" aria-hidden="true">
                        {item.kind === 'action' ? 'Action' : 'Open'}
                        <Icon name="keyboard_arrow_right" size={16} />
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {flat.length === 0 ? (
            <p className="palette-empty" role="status">
              Nothing matches “{query.trim()}”. Try an area name, such as Schedule or Finance.
            </p>
          ) : null}
          {!areasKnown ? (
            <p className="palette-note" role="status">
              Your areas are still loading: their screens appear here once they have.
            </p>
          ) : null}
          <div className="palette-foot" aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> to move
            </span>
            <span>
              <kbd>Enter</kbd> to open
            </span>
            <span>
              <kbd>Esc</kbd> to close
            </span>
          </div>
        </Glass>
      </div>
    </div>
  );
}
