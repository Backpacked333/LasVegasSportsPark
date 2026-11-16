/**
 * Team obligation totals shown together and the same way everywhere (SPK-PAY-004): total,
 * received, allocated and remaining, read as one element by screen readers. Any excess received
 * beyond the total stays visible (SPK-PAY-005); how it is handled follows the overpayment policy,
 * which is pending (DEC-008, POL-015), so no handling is promised here: the screen says what to do
 * now (`pendingMessage`) with the decisions in "Details for support" (PA-11). Amounts are in
 * tabular figures (ADR-008).
 */
import type { Schema } from '@sportspark/api-client';
import { pendingMessage } from '../../copy/pending';
import { Text, View } from 'react-native';
import { StatusBadge } from '../../ui/StatusBadge';
import { SupportDetails } from '../../ui/SupportDetails';
import { fonts, makeStyles, spacing, tabular, type } from '../../ui/theme';
import { formatMoney } from './format';

type Totals = Schema<'ObligationTotals'>;

export function totalsLabel(totals: Totals): string {
  const m = (minor: number) => formatMoney(minor, totals.currency);
  return `Team total ${m(totals.amountMinor)}, received ${m(totals.receivedMinor)}, allocated ${m(totals.allocatedMinor)}, remaining ${m(totals.remainingMinor)}`;
}

export function ObligationTotals({ totals, testID }: { totals: Totals; testID?: string }) {
  const styles = useStyles();
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
            {`The extra amount stays on record. ${pendingMessage('POL-015')}`}
          </Text>
          <SupportDetails decisions={['DEC-008', 'POL-015']} />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  box: { gap: spacing.sm },
  rows: { gap: spacing.xs },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  label: { ...type.body, color: colors.textMuted },
  value: { ...tabular(type.body), color: colors.text, ...fonts.semibold },
  excess: { gap: spacing.xs },
  caption: { ...type.caption, color: colors.textMuted },
}));
