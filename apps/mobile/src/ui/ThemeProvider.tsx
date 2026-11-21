/**
 * Provides the theme in use (classic, or Legends mode: night green with floodlight accents, handoff
 * M 5d) to every screen and keeps the choice between launches (`ThemePreferenceStore`). Switching
 * re-renders the app in the other theme at once: stylesheets come from `makeStyles`, navigation
 * chrome reads `useTheme`.
 *
 * Until the person makes a choice (nothing stored), the theme follows the phone's dark mode
 * (handoff 5d: "The theme follows the switch in You, or can follow the phone's dark mode"): dark
 * appearance gives Legends mode, light gives classic, and a change of the device setting while the
 * app runs switches with it. Once the You switch is used, its choice wins and is kept.
 *
 * System-drawn parts follow the theme too: the status bar content, and through React Native's
 * `Appearance` the keyboard, alerts and pickers. While the theme follows the device, the app does
 * not override the device's appearance (so a later change of the setting is still heard).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, StatusBar, useColorScheme } from 'react-native';
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
  const [choice, setChoice] = useState<ThemeName | null>(() => store?.read() ?? null);
  const device = useColorScheme();
  const name: ThemeName = choice ?? (device === 'dark' ? 'legends' : 'classic');
  const theme = THEMES[name];

  const setLegends = useCallback(
    (on: boolean) => {
      const next: ThemeName = on ? 'legends' : 'classic';
      setChoice(next);
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
      Appearance.setColorScheme(choice === null ? 'unspecified' : theme.dark ? 'dark' : 'light');
    }
  }, [theme.dark, choice]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, legends: name === 'legends', setLegends }),
    [theme, name, setLegends],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
