/**
 * The five primary destinations as native tabs (SPK-UX-002). Every destination's header carries
 * quick access to the facility pass and the inbox. Tab labels are always shown; the icon is
 * decorative and hidden from screen readers (SPK-UX-009). The selected tab is marked by a
 * floodlight pill behind its icon and by its label colour, and screen readers hear it as selected.
 *
 * Headers are in the page colour with the destination's name as a condensed uppercase title; Home
 * shows no title in the header because its greeting opens the page (SCR-C-03). Bar, labels and
 * pill follow the theme in use (classic or Legends mode).
 */
import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { Icon } from '../ui/Icon';
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

export function TabsNavigator() {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
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
        tabBarStyle: styles.tabBar,
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
  );
}

const useStyles = makeStyles(({ colors }) => ({
  headerTitle: { ...type.display, fontSize: 30, lineHeight: 34, color: colors.text },
  tabBar: {
    backgroundColor: colors.background,
    borderTopColor: colors.border,
    borderTopWidth: 1,
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
