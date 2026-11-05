/**
 * Team obligation totals shown together and the same way everywhere (SPK-PAY-004): total,
 * received, allocated and remaining, read as one element by screen readers. Any excess received
 * beyond the total stays visible (SPK-PAY-005); how it is handled follows the overpayment policy,
 * which is pending (DEC-008, POL-015), so no handling is promised here.
 */
import type { Schema } from '@sportspark/api-client';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';
import { formatMoney } from './format';

type Totals = Schema<'ObligationTotals'>;

export function totalsLabel(totals: Totals): string {
  const m = (minor: number) => formatMoney(minor, totals.currency);
  return `Team total ${m(totals.amountMinor)}, received ${m(totals.receivedMinor)}, allocated ${m(totals.allocatedMinor)}, remaining ${m(totals.remainingMinor)}`;
}

export function ObligationTotals({ totals, testID }: { totals: Totals; testID?: string }) {
  const m = (minor: number) => formatMoney(minor, totals.currency);
  const rows: [string, string][] = [
    ['Team total', m(totals.amountMinor)],
    ['Received', m(totals.receivedMinor)],
    ['Allocated', m(totals.allocatedMinor)],
    ['Remaining', m(totals.remainingMinor)],
  ];
  return (
    <View style={styles.box} testID={testID}>
      <View accessible accessibilityLabel={totalsLabel(totals)} style={styles.rows}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.value}>{value}</Text>
          </View>
        ))}
      </View>
      {totals.excessMinor > 0 ? (
        <View style={styles.excess}>
          <StatusBadge
            tone="warning"
            label={`Received beyond the total: ${m(totals.excessMinor)}`}
          />
          <Text style={styles.caption}>
            The excess stays visible and traceable. How it is handled follows the overpayment
            policy, which is still being decided (DEC-008, POL-015).
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.sm },
  rows: { gap: spacing.xs },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  label: { ...type.body, color: colors.textMuted },
  value: { ...type.body, color: colors.text, fontWeight: '600' },
  excess: { gap: spacing.xs },
  caption: { ...type.caption, color: colors.textMuted },
});
