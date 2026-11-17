/**
 * The five primary destinations as native tabs (SPK-UX-002; labels Home, Explore, Calendar, Teams
 * and You are PA-11, **Proposed**). Tab labels are always shown; the icon is decorative and hidden
 * from screen readers, and each tab button has a full accessible name (SPK-UX-009). The selected
 * tab is marked by a floodlight pill behind its icon and by its label colour, and screen readers
 * hear it as selected. Changing tab plays the selection haptic (ADR-008); the new destination on
 * screen is the feedback a haptic never replaces.
 *
 * Each destination draws its own large title (`AppHeader`, a header for screen readers) with the
 * header actions beside it (`HeaderActions`: the cart while one is in progress, the facility pass,
 * the inbox). Home shows no title, because its greeting opens the page (SCR-C-03), but keeps the
 * actions. Header, bar, labels and pill follow the theme in use (classic or Legends mode).
 *
 * Where the device offers glass (`useGlassMode`: iOS), the bar floats over the page as one glass
 * surface and the content scrolls beneath it; screens leave room for it through
 * `BottomBarInsetContext`. Everywhere else the bar is the solid bar in the layout it always was.
 */
import { Redirect, Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMe } from '../features/today/queries';
import { useApp } from '../providers/AppProviders';
import { AppHeader } from '../ui/AppHeader';
import { GlassSurface, useGlassMode } from '../ui/GlassSurface';
import { Icon } from '../ui/Icon';
import { useHaptics } from '../ui/PressableScale';
import { QueryBoundary } from '../ui/QueryBoundary';
import { BottomBarInsetContext } from '../ui/Screen';
import { StateView } from '../ui/StateView';
import { fonts, layout, makeStyles, radius, spacing, useTheme } from '../ui/theme';
import { DESTINATIONS } from './destinations';
import { HeaderActions } from './HeaderActions';

/**
 * The top of a destination: its large title and the header actions, below the status bar. Without
 * a title (Home) only the actions, on the right.
 */
export function TabHeader({ title }: { title?: string }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top }]}>
      {title ? (
        <AppHeader title={title} actions={<HeaderActions />} />
      ) : (
        <View style={styles.actionsOnly}>
          <HeaderActions />
        </View>
      )}
    </View>
  );
}

/**
 * Height of the tab row itself, without the home-indicator inset below it: the item's own 5 pt
 * padding above and below, the 30 pt icon pill, 2 pt and a 15 pt label line (room for descenders
 * such as the "p" of "Explore"), plus the bar's top border, with a little to spare.
 */
export const TAB_ROW_HEIGHT = 60;

export function TabsNavigator() {
  const session = useApp().session;
  const me = useMe();
  if (session.status === 'loading') {
    return <StateView variant="loading" label="your account" />;
  }
  if (session.status === 'signed_in' && me.data === undefined) {
    return (
      <QueryBoundary
        query={me}
        label="your account"
        empty={{ title: 'No account details', description: '' }}
        unavailableOffline={['opening your account']}
      >
        {() => null}
      </QueryBoundary>
    );
  }
  if (session.status === 'signed_in' && me.data?.person === null) {
    return <Redirect href="/onboarding" />;
  }
  return <PrimaryTabs />;
}

/** An unlinked customer must finish SCR-C-01 before person-scoped tab queries mount (§4.13, SPK-IAM-001/002/007). */
function PrimaryTabs() {
  const { colors } = useTheme();
  const styles = useStyles();
  const floating = useGlassMode() !== 'solid';
  const insets = useSafeAreaInsets();
  const haptics = useHaptics();
  return (
    <BottomBarInsetContext.Provider value={floating ? TAB_ROW_HEIGHT + insets.bottom : 0}>
      <Tabs
        // A press on another tab than the one shown: the selection tick (ADR-008).
        screenListeners={({ navigation }) => ({
          tabPress: () => {
            if (!navigation.isFocused()) haptics.selection();
          },
        })}
        screenOptions={{
          tabBarActiveTintColor: colors.tabActive,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarShowLabel: true,
          tabBarStyle: [
            styles.tabBar,
            { height: TAB_ROW_HEIGHT + insets.bottom, paddingBottom: insets.bottom },
            floating ? styles.tabBarFloating : null,
          ],
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
              header: () => <TabHeader title={d.name === 'index' ? undefined : d.title} />,
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
  header: { backgroundColor: colors.page },
  actionsOnly: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.sm,
  },
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
  // An explicit line height, so the label's descenders are never cut at the bottom of the bar.
  tabLabel: { ...fonts.bold, fontSize: 11, lineHeight: 15, marginTop: 2 },
  iconPill: {
    width: 56,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPillOn: { backgroundColor: colors.floodlight },
}));
