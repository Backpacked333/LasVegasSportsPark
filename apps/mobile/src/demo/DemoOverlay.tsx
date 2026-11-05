/**
 * Demo banner and tour card over every screen of the customer app in demo mode (development builds
 * with appMode `demo` only). Says the data is sample data, steps through the family tour and lets
 * the presenter end the demo.
 */
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { colors, spacing, type } from '../ui/theme';
import { resetDemoState, setDemoState, useDemoState } from './store';
import { FAMILY_TOUR } from './tour';

export function DemoOverlay() {
  const { services, session, signOut } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const demo = useDemoState();
  if (services.config.appMode !== 'demo' || session.status !== 'signed_in') return null;

  const last = FAMILY_TOUR.length - 1;
  const index = Math.min(demo.step, last);
  const step = FAMILY_TOUR[index]!;
  const go = (next: number) => {
    const target = FAMILY_TOUR[next];
    if (!target) return;
    setDemoState({ step: next });
    router.navigate(target.path as never);
  };
  const end = async () => {
    resetDemoState();
    await signOut();
    router.replace('/sign-in');
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {demo.open ? (
        <View style={styles.card} accessibilityLabel="Demo tour" testID="demo-tour">
          <Text style={styles.count}>
            Family tour · step {index + 1} of {FAMILY_TOUR.length}
          </Text>
          <Text style={styles.title} accessibilityRole="header">
            {step.title}
          </Text>
          <Text style={styles.text}>{step.body}</Text>
          {pathname !== step.path ? (
            <Button
              label="Open this screen"
              variant="secondary"
              onPress={() => router.navigate(step.path as never)}
            />
          ) : null}
          <View style={styles.row}>
            <Button
              label="Back"
              variant="secondary"
              disabled={index === 0}
              onPress={() => go(index - 1)}
            />
            {index < last ? (
              <Button label="Next" onPress={() => go(index + 1)} />
            ) : (
              <Button label="Finish tour" onPress={() => setDemoState({ open: false, step: 0 })} />
            )}
          </View>
        </View>
      ) : null}
      <View style={styles.bar} accessibilityLabel="Demo mode">
        <Text style={styles.barText}>Demo mode · sample data, nothing here is real</Text>
        <View style={styles.row}>
          <Button
            label={demo.open ? 'Hide tour' : 'Show tour'}
            variant="secondary"
            onPress={() => setDemoState({ open: !demo.open })}
          />
          <Button label="End demo" variant="secondary" onPress={() => void end()} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  card: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  count: { ...type.caption, color: colors.textMuted },
  title: { ...type.heading, color: colors.text },
  text: { ...type.body, color: colors.text },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'flex-end' },
  bar: {
    backgroundColor: colors.surface,
    borderColor: colors.pending,
    borderWidth: 2,
    borderRadius: 12,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  barText: { ...type.caption, color: colors.text },
});
