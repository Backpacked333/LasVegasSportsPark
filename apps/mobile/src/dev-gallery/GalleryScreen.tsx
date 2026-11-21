/**
 * Design system gallery (development builds only, ADR-008): every component of `src/ui` in its
 * main states, on one screen, in the classic or the Legends theme. It is the first screenshot
 * target of `scripts/screenshots.mjs`, so a change to the visual system can be judged before and
 * after on one page.
 *
 * The theme switch at the top is local to the gallery: it provides the other theme to the
 * gallery's own subtree (`ThemeContext`) and leaves the app's stored choice, the stack header and
 * the system appearance as they are. It starts in the theme the app is in.
 *
 * Reached only through `src/dev-gallery/index.ts` (a `__DEV__` conditional require), never
 * imported directly, so release bundles leave it out.
 */
import { Stack } from 'expo-router';
import { useContext, useEffect, useMemo, useState } from 'react';
import { IconButton } from '../ui/IconButton';
import { Screen } from '../ui/Screen';
import { SegmentedControl } from '../ui/SegmentedControl';
import {
  layout,
  spacing,
  THEMES,
  ThemeContext,
  type ThemeContextValue,
  type ThemeName,
} from '../ui/theme';
import { useToast } from '../ui/Toast';
import { ActionSpecimens } from './specimens-actions';
import { HouseholdSpecimens } from './specimens-household';
import { InputSpecimens } from './specimens-inputs';
import { StateSpecimens } from './specimens-states';
import { SurfaceSpecimens } from './specimens-surfaces';

export const GALLERY_TITLE = 'Design system gallery';

const THEME_SEGMENTS = [
  { value: 'classic', label: 'Classic', accessibilityLabel: 'Classic theme' },
  { value: 'legends', label: 'Legends', accessibilityLabel: 'Legends theme' },
] as const;

/** How long the pretend refresh of the gallery spins. */
const REFRESH_MS = 800;

export function GalleryScreen() {
  const app = useContext(ThemeContext);
  const [name, setName] = useState<ThemeName>(app.legends ? 'legends' : 'classic');
  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: THEMES[name],
      legends: name === 'legends',
      setLegends: (on) => setName(on ? 'legends' : 'classic'),
    }),
    [name],
  );
  return (
    <ThemeContext.Provider value={value}>
      <Stack.Screen options={{ title: 'Gallery' }} />
      <GalleryContent themeName={name} onThemeChange={setName} />
    </ThemeContext.Provider>
  );
}

function GalleryContent({
  themeName,
  onThemeChange,
}: {
  themeName: ThemeName;
  onThemeChange: (name: ThemeName) => void;
}) {
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setTimeout(() => setRefreshing(false), REFRESH_MS);
    return () => clearTimeout(timer);
  }, [refreshing]);

  return (
    <Screen
      title={GALLERY_TITLE}
      headerActions={
        <IconButton
          icon="notifications"
          label="Notification inbox"
          count={3}
          onPress={() => toast.show({ message: 'The inbox opens from here.', tone: 'info' })}
        />
      }
      refreshing={refreshing}
      onRefresh={() => setRefreshing(true)}
    >
      <SegmentedControl
        label="Theme"
        pattern="radio"
        segments={THEME_SEGMENTS}
        value={themeName}
        onChange={onThemeChange}
        style={{ marginHorizontal: layout.gutter, marginBottom: spacing.sm }}
        testID="gallery-theme"
      />
      <ActionSpecimens />
      <InputSpecimens />
      <SurfaceSpecimens />
      <StateSpecimens />
      <HouseholdSpecimens />
    </Screen>
  );
}
