/**
 * Quick actions on SCR-C-03 Home (SPK-UX-002 "quick access to pass"; PA-11 **Proposed** labels;
 * ADR-008): Pass, Calendar and Explore, and Pay while an amount is due. Each is one button whose
 * name contains the word it shows (the pass reads "Show facility pass"); the icon is decorative.
 * Shown signed out as well, so the pass is always one tap away.
 */
import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';
import { Card } from '../../ui/Card';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing, useTheme } from '../../ui/theme';

interface QuickAction {
  key: string;
  icon: string;
  label: string;
  name: string;
  hint?: string;
  href: Href;
}

/** The pass, Calendar and Explore; Pay is added by the screen when an amount is due. */
export const BASE_QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'pass', icon: 'qr_code_2', label: 'Pass', name: 'Show facility pass', href: '/pass' },
  {
    key: 'calendar',
    icon: 'calendar_month',
    label: 'Calendar',
    name: 'Calendar',
    href: '/schedule',
  },
  { key: 'explore', icon: 'explore', label: 'Explore', name: 'Explore', href: '/discover' },
];

export function QuickActions({ pay }: { pay?: Href | null }) {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const actions: QuickAction[] = [
    ...BASE_QUICK_ACTIONS,
    ...(pay
      ? [
          {
            key: 'pay',
            icon: 'payments',
            label: 'Pay',
            name: 'Pay',
            hint: 'Opens the amount due',
            href: pay,
          },
        ]
      : []),
  ];
  return (
    <View style={styles.row} testID="home-quick-actions">
      {actions.map((action) => (
        <Card
          key={action.key}
          elevation="card"
          onPress={() => router.push(action.href)}
          accessibilityLabel={action.name}
          accessibilityHint={action.hint}
          style={styles.tile}
          testID={`home-quick-${action.key}`}
        >
          <Icon name={action.icon} size={24} color={colors.primary} />
          <Text variant="footnote" style={styles.label}>
            {action.label}
          </Text>
        </Card>
      ))}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: layout.gutter,
    marginTop: layout.sectionGap - spacing.sm,
  },
  tile: {
    flexGrow: 1,
    flexBasis: 72,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  label: { textAlign: 'center' },
}));
