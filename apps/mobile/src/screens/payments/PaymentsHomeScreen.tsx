/**
 * Handoff M 4a Payments & receipts (You › Payments & receipts; SPK-PAY-002, SPK-PAY-005,
 * SPK-PAY-007, SPK-PAY-008; ADR-008 visual system v2, **Proposed**):
 *
 * - What's coming next on top, on the night card: the family's earliest open fee (the same reads
 *   as Home's To do), its amount, due date and description, with Pay now (the Pay sheet: never
 *   optimistic, locked while it runs, one idempotency key) and Manage plan. Instalment plans and
 *   autopay are a **Pending decision** (handoff open decision 2): Manage plan is shown disabled
 *   with the "Proposed" tag and no autopay pill is drawn.
 * - Two tiles: Credits (`GET /v1/people/{id}/money-summary` `creditsAvailable`, opening Credits)
 *   and Paid this year (`paidThisYear`); "Tax summary" for the year is **Proposed** (no PDF in the
 *   API): it opens a sheet that says so.
 * - History: payments that went through (`GET /v1/me/payments`), each named by what it paid for
 *   and who it was for, with that person's avatar in their colour (`receipts-model.ts`); refunds
 *   green with a "+". A row opens its receipt (M 4b). "Filter" opens every money view (what's due,
 *   payments, receipts, orders, your share: `/payments/all`).
 * - States: loading (placeholder rows), empty ("No payments yet"), error with its code and "Try
 *   again", offline (cached with its age; paying needs a connection).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { illustrations } from '../../artwork/manifest';
import { useApiQuery } from '../../api/useApiQuery';
import { useHousehold } from '../../features/home/household';
import { useTodoReads } from '../../features/home/todo';
import { formatMoney } from '../../features/money/format';
import { PaySheet } from '../../features/money/PaySheet';
import { useApiRecords } from '../../features/money/records';
import { dayWord } from '../../features/home/when';
import { formatDay } from '../../features/today/time';
import { useKnownFacilityZone } from '../../features/today/known-zone';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { personColorOf } from '../../ui/person-colors';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  elevation,
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from '../../ui/theme';
import { historyRows, rowAmount, type HistoryRow } from './receipts-model';

type Obligation = Schema<'Obligation'>;

/** Receipt route (M 4b), an opaque id only. */
export const receiptRoute = (paymentId: string) =>
  ({ pathname: '/payments/receipt/[paymentId]', params: { paymentId } }) as Href;

function NextPayment({ fee, onPay }: { fee: Obligation; onPay: () => void }) {
  const styles = useStyles();
  const zone = useKnownFacilityZone().zone;
  const offline = useConnectivity().reachable === false;
  const due = formatDay(fee.dueAt, zone).split(', ')[1] ?? formatDay(fee.dueAt, zone);
  return (
    <View style={styles.next} testID="payments-next">
      <Text style={styles.nextLabel}>Next payment</Text>
      <Text style={styles.nextAmount}>
        {formatMoney(fee.totals.remainingMinor, fee.totals.currency)}
      </Text>
      <Text style={styles.nextLine}>{`${due} · ${fee.description}`}</Text>
      <View style={styles.nextButtons}>
        <View style={styles.flex}>
          <Pressable
            onPress={onPay}
            disabled={offline}
            accessibilityRole="button"
            accessibilityLabel="Pay now"
            accessibilityState={{ disabled: offline }}
            style={({ pressed }) => [
              styles.payNow,
              offline ? styles.payNowDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            testID="payments-pay-now"
          >
            <Text style={styles.payNowText}>Pay now</Text>
          </Pressable>
        </View>
        <View style={[styles.flex, styles.proposed]}>
          <Button
            label="Manage plan"
            variant="secondary"
            block
            disabled
            onPress={() => undefined}
            testID="payments-manage-plan"
          />
          <StatusBadge tone="pending" label="Proposed" />
        </View>
      </View>
      {offline ? <Text style={styles.nextLine}>Paying needs a connection.</Text> : null}
    </View>
  );
}

function HistoryList({ rows }: { rows: HistoryRow[] }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const now = useNow();
  const zone = useKnownFacilityZone().zone;
  const { people } = useHousehold();
  if (rows.length === 0) {
    return (
      <EmptyState
        source={illustrations['empty-payments']}
        title="No payments yet"
        message="What you pay for registrations and fees will appear here, with receipts."
      />
    );
  }
  return (
    <View style={styles.history} accessibilityRole="list" testID="payments-history">
      {rows.map((row, index) => {
        const person = people.find((p) => p.id === row.personId);
        const day = dayWord(row.at, now, zone);
        const when = day === 'Today' ? 'Today' : (formatDay(row.at, zone).split(', ')[1] ?? day);
        const refund = row.kind === 'refund';
        return (
          <Pressable
            key={row.key}
            onPress={() => router.push(receiptRoute(row.paymentId))}
            accessibilityRole="button"
            accessibilityLabel={`${row.title}, ${person ? `${person.givenName}, ` : ''}${when}, ${refund ? 'refunded ' : ''}${rowAmount(row)}`}
            accessibilityHint="Opens the receipt"
            style={({ pressed }) => [
              styles.row,
              index > 0 ? styles.divider : null,
              refund ? { backgroundColor: theme.toneBackgrounds.success } : null,
              pressed ? styles.pressed : null,
            ]}
            testID={`payments-row-${row.key}`}
          >
            {person ? (
              <Avatar
                name={person.givenName}
                id={person.id}
                personColor={personColorOf(theme, person.slot)}
                size={40}
                decorative
              />
            ) : (
              <View style={styles.avatarSpace} />
            )}
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{row.title}</Text>
              <Text
                variant="footnote"
                style={refund ? { color: theme.colors.success } : styles.muted}
              >
                {refund ? `✓ ${when}` : when}
              </Text>
            </View>
            <Text style={[styles.amount, refund ? { color: theme.colors.success } : null]}>
              {rowAmount(row)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function PaymentsHome() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const { people, selfId } = useHousehold();
  const reads = useTodoReads(people, selfId);
  const payments = useApiQuery({
    path: '/me/payments',
    request: { query: { status: 'succeeded', limit: 20 } },
  });
  const summary = useApiQuery({
    path: '/people/{id}/money-summary',
    request: { path: { id: selfId ?? '' } },
    enabled: !!selfId,
  });
  const items = payments.data?.items ?? [];
  const details = useApiRecords(
    '/payments/{id}',
    items.map((p) => p.id),
    payments.data !== undefined,
  );
  const orders = useApiRecords(
    '/orders/{id}',
    items.flatMap((p) => (p.orderId ? [p.orderId] : [])),
    payments.data !== undefined,
  );
  const obligations = useApiRecords(
    '/obligations/{id}',
    items.flatMap((p) => (p.obligationId && !p.orderId ? [p.obligationId] : [])),
    payments.data !== undefined,
  );
  const dataOf = <T,>(records: Record<string, { data?: T }>) =>
    Object.fromEntries(Object.entries(records).map(([id, r]) => [id, r.data]));
  const rows = historyRows(
    items,
    dataOf(details as never),
    dataOf(orders as never),
    dataOf(obligations as never),
  );
  const next = [...reads.obligations]
    .filter((o) => o.status === 'open' && o.totals.remainingMinor > 0)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  const [paying, setPaying] = useState<Obligation | null>(null);
  const [tax, setTax] = useState(false);
  const payRef = useRef<View>(null);
  const credits = summary.data?.creditsAvailable[0];
  const paid = summary.data?.paidThisYear[0];

  return (
    <View testID="payments-home">
      {next ? (
        <View ref={payRef} collapsable={false}>
          <NextPayment fee={next} onPay={() => setPaying(next)} />
        </View>
      ) : (
        <View style={[elevation(theme, 'card'), styles.allPaid]} testID="payments-all-paid">
          <Text style={styles.rowTitle}>✓ All paid</Text>
          <Text variant="footnote" tone="muted">
            Nothing is due right now.
          </Text>
        </View>
      )}
      <View style={styles.tiles}>
        <Pressable
          onPress={() => router.push('/credits')}
          accessibilityRole="button"
          accessibilityLabel={`Credits, ${credits ? formatMoney(credits.amountMinor, credits.currency) : 'none'}, used first at checkout`}
          style={[elevation(theme, 'card'), styles.tile]}
          testID="payments-credits"
        >
          <Text style={styles.tileLabel}>Credits</Text>
          <Text style={styles.tileValue}>
            {credits ? formatMoney(credits.amountMinor, credits.currency) : '$0.00'}
          </Text>
          <Text variant="footnote" tone="muted">
            Used first at checkout
          </Text>
        </Pressable>
        <View style={[elevation(theme, 'card'), styles.tile]} testID="payments-paid-year">
          <Text style={styles.tileLabel}>Paid this year</Text>
          <Text style={styles.tileValue}>
            {paid ? formatMoney(paid.amountMinor, paid.currency).replace(/\.00$/u, '') : '$0'}
          </Text>
          <Pressable
            onPress={() => setTax(true)}
            accessibilityRole="button"
            accessibilityLabel="Tax summary, proposed"
            hitSlop={8}
          >
            <Text style={styles.tileLink}>Tax summary ↓</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.historyHead}>
        <Text style={styles.heading} accessibilityRole="header">
          History
        </Text>
        <Pressable
          onPress={() => router.push('/payments/all' as Href)}
          accessibilityRole="button"
          accessibilityLabel="Filter: every payment, receipt and order"
          style={styles.filter}
        >
          <Text style={styles.tileLink}>Filter</Text>
        </Pressable>
      </View>
      <QueryBoundary
        query={payments}
        label="your payments"
        empty={{ title: 'No payments yet', description: '' }}
      >
        {() => <HistoryList rows={rows} />}
      </QueryBoundary>

      <PaySheet
        open={paying !== null}
        onClose={() => setPaying(null)}
        obligation={paying}
        subtitle={paying ? paying.description : ''}
        onPaid={() => {
          reads.refetch();
          void payments.refetch();
        }}
        returnFocusTo={payRef}
      />
      <Sheet open={tax} onClose={() => setTax(false)} title="Tax summary">
        <View style={styles.sheet} testID="payments-tax-proposed">
          <StatusBadge tone="pending" label="Proposed" />
          <Text variant="body">
            A summary of the year&apos;s payments as a PDF is coming. Every payment and refund is in
            the history meanwhile, and the front desk can print one for you.
          </Text>
        </View>
      </Sheet>
    </View>
  );
}

export function PaymentsHomeScreen() {
  return (
    <Screen>
      <RequireSession what="your payments">
        <PaymentsHome />
      </RequireSession>
    </Screen>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  flex: { flex: 1, gap: 2 },
  next: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.sm,
    padding: spacing.lg,
    gap: spacing.xs,
    borderRadius: radius.xl,
    backgroundColor: colors.night,
  },
  nextLabel: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.floodlight },
  nextAmount: { ...tabular(type.largeTitle), ...fonts.bold, color: colors.onNight },
  nextLine: { ...type.callout, color: colors.onNightBody },
  nextButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  proposed: { alignItems: 'center', gap: spacing.xs },
  // Floodlight on night: the design's primary action on the next-payment card.
  payNow: {
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.floodlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payNowDisabled: { backgroundColor: colors.nightLine },
  payNowText: { ...fonts.bold, fontSize: 16, color: colors.onFloodlight },
  allPaid: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.sm,
    padding: spacing.lg,
    gap: spacing.xs,
    borderRadius: radius.lg,
  },
  tiles: {
    flexDirection: 'row',
    gap: spacing.md,
    marginHorizontal: layout.gutter,
    marginTop: spacing.md,
  },
  tile: { flex: 1, padding: 14, gap: 2, borderRadius: radius.lg },
  tileLabel: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  tileValue: { ...tabular({}), ...fonts.bold, fontSize: 22, lineHeight: 28, color: colors.text },
  tileLink: { ...fonts.semibold, fontSize: 14, lineHeight: 20, color: colors.primary },
  historyHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: layout.gutter,
    marginTop: spacing.xl,
  },
  heading: { ...type.title3, ...fonts.semibold, color: colors.text },
  filter: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  history: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 64,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  pressed: { opacity: 0.75 },
  avatarSpace: { width: 40 },
  rowTitle: { ...fonts.bold, fontSize: 16, lineHeight: 21, color: colors.text },
  muted: { color: colors.textMuted },
  amount: { ...tabular({}), ...fonts.bold, fontSize: 16, color: colors.text },
  sheet: { gap: spacing.md },
}));
