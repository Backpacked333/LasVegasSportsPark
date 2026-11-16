/**
 * In-person receipts: my point-of-sale receipts (Package G, conditional; §3.16 POS row "receipts, returns";
 * SPK-PAY-001, SPK-PAY-002, SPK-PAY-008, SPK-UX-010; beside the payment receipts of SCR-C-34).
 * Route: `/pos-receipts`, from Account.
 *
 * Reads `GET /v1/me/pos-receipts` (paid sales that name the signed-in person, newest first, cursor
 * pages with "Load more"). Each receipt shows the sale number, where and when it was paid (the
 * facility's name and time zone from `GET /v1/facilities/{id}`, SPK-SCHED-008), every line with
 * its quantity, unit price and amount before taxes (an open-amount line, SPK-PAY-016 proposed, by
 * its description and reason category instead), the subtotal, the approved taxes and fees it
 * applied,
 * the total, the settled tenders and any returns. Amounts are the API's minor units and currency,
 * formatted for display only; nothing is added up here. A card return never reads as refunded:
 * the receipt does not carry the refund's status (reported), so the app says so.
 *
 * Behind `CapabilityGate` for `point_of_sale` (DEC-016, DEC-079) with `whenOff="notice"`: receipts
 * of earlier sales stay readable while the switch is off. Which taxes and fees may appear is
 * DEC-057 (Finance); the API applies only approved charge policies.
 *
 * Customer words (PA-11): "In-person receipts" and "front desk", never "point of sale". Visual
 * system v2 (ADR-008): each receipt is a `Card` of label and value lines; an empty list shows the
 * payments illustration; pulling the page down reads it again.
 *
 * States: loading; empty ("No in-person receipts", with the payments illustration); ready; error
 * with the code and "Try again"; permission restriction (not available); offline or stale (cached
 * with its age); turned off ("In-person receipts turned off" above the list, which stays readable).
 */
import { Stack } from 'expo-router';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { formatMoney } from '../../features/money/format';
import { MoneyEmpty, usePullToRefresh } from '../../features/money/surfaces';
import {
  receiptLineText,
  receiptStatus,
  returnText,
  TENDER_LABELS,
  type PosReceipt,
} from '../../features/package-g/receipt-model';
import {
  formatInstantIn,
  useFacilities,
  type FacilityDisplay,
} from '../../features/package-g/time';
import { displayZone, zoneNotice } from '../../features/today/time';
import { RequireSession } from '../../session/RequireSession';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { Card } from '../../ui/Card';
import { FieldValue } from '../../ui/Field';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

/** What the screen and its turned-off notice call it (PA-11). */
export const RECEIPTS_TITLE = 'In-person receipts';
export const RECEIPTS_STILL_AVAILABLE = 'Receipts of earlier purchases stay available here.';
export const RECEIPTS_PAGE_SIZE = 20;

/** Receipts are keyed by their sale (module level: a stable `keyOf`). */
const receiptKey = (r: PosReceipt) => r.saleId;

function ReceiptCard({ receipt, facility }: { receipt: PosReceipt; facility: FacilityDisplay }) {
  const styles = useStyles();
  const money = (minor: number) => formatMoney(minor, receipt.currency);
  const zone = facility.zone;
  const notice = receipt.paidAt ? zoneNotice(zone, receipt.paidAt) : null;
  return (
    <Card style={styles.card} testID={`receipt-${receipt.saleId}`}>
      <Text variant="headline" accessibilityRole="header">
        {`Receipt ${receipt.saleNumber}`}
      </Text>
      <StatusBadge {...receiptStatus(receipt.status)} />
      <FieldValue
        label="Paid"
        value={`${receipt.paidAt ? formatInstantIn(receipt.paidAt, zone.zone) : 'Not recorded'}${
          facility.name ? ` at ${facility.name}` : ''
        }`}
      />
      <View accessibilityRole="list" accessibilityLabel="Items" style={styles.lines}>
        {receipt.lines.map((line, index) => (
          <FieldValue
            key={`${index}-${line.name}`}
            layout="inline"
            {...receiptLineText(line, money)}
          />
        ))}
      </View>
      <FieldValue layout="inline" label="Subtotal" value={money(receipt.subtotalMinor)} />
      {receipt.charges.map((c) => (
        <FieldValue
          key={`${c.kind}-${c.code}-${c.label}`}
          layout="inline"
          label={c.label}
          value={money(c.amountMinor)}
        />
      ))}
      <FieldValue layout="inline" emphasis label="Total" value={money(receipt.totalMinor)} />
      {receipt.tenders.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Paid with" style={styles.lines}>
          {receipt.tenders.map((t, index) => (
            <FieldValue
              key={`${index}-${t.kind}`}
              layout="inline"
              label={`Paid with: ${TENDER_LABELS[t.kind]}`}
              value={money(t.amountMinor)}
            />
          ))}
        </View>
      ) : null}
      {receipt.returns.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Returns" style={styles.lines}>
          {receipt.returns.map((r, index) => (
            <View key={`${index}-${r.returnedAt}`} style={styles.line}>
              <FieldValue
                label={`Returned ${formatInstantIn(r.returnedAt, zone.zone)}`}
                value={money(r.amountMinor)}
              />
              <Text variant="body">{returnText(r.tenderKind)}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {notice ? (
        <Text variant="footnote" tone="muted">
          {notice}
        </Text>
      ) : null}
    </Card>
  );
}

function ReceiptsList() {
  const styles = useStyles();
  const receipts = useApiPages({
    path: '/me/pos-receipts',
    request: { query: { limit: RECEIPTS_PAGE_SIZE } },
    keyOf: receiptKey,
  });
  const facilities = useFacilities((receipts.data ?? []).map((r) => r.facilityId));
  return (
    <>
      <QueryBoundary
        query={receipts}
        label="in-person receipts"
        // No `isEmpty`: the empty list is drawn below, with the payments illustration.
        empty={{ title: '', description: '' }}
      >
        {(items) =>
          items.length === 0 ? (
            <MoneyEmpty
              title="No in-person receipts"
              message="Purchases at the front desk that were recorded under your name appear here with their receipt."
              testID="pos-receipts-empty"
            />
          ) : (
            <View accessibilityRole="list" style={styles.list}>
              {items.map((r) => (
                <ReceiptCard
                  key={r.saleId}
                  receipt={r}
                  facility={facilities.get(r.facilityId) ?? { zone: displayZone(null), name: null }}
                />
              ))}
            </View>
          )
        }
      </QueryBoundary>
      <LoadMore pages={receipts} label="receipts" />
    </>
  );
}

export function PosReceiptsScreen() {
  const styles = useStyles();
  const { refreshing, onRefresh } = usePullToRefresh();
  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <View testID="screen-pos-receipts">
        <RequireSession what="your receipts">
          <View style={styles.header}>
            <Text variant="title2" accessibilityRole="header">
              {RECEIPTS_TITLE}
            </Text>
            <Text variant="caption" tone="muted">
              Purchases at the front desk. Payments for registrations and bookings are under
              Payments.
            </Text>
          </View>
          <CapabilityGate
            capability="point_of_sale"
            subject={RECEIPTS_TITLE}
            whenOff="notice"
            stillAvailable={RECEIPTS_STILL_AVAILABLE}
          >
            <ReceiptsList />
          </CapabilityGate>
        </RequireSession>
      </View>
    </Screen>
  );
}

/** Route component for app/pos-receipts/index.tsx: the customer's title in the header (PA-11). */
export function PosReceiptsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: RECEIPTS_TITLE }} />
      <PosReceiptsScreen />
    </>
  );
}

const useStyles = makeStyles(() => ({
  header: { paddingHorizontal: layout.gutter, paddingTop: spacing.lg, gap: spacing.xs },
  list: { gap: spacing.sm, paddingVertical: spacing.sm },
  card: { gap: spacing.sm },
  lines: { gap: spacing.xs },
  line: { gap: spacing.xxs },
}));
