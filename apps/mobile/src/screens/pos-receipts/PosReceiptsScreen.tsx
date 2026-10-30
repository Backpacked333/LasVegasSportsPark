/**
 * My point-of-sale receipts (Package G, conditional; §3.16 POS row "receipts, returns";
 * SPK-PAY-001, SPK-PAY-002, SPK-PAY-008, SPK-UX-010; beside the payment receipts of SCR-C-34).
 * Route: `/pos-receipts`, from Account.
 *
 * Reads `GET /v1/me/pos-receipts` (paid sales that name the signed-in person, newest first, cursor
 * pages with "Load more"). Each receipt shows the sale number, where and when it was paid (the
 * facility's name and time zone from `GET /v1/facilities/{id}`, SPK-SCHED-008), every line with
 * its quantity, unit price and amount before taxes, the subtotal, the approved taxes and fees it
 * applied,
 * the total, the settled tenders and any returns. Amounts are the API's minor units and currency,
 * formatted for display only; nothing is added up here. A card return never reads as refunded:
 * the receipt does not carry the refund's status (reported), so the app says so.
 *
 * Behind `CapabilityGate` for `point_of_sale` (DEC-016, DEC-079) with `whenOff="notice"`: receipts
 * of earlier sales stay readable while the switch is off. Which taxes and fees may appear is
 * DEC-057 (Finance); the API applies only approved charge policies.
 *
 * States: loading; empty ("No point-of-sale receipts"); ready; error with the code and "Try
 * again"; permission restriction (not available); offline or stale (cached with its age); turned
 * off (notice above the list).
 */
import { StyleSheet, Text, View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { formatMoney } from '../../features/money/format';
import { Body, Caption, Field } from '../../features/money/ui';
import {
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
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';

export const RECEIPTS_STILL_AVAILABLE = 'Receipts of earlier purchases stay available here.';
export const RECEIPTS_PAGE_SIZE = 20;

/** Receipts are keyed by their sale (module level: a stable `keyOf`). */
const receiptKey = (r: PosReceipt) => r.saleId;

function ReceiptCard({ receipt, facility }: { receipt: PosReceipt; facility: FacilityDisplay }) {
  const money = (minor: number) => formatMoney(minor, receipt.currency);
  const zone = facility.zone;
  const notice = receipt.paidAt ? zoneNotice(zone, receipt.paidAt) : null;
  return (
    <View style={styles.card} testID={`receipt-${receipt.saleId}`}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        {`Receipt ${receipt.saleNumber}`}
      </Text>
      <StatusBadge {...receiptStatus(receipt.status)} />
      <Field
        label="Paid"
        value={`${receipt.paidAt ? formatInstantIn(receipt.paidAt, zone.zone) : 'Not recorded'}${
          facility.name ? ` at ${facility.name}` : ''
        }`}
      />
      <View accessibilityRole="list" accessibilityLabel="Items">
        {receipt.lines.map((line, index) => (
          <Field
            key={`${index}-${line.name}`}
            label={`${line.quantity} × ${line.name}`}
            value={`${money(line.baseMinor)} (${money(line.unitPriceMinor)} each)`}
          />
        ))}
      </View>
      <Field label="Subtotal" value={money(receipt.subtotalMinor)} />
      {receipt.charges.map((c) => (
        <Field
          key={`${c.kind}-${c.code}-${c.label}`}
          label={c.label}
          value={money(c.amountMinor)}
        />
      ))}
      <Field label="Total" value={money(receipt.totalMinor)} />
      {receipt.tenders.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Paid with">
          {receipt.tenders.map((t, index) => (
            <Field
              key={`${index}-${t.kind}`}
              label={`Paid with: ${TENDER_LABELS[t.kind]}`}
              value={money(t.amountMinor)}
            />
          ))}
        </View>
      ) : null}
      {receipt.returns.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="Returns">
          {receipt.returns.map((r, index) => (
            <View key={`${index}-${r.returnedAt}`} style={styles.line}>
              <Field
                label={`Returned ${formatInstantIn(r.returnedAt, zone.zone)}`}
                value={money(r.amountMinor)}
              />
              <Body>{returnText(r.tenderKind)}</Body>
            </View>
          ))}
        </View>
      ) : null}
      {notice ? <Caption>{notice}</Caption> : null}
    </View>
  );
}

function ReceiptsList() {
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
        label="point-of-sale receipts"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No point-of-sale receipts',
          description:
            'Purchases at the facility desk that were recorded under your name appear here with their receipt.',
        }}
      >
        {(items) => (
          <View accessibilityRole="list" style={styles.list}>
            {items.map((r) => (
              <ReceiptCard
                key={r.saleId}
                receipt={r}
                facility={facilities.get(r.facilityId) ?? { zone: displayZone(null), name: null }}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={receipts} label="receipts" />
    </>
  );
}

export function PosReceiptsScreen() {
  return (
    <Screen>
      <View testID="screen-pos-receipts">
        <RequireSession what="your receipts">
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              Point-of-sale receipts
            </Text>
            <Caption>
              Purchases at the facility desk. Payments for registrations and bookings are under
              Payments.
            </Caption>
          </View>
          <CapabilityGate
            capability="point_of_sale"
            subject="Point-of-sale receipts"
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

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.xs },
  title: { ...type.title, color: colors.text },
  list: { gap: spacing.sm, padding: spacing.lg },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cardTitle: { ...type.heading, color: colors.text },
  line: { gap: 2 },
});
