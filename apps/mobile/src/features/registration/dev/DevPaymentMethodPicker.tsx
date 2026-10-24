/**
 * Development payment method (development builds only, SCR-C-14): picks one of the API's fake
 * provider tokens (apps/api/src/modules/finance/providers/fake-payment.provider.ts). No card
 * details exist anywhere: a token only selects the provider scenario (§4.14).
 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '../../../ui/theme';
import { ChoiceRow } from '../ui';
import type { PaymentMethodPickerProps } from './index';

export const DEV_PAYMENT_SCENARIOS = [
  { token: 'pm_fake_visa', label: 'Succeeds at once' },
  { token: 'pm_fake_action', label: 'Needs a customer action' },
  { token: 'pm_fake_processing', label: 'Processing, outcome later' },
  { token: 'pm_fake_decline', label: 'Declined' },
  { token: 'pm_fake_timeout', label: 'Times out after the money was taken' },
  { token: 'pm_fake_timeout_decline', label: 'Times out and is declined' },
  { token: 'pm_fake_unreachable', label: 'Provider unreachable' },
] as const;

export function DevPaymentMethodPickerView({ value, onChange }: PaymentMethodPickerProps) {
  return (
    <View style={styles.box} testID="dev-payment-method">
      <Text style={styles.title} accessibilityRole="header">
        Development payment method
      </Text>
      <Text style={styles.caption}>
        Development build only. Uses the API's fake payment provider; no real payment is made.
      </Text>
      <View accessibilityRole="radiogroup">
        {DEV_PAYMENT_SCENARIOS.map((scenario) => (
          <ChoiceRow
            key={scenario.token}
            mode="radio"
            label={scenario.label}
            checked={value === scenario.token}
            onToggle={() => onChange(scenario.token)}
            testID={`dev-payment-${scenario.token}`}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    margin: spacing.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: 6,
    gap: spacing.xs,
  },
  title: { ...type.heading, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
