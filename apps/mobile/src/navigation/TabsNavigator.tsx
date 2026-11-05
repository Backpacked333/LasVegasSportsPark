/**
 * The five primary destinations as native tabs (SPK-UX-002). Every destination's header carries
 * quick access to the facility pass and the inbox. Tab labels are always shown; the glyph is
 * decorative and hidden from screen readers (SPK-UX-009).
 */
import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { colors } from '../ui/theme';
import { DESTINATIONS } from './destinations';
import { QuickAccess } from './QuickAccess';

export function TabsNavigator() {
  return (
    <Tabs
      screenOptions={{
        headerRight: () => <QuickAccess />,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarShowLabel: true,
      }}
    >
      {DESTINATIONS.map((d) => (
        <Tabs.Screen
          key={d.name}
          name={d.name}
          options={{
            title: d.title,
            tabBarAccessibilityLabel: d.accessibilityLabel,
            tabBarButtonTestID: `tab-${d.name}`,
            tabBarIcon: ({ color }) => (
              <Text
                style={{ color, fontSize: 18 }}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                {d.glyph}
              </Text>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
