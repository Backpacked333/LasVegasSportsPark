/**
 * Provides the theme in use (classic, or Legends mode: dark with a gold accent) to every screen
 * and keeps the choice between launches (`ThemePreferenceStore`). Switching re-renders the app in
 * the other theme at once: stylesheets come from `makeStyles`, navigation chrome reads `useTheme`.
 *
 * System-drawn parts follow the theme too: the status bar content, and through React Native's
 * `Appearance` the keyboard, alerts and pickers (dark in Legends mode, light in classic, whatever
 * the device setting, since each theme is a complete look of its own).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, StatusBar } from 'react-native';
import { THEMES, ThemeContext, type ThemeContextValue, type ThemeName } from './theme';
import type { ThemePreferenceStore } from './theme-preference';

export function ThemeProvider({
  store,
  children,
}: {
  /** Absent: the choice lasts until the app closes. */
  store?: ThemePreferenceStore;
  children: ReactNode;
}) {
  const [name, setName] = useState<ThemeName>(() => store?.read() ?? 'classic');
  const theme = THEMES[name];

  const setLegends = useCallback(
    (on: boolean) => {
      const next: ThemeName = on ? 'legends' : 'classic';
      setName(next);
      store?.write(next);
    },
    [store],
  );

  useEffect(() => {
    // Set directly rather than with a <StatusBar> element: the element batches its updates on a
    // timer of its own, which this app has no use for.
    StatusBar.setBarStyle(theme.dark ? 'light-content' : 'dark-content');
    // Not every host implements it (older runtimes, some test environments).
    if (typeof Appearance.setColorScheme === 'function') {
      Appearance.setColorScheme(theme.dark ? 'dark' : 'light');
    }
  }, [theme.dark]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, legends: name === 'legends', setLegends }),
    [theme, name, setLegends],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
