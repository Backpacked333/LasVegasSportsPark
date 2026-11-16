/**
 * The five primary destinations as native tabs (SPK-UX-002). Every destination's header carries
 * quick access to the facility pass and the inbox. Tab labels are always shown; the icon is
 * decorative and hidden from screen readers (SPK-UX-009). The selected tab is marked by a
 * floodlight pill behind its icon and by its label colour, and screen readers hear it as selected.
 *
 * Headers are in the page colour with the destination's name as a condensed uppercase title; Home
 * shows no title in the header because its greeting opens the page (SCR-C-03). Bar, labels and
 * pill follow the theme in use (classic or Legends mode).
 *
 * Where the device offers glass (`useGlassMode`: iOS), the bar floats over the page as one glass
 * surface and the content scrolls beneath it; screens leave room for it through
 * `BottomBarInsetContext`. Everywhere else the bar is the solid bar in the layout it always was.
 */
import { Tabs } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface, useGlassMode } from '../ui/GlassSurface';
import { Icon } from '../ui/Icon';
import { BottomBarInsetContext } from '../ui/Screen';
import { fonts, makeStyles, radius, type, useTheme } from '../ui/theme';
import { DESTINATIONS } from './destinations';
import { QuickAccess } from './QuickAccess';

export function HeaderTitle({ children }: { children: string }) {
  const styles = useStyles();
  return (
    <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
      {children}
    </Text>
  );
}

/** Height of the tab row itself, without the home-indicator inset below it. */
const TAB_ROW_HEIGHT = 49;

export function TabsNavigator() {
  const { colors } = useTheme();
  const styles = useStyles();
  const floating = useGlassMode() !== 'solid';
  const insets = useSafeAreaInsets();
  return (
    <BottomBarInsetContext.Provider value={floating ? TAB_ROW_HEIGHT + insets.bottom : 0}>
      <Tabs
        screenOptions={{
          headerRight: () => <QuickAccess />,
          headerTitleAlign: 'left',
          headerTitle: ({ children }) => <HeaderTitle>{children}</HeaderTitle>,
          headerStyle: { backgroundColor: colors.page },
          headerShadowVisible: false,
          tabBarActiveTintColor: colors.tabActive,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarShowLabel: true,
          tabBarStyle: floating ? [styles.tabBar, styles.tabBarFloating] : styles.tabBar,
          ...(floating
            ? {
                tabBarBackground: () => (
                  <GlassSurface style={StyleSheet.absoluteFill} testID="tab-bar-glass" />
                ),
              }
            : {}),
          tabBarLabelStyle: styles.tabLabel,
          sceneStyle: { backgroundColor: colors.page },
        }}
      >
        {DESTINATIONS.map((d) => (
          <Tabs.Screen
            key={d.name}
            name={d.name}
            options={{
              title: d.title,
              ...(d.name === 'index' ? { headerTitle: () => null } : {}),
              tabBarAccessibilityLabel: d.accessibilityLabel,
              tabBarButtonTestID: `tab-${d.name}`,
              tabBarIcon: ({ color, focused }) => (
                <View style={[styles.iconPill, focused && styles.iconPillOn]}>
                  <Icon name={d.icon} size={23} color={focused ? colors.onFloodlight : color} />
                </View>
              ),
            }}
          />
        ))}
      </Tabs>
    </BottomBarInsetContext.Provider>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  headerTitle: { ...type.display, fontSize: 30, lineHeight: 34, color: colors.text },
  tabBar: {
    backgroundColor: colors.background,
    borderTopColor: colors.border,
    borderTopWidth: 1,
  },
  // The glass draws the bar: no fill of its own, and a hairline the glass keeps visible.
  tabBarFloating: {
    position: 'absolute',
    backgroundColor: 'transparent',
    borderTopWidth: StyleSheet.hairlineWidth,
    elevation: 0,
  },
  tabLabel: { ...fonts.bold, fontSize: 11 },
  iconPill: {
    width: 56,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPillOn: { backgroundColor: colors.floodlight },
}));
