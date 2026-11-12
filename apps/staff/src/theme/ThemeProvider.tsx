/**
 * Theme of the dashboard (SPK-UX-010 visual system): "classic" (day: desert sand and pitch green)
 * and "legends" (Legends mode: night black with a gold accent). The choice is the viewer's, kept
 * in this browser only (`providers/preferences`, never sent to the API: it is a display
 * preference, not a record) and applied as `data-theme` on the document element, where the stylesheets read it.
 * `public/theme-init.js` applies the stored choice before the first paint.
 *
 * Colour never carries a status alone in either theme (SPK-UX-009): both keep every glyph and
 * label, and Legends mode meets the same contrast floor (4.5:1 text, 3:1 glyphs).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { memoryPreferences, type PreferenceStore } from '../providers/preferences';

export type ThemeName = 'classic' | 'legends';

export const THEME_STORAGE_KEY = 'sportspark.theme';

/** The browser chrome colour (address bar on phones) of each theme. */
const THEME_COLOR: Record<ThemeName, string> = { classic: '#f3f2ec', legends: '#0a0907' };

export interface ThemeContextValue {
  theme: ThemeName;
  legends: boolean;
  setTheme(theme: ThemeName): void;
  toggleLegends(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  if (theme === 'legends') root.setAttribute('data-theme', 'legends');
  else root.removeAttribute('data-theme');
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[theme];
}

function stored(store: PreferenceStore): ThemeName {
  return store.get(THEME_STORAGE_KEY) === 'legends' ? 'legends' : 'classic';
}

export function ThemeProvider({
  store,
  children,
}: {
  store?: PreferenceStore;
  children: ReactNode;
}) {
  const themeStore = useMemo(() => store ?? memoryPreferences(), [store]);
  const [theme, setThemeState] = useState<ThemeName>(() => stored(themeStore));

  useEffect(() => applyTheme(theme), [theme]);

  const setTheme = useCallback(
    (next: ThemeName) => {
      themeStore.set(THEME_STORAGE_KEY, next === 'legends' ? next : null);
      setThemeState(next);
    },
    [themeStore],
  );
  const toggleLegends = useCallback(() => {
    setTheme(theme === 'legends' ? 'classic' : 'legends');
  }, [theme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, legends: theme === 'legends', setTheme, toggleLegends }),
    [theme, setTheme, toggleLegends],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The theme and its controls. A view rendered on its own, outside the provider (a component
 * test), reads the classic theme and its controls do nothing.
 */
export function useTheme(): ThemeContextValue {
  return (
    useContext(ThemeContext) ?? {
      theme: 'classic',
      legends: false,
      setTheme: () => undefined,
      toggleLegends: () => undefined,
    }
  );
}
