/**
 * Handoff M 4b Receipt with a refund request (tap a payment in M 4a; SPK-PAY-005, SPK-PAY-008,
 * SPK-REG-010, SPK-SUPPORT-002; ADR-008 visual system v2, **Proposed**):
 *
 * - "✓ Paid Nov 14, 2026", the amount and what it was for and who (`GET /v1/payments/{id}`, its
 *   order's lines `GET /v1/orders/{id}`, else its fee `GET /v1/obligations/{id}`), itemised like the
 *   review screen: each line, discounts in green with "−", the total, and the reference staff need.
 *   Refunds of the payment are listed with their state (one being processed is never "refunded").
 * - "Can't make a week?": for a registration paid here, what cancelling a place gives back in plain
 *   words, from its cancellation preview (`GET /v1/enrollments/{id}/cancellation-preview`).
 *   "Cancel a week" opens a sheet listing the places (weeks) with what you'd get back; choosing one
 *   and confirming sends a request the desk approves (staff S 4b): a support request in the
 *   payment category naming the place and the payment (`POST /v1/me/support-requests`, one
 *   idempotency key, the sheet locked while it runs). Money only moves when staff approve it, so
 *   nothing here is optimistic. A place already asked about shows "Request sent".
 * - "Ask the desk" opens Support. "Download PDF" is **Proposed**: there is no receipt PDF in the
 *   API, so it is disabled with the tag.
 */
import type { Schema } from '@sportspark/api-client';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useHousehold } from '../../features/home/household';
import { formatMoney } from '../../features/money/format';
import { useApiRecords } from '../../features/money/records';
import { useKnownFacilityZone } from '../../features/today/known-zone';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveRegion } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandError';
import { Icon } from '../../ui/Icon';
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
import { paidFor, refundWords } from './receipts-model';

type PaymentDetail = Schema<'PaymentDetail'>;
type OrderLine = Schema<'OrderLine'>;

/** "Nov 14, 2026" on the facility's clock. */
function longDate(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: zone,
  }).format(new Date(iso));
}

/** The title of the request the desk approves (matches what staff S 4b reads). */
export function cancelRequestTitle(line: Pick<OrderLine, 'description'>): string {
  return `Cancel a week: ${line.description}`;
}

function CancelSheet({
  open,
  onClose,
  payment,
  lines,
  requested,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  payment: PaymentDetail;
  lines: OrderLine[];
  requested: ReadonlySet<string>;
  onSent: (enrollmentId: string) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const offline = useConnectivity().reachable === false;
  const { names } = useHousehold();
  const [chosen, setChosen] = useState<string | null>(null);
  const previews = useApiRecords(
    '/enrollments/{id}/cancellation-preview',
    lines.flatMap((l) => (l.enrollmentId ? [l.enrollmentId] : [])),
    open,
  );
  const send = useApiCommand('post', '/me/support-requests', {
    invalidate: [['api', '/me/cases']],
  });
  const line = lines.find((l) => l.enrollmentId === chosen) ?? null;
  const submit = async () => {
    if (!line?.enrollmentId) return;
    const preview = previews[line.enrollmentId]?.data;
    const back = refundWords(preview?.financialConsequence, formatMoney);
    try {
      await send.submit({
        body: {
          category: 'payment',
          title: cancelRequestTitle(line),
          description: `Please cancel ${line.description} for ${names.get(line.participantPersonId) ?? 'my child'}. Shown in the app: ${back}.`,
          subjectPersonId: line.participantPersonId,
          relatedRecords: [
            { type: 'enrollment', id: line.enrollmentId },
            { type: 'payment_attempt', id: payment.id },
          ],
        },
      });
      onSent(line.enrollmentId);
      setChosen(null);
      onClose();
    } catch {
      // Shown below; the choice is kept.
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Cancel a week" locked={send.isProcessing}>
      <View style={styles.sheet} testID="cancel-week-sheet">
        <Text variant="callout" tone="muted">
          Choose the week. The desk confirms the request, then the money comes back as shown.
        </Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Week to cancel">
          {lines.map((l) => {
            const id = l.enrollmentId;
            if (!id) return null;
            const preview = previews[id]?.data;
            const already = requested.has(id);
            const permitted = preview ? preview.permitted : true;
            const selected = chosen === id;
            return (
              <Pressable
                key={l.id}
                onPress={() => setChosen(id)}
                disabled={already || !permitted}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: already || !permitted }}
                accessibilityLabel={`${l.description}, ${already ? 'request sent' : refundWords(preview?.financialConsequence, formatMoney)}`}
                style={[styles.week, selected ? styles.weekSelected : null]}
                testID={`cancel-week-${id}`}
              >
                <Icon
                  name={selected ? 'radio_button_checked' : 'radio_button_unchecked'}
                  size={22}
                  color={selected ? theme.colors.primary : theme.colors.textMuted}
                />
                <View style={styles.flex}>
                  <Text style={styles.lineTitle}>{l.description}</Text>
                  <Text variant="footnote" tone="muted">
                    {already
                      ? 'Request sent'
                      : refundWords(preview?.financialConsequence, formatMoney)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        {send.error ? <CommandError error={send.error} onRetry={() => void submit()} /> : null}
        <Button
          label="Send the request"
          block
          disabled={!line || offline}
          busy={send.isProcessing}
          onPress={() => void submit()}
          testID="cancel-week-send"
        />
        {offline ? (
          <Text variant="footnote" tone="muted">
            Sending needs a connection.
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

function Receipt({ payment }: { payment: PaymentDetail }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const zone = useKnownFacilityZone().zone;
  const { names } = useHousehold();
  const order = useApiQuery({
    path: '/orders/{id}',
    request: { path: { id: payment.orderId ?? '' } },
    enabled: !!payment.orderId,
  });
  const obligation = useApiQuery({
    path: '/obligations/{id}',
    request: { path: { id: payment.obligationId ?? '' } },
    enabled: !!payment.obligationId && !payment.orderId,
  });
  const cases = useApiQuery({ path: '/me/cases', request: { query: { limit: 50 } } });
  const what = paidFor(payment, order.data, obligation.data);
  const lines = order.data?.lines ?? [];
  const places = lines.filter((l) => l.enrollmentId && l.lineKind !== 'addon');
  const firstPlace = places[0]?.enrollmentId ?? null;
  const preview = useApiQuery({
    path: '/enrollments/{id}/cancellation-preview',
    request: { path: { id: firstPlace ?? '' } },
    enabled: !!firstPlace,
  });
  const [sentNow, setSentNow] = useState<string[]>([]);
  const requested = useMemo(() => {
    const titles = new Set(
      (cases.data?.items ?? [])
        .filter((c) => c.category === 'payment' && c.status !== 'closed')
        .map((c) => c.title),
    );
    return new Set([
      ...sentNow,
      ...places.flatMap((l) =>
        l.enrollmentId && titles.has(cancelRequestTitle(l)) ? [l.enrollmentId] : [],
      ),
    ]);
  }, [cases.data, places, sentNow]);
  const [cancelling, setCancelling] = useState(false);
  const cancelRef = useRef<View>(null);
  const who = what.personId ? names.get(what.personId) : undefined;
  const discount = lines.reduce((sum, l) => sum + l.discountMinor, 0);
  const total = order.data?.totalMinor ?? payment.amountMinor;
  const reference = payment.providerReference ?? payment.id.slice(-12).toUpperCase();

  return (
    <View testID="receipt">
      <View style={styles.head}>
        <View style={[styles.paid, { backgroundColor: theme.toneBackgrounds.success }]}>
          <Text style={[styles.paidText, { color: theme.colors.success }]}>
            {`✓ Paid ${longDate(payment.resolvedAt ?? payment.createdAt, zone)}`}
          </Text>
        </View>
        <Text style={styles.amount} accessibilityRole="header">
          {formatMoney(payment.amountMinor, payment.currency)}
        </Text>
        <Text variant="callout" tone="muted">
          {[what.title, who].filter(Boolean).join(' · ')}
        </Text>
      </View>

      <View style={[elevation(theme, 'card'), styles.card]} testID="receipt-lines">
        {lines.map((l) => (
          <View key={l.id} style={styles.line}>
            <Text style={[styles.flex, styles.lineText]}>{l.description}</Text>
            <Text style={styles.lineAmount}>{formatMoney(l.baseAmountMinor, l.currency)}</Text>
          </View>
        ))}
        {discount > 0 ? (
          <View style={styles.line}>
            <Text style={[styles.flex, styles.lineText, { color: theme.colors.success }]}>
              Discount
            </Text>
            <Text style={[styles.lineAmount, { color: theme.colors.success }]}>
              {`−${formatMoney(discount, payment.currency)}`}
            </Text>
          </View>
        ) : null}
        <View style={[styles.line, styles.total]}>
          <Text style={[styles.flex, styles.totalText]}>Total</Text>
          <Text style={styles.totalText}>{formatMoney(total, payment.currency)}</Text>
        </View>
        <View style={styles.reference}>
          <Text variant="footnote" tone="muted" style={styles.flex}>
            {`ref ${reference}`}
          </Text>
        </View>
        {payment.refunds.map((r) => (
          <View key={r.id} style={styles.line} testID={`receipt-refund-${r.id}`}>
            <Text style={[styles.flex, styles.lineText]}>Refund</Text>
            <StatusBadge
              tone={
                r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'pending'
              }
              label={
                r.status === 'succeeded'
                  ? `+${formatMoney(r.amountMinor, r.currency)}`
                  : r.status === 'failed'
                    ? 'Refund failed'
                    : 'Refund being processed'
              }
            />
          </View>
        ))}
      </View>

      {places.length > 0 ? (
        <View
          style={[elevation(theme, 'card'), styles.card]}
          ref={cancelRef}
          collapsable={false}
          testID="receipt-cancel"
        >
          <Text style={styles.cardTitle}>Can&apos;t make a week?</Text>
          <Text variant="callout" tone="muted">
            {preview.data
              ? `${preview.data.financialConsequence.explanation || refundWords(preview.data.financialConsequence, formatMoney)}`
              : 'Ask to cancel a week and the desk will confirm what comes back.'}
          </Text>
          {requested.size > 0 ? (
            <LiveRegion announcement="Request sent. The desk will confirm.">
              <StatusBadge tone="pending" label="Request sent · the desk will confirm" />
            </LiveRegion>
          ) : null}
          <View style={styles.buttons}>
            <View style={styles.flex}>
              <Button
                label="Cancel a week"
                variant="secondary"
                block
                onPress={() => setCancelling(true)}
                testID="receipt-cancel-week"
              />
            </View>
            <View style={styles.flex}>
              <Button
                label="Ask the desk"
                variant="secondary"
                block
                onPress={() => router.push('/support')}
              />
            </View>
          </View>
        </View>
      ) : null}

      <View style={styles.pdf}>
        <Button
          label="Download PDF"
          icon="download"
          variant="tonal"
          block
          disabled
          onPress={() => undefined}
        />
        <StatusBadge tone="pending" label="Proposed" />
      </View>

      <CancelSheet
        open={cancelling}
        onClose={() => setCancelling(false)}
        payment={payment}
        lines={places}
        requested={requested}
        onSent={(id) => {
          setSentNow((s) => [...s, id]);
          void cases.refetch();
        }}
      />
    </View>
  );
}

export function ReceiptScreen({ paymentId }: { paymentId: string | undefined }) {
  const payment = useApiQuery({
    path: '/payments/{id}',
    request: { path: { id: paymentId ?? '' } },
    enabled: !!paymentId,
  });
  return (
    <Screen>
      <RequireSession what="this receipt">
        <QueryBoundary
          query={payment}
          label="the receipt"
          empty={{ title: 'Not available', description: '' }}
        >
          {(data) => <Receipt payment={data} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route entry: `/payments/receipt/<paymentId>` (an opaque id only). */
export function ReceiptRoute() {
  const { paymentId } = useLocalSearchParams<{ paymentId?: string }>();
  return <ReceiptScreen paymentId={typeof paymentId === 'string' ? paymentId : undefined} />;
}

const useStyles = makeStyles(({ colors }) => ({
  flex: { flex: 1 },
  head: { alignItems: 'center', gap: spacing.sm, paddingHorizontal: layout.gutter },
  paid: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  paidText: { ...fonts.bold, fontSize: 13 },
  amount: { ...tabular(type.largeTitle), ...fonts.extrabold, color: colors.text },
  card: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.lg,
  },
  cardTitle: { ...fonts.bold, fontSize: 17, lineHeight: 22, color: colors.text },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 40,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  lineText: { ...type.body, color: colors.text },
  lineTitle: { ...fonts.semibold, fontSize: 15, color: colors.text },
  lineAmount: { ...tabular(type.body), color: colors.text },
  total: { borderBottomWidth: 0, borderTopWidth: 1, borderTopColor: colors.text },
  totalText: { ...tabular(type.body), ...fonts.bold, color: colors.text },
  reference: { flexDirection: 'row', paddingTop: spacing.xs },
  buttons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  pdf: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.xl,
    gap: spacing.xs,
    alignItems: 'center',
  },
  sheet: { gap: spacing.md },
  week: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: MIN_TOUCH_SIZE + 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  weekSelected: { backgroundColor: colors.tonal },
}));
