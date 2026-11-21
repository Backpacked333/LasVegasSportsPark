/**
 * Pay sheet (redesign handoff 2b and 3b; INTERACTIONS 2b; key flow "Pay a fee"; SPK-PAY-004/005,
 * SPK-PAY-007, §4.9, §4.11). Opened from Home's To do (and, later, You › Due now and the inbox)
 * over the page, so the parent never leaves Home.
 *
 * - Shows the amount due of one balance (`Obligation`, `GET /v1/obligations?...`), its activity
 *   tile, who it is for and when it is due, and pays it with `POST /v1/obligations/{id}/payments`
 *   (the remaining balance, one Idempotency-Key per intent through `useApiCommand`).
 * - **Money is never optimistic**: the button shows a spinner and "Paying…", and the sheet is
 *   locked (no grabber, ✕ disabled, scrim and drag ignored) until the API answers.
 * - Succeeded: the sheet closes and the caller shows "✓ Paid" on the row and the toast.
 * - Declined (`failed`): the sheet stays open; the method row turns red ("✕ Declined by your
 *   bank"), "You weren't charged." says money did not move, the next method is picked for the
 *   parent and the button names it; the reference is in "Details for support" (PA-11: codes only
 *   there).
 * - Processing, a step the provider asks for, or an unknown outcome: never success or failure
 *   (SPK-PAY-007): "Payment processing" / "Payment outcome being confirmed. Do not pay again.",
 *   paying is blocked, and the payment's own screen is one tap away.
 * - No answer, a lost answer or a refusal before running: the shared `CommandError` (money
 *   wording: "No answer yet" with "Check again" under the same key, "Not done" for a refusal).
 * - **Instalments** ("Pay in full / 3 × $40") are shown only when a price rule offers them: none
 *   does yet, so the control is hidden (`PROPOSED.instalments`, **Pending decision**).
 * - **Payment methods** (DEC-019, the provider is not selected): development builds list the API's
 *   fake provider scenarios as the methods (`features/money/dev`, no card details exist anywhere);
 *   release builds show "Paying in the app isn't available yet. Pay at the front desk for now."
 *   and no Pay button. "Or pay at the front desk" is always shown.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Pressable, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { activityArtwork } from '../../artwork/manifest';
import { useConnectivity } from '../../providers/AppProviders';
import { LiveRegion, sentences } from '../../ui/announce';
import { Artwork } from '../../ui/Artwork';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandError';
import { Icon } from '../../ui/Icon';
import { InfoCard } from '../../ui/InfoCard';
import { Sheet } from '../../ui/Sheet';
import { StatusBadge } from '../../ui/StatusBadge';
import { SupportDetails } from '../../ui/SupportDetails';
import { Text } from '../../ui/Text';
import { fonts, makeStyles, radius, spacing, tabular, type, useTheme } from '../../ui/theme';
import { DEV_PAYMENT_METHODS, DEV_PAYMENT_WORDS } from './dev';
import { formatMoney } from './format';
import { PAYMENT_EFFECT_KEYS } from './payment-effects';
import { paymentStatus } from './status';
import { PAY_AT_DESK_MESSAGE, PAY_AT_DESK_SUPPORT } from './surfaces';

type Obligation = Schema<'Obligation'>;
type PaymentOutcome = Schema<'PaymentOutcome'>;

/** The methods this build can pay with: the fake provider's scenarios in development, none in release. */
export const PAY_METHODS: readonly { token: string; label: string }[] = DEV_PAYMENT_METHODS ?? [];

export const NOT_CHARGED = "You weren't charged.";
export const DECLINED_TEXT =
  'Your bank said no to this card. Try another card, or call the number on the back of your card.';
export const DESK_LINE = 'Or pay at the front desk.';

export interface PaySheetProps {
  open: boolean;
  onClose: () => void;
  obligation: Obligation | null;
  /** "Maya · due Fri, Nov 27". */
  subtitle: string;
  /** Called when the payment succeeded, with the API's outcome. */
  onPaid: (outcome: PaymentOutcome) => void;
  returnFocusTo?: RefObject<unknown>;
}

export function PaySheet({
  open,
  onClose,
  obligation,
  subtitle,
  onPaid,
  returnFocusTo,
}: PaySheetProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const router = useRouter();
  const offline = useConnectivity().reachable === false;
  const pay = useApiCommand('post', '/obligations/{id}/payments', {
    invalidate: PAYMENT_EFFECT_KEYS,
  });
  const [method, setMethod] = useState<string | null>(PAY_METHODS[0]?.token ?? null);
  const [choosing, setChoosing] = useState(false);
  const [declined, setDeclined] = useState<{ token: string; paymentId: string } | null>(null);
  const [pending, setPending] = useState<PaymentOutcome | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);

  // A new balance starts clean.
  useEffect(() => {
    if (!open) return;
    setDeclined(null);
    setPending(null);
    setFailure(null);
    setChoosing(false);
    setMethod(PAY_METHODS[0]?.token ?? null);
  }, [open, obligation?.id]);

  const amount = obligation
    ? formatMoney(obligation.totals.remainingMinor, obligation.totals.currency)
    : '';
  const methodLabel = PAY_METHODS.find((m) => m.token === method)?.label ?? null;
  const processing = pay.isProcessing;
  const blocked = pending !== null;

  const submit = async () => {
    if (!obligation || !method) return;
    setFailure(null);
    try {
      const outcome = (await pay.submit({
        path: { id: obligation.id },
        body: { paymentMethodToken: method },
      })) as PaymentOutcome;
      const status = outcome.payment.status;
      if (status === 'succeeded') {
        onPaid(outcome);
        return;
      }
      if (status === 'failed') {
        // 3b: the failed method turns red and the next one is picked for the parent.
        setDeclined({ token: method, paymentId: outcome.payment.id });
        const next = PAY_METHODS.find(
          (m) => m.token !== method && !/decline|timeout|unreachable/u.test(m.token),
        );
        setMethod(next?.token ?? null);
        return;
      }
      setPending(outcome);
    } catch (error) {
      setFailure(error as ApiError);
    }
  };

  const payLabel = processing
    ? 'Paying…'
    : declined && methodLabel
      ? `Pay ${amount} with ${methodLabel}`
      : `Pay ${amount}`;
  const art = activityArtwork['soccer-league'].square;

  const otherMethods = useMemo(
    () => PAY_METHODS.filter((m) => m.token !== declined?.token),
    [declined],
  );

  return (
    <Sheet
      open={open && obligation !== null}
      onClose={onClose}
      title={obligation ? `Pay for ${obligation.description}` : 'Pay'}
      locked={processing}
      returnFocusTo={returnFocusTo}
      headerContent={
        obligation ? (
          <View style={styles.tile}>
            <Artwork source={art} aspectRatio={1} style={styles.tileArt} />
            <View style={styles.tileWords}>
              <Text variant="headline" style={styles.tileTitle}>
                {obligation.description}
              </Text>
              <Text variant="footnote" tone="muted">
                {subtitle}
              </Text>
            </View>
          </View>
        ) : undefined
      }
      testID="pay-sheet"
    >
      {obligation ? (
        <View style={styles.body}>
          <View style={styles.amountBox} accessible accessibilityLabel={`Amount due ${amount}`}>
            <Text variant="callout" tone="muted" style={styles.center}>
              Amount due
            </Text>
            <Text style={styles.amount} testID="pay-amount">
              {amount}
            </Text>
          </View>

          {PAY_METHODS.length > 0 ? (
            <>
              {declined ? (
                <View style={[styles.method, styles.methodDeclined]} testID="pay-method-declined">
                  <View style={[styles.methodIcon, styles.methodIconDeclined]}>
                    <Icon name="credit_card_off" size={20} color={colors.danger} />
                  </View>
                  <View style={styles.methodWords}>
                    <Text variant="callout" style={styles.methodTitle}>
                      {PAY_METHODS.find((m) => m.token === declined.token)?.label ?? 'Card'}
                    </Text>
                    <StatusBadge tone="danger" label="Declined by your bank" />
                  </View>
                </View>
              ) : (
                <MethodRow
                  label={methodLabel ?? 'Add a payment method'}
                  onChange={() => setChoosing((v) => !v)}
                  disabled={processing}
                />
              )}
              {declined ? (
                <LiveRegion
                  announcement={sentences(NOT_CHARGED, DECLINED_TEXT)}
                  occurrence={declined.paymentId}
                  style={styles.declinedBox}
                  testID="pay-declined"
                >
                  <Text variant="callout" style={styles.declinedTitle}>
                    {NOT_CHARGED}
                  </Text>
                  <Text variant="callout">{DECLINED_TEXT}</Text>
                  <SupportDetails errorCode="card_declined" reference={declined.paymentId} />
                </LiveRegion>
              ) : null}
              {choosing || declined ? (
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={declined ? 'Other payment methods' : 'Payment method'}
                  style={styles.choices}
                >
                  {declined ? (
                    <Text variant="footnote" tone="muted" style={styles.semibold}>
                      Other payment methods
                    </Text>
                  ) : null}
                  {otherMethods.map((m) => (
                    <Pressable
                      key={m.token}
                      accessibilityRole="radio"
                      accessibilityLabel={m.label}
                      accessibilityState={{ checked: method === m.token }}
                      onPress={() => {
                        setMethod(m.token);
                        if (!declined) setChoosing(false);
                      }}
                      disabled={processing}
                      style={styles.choice}
                    >
                      <View style={[styles.radio, method === m.token ? styles.radioOn : null]}>
                        {method === m.token ? <View style={styles.radioDot} /> : null}
                      </View>
                      <View style={styles.methodWords}>
                        <Text variant="callout" style={styles.methodTitle}>
                          {m.label}
                        </Text>
                        <Text variant="footnote" tone="muted">
                          {DEV_PAYMENT_WORDS?.method ?? ''}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </>
          ) : (
            // DEC-019 (PA-11): no payment method can be collected in this build.
            <InfoCard
              tone="info"
              icon="storefront"
              message={PAY_AT_DESK_MESSAGE}
              testID="pay-at-desk"
            >
              <SupportDetails
                decisions={PAY_AT_DESK_SUPPORT.decisions}
                owner={PAY_AT_DESK_SUPPORT.owner}
              />
            </InfoCard>
          )}

          {pending ? (
            <LiveRegion
              announcement={sentences(paymentStatus(pending.payment.status).label)}
              occurrence={pending.payment.id}
              style={styles.pendingBox}
              testID="pay-pending"
            >
              <StatusBadge {...paymentStatus(pending.payment.status)} />
              <Text variant="callout">
                The payment is still being confirmed. Do not pay again: it will show in Payments
                once the provider answers.
              </Text>
              <Button
                label="Open the payment"
                variant="secondary"
                onPress={() => {
                  onClose();
                  router.push(`/payments/attempt/${pending.payment.id}` as Href);
                }}
              />
            </LiveRegion>
          ) : null}

          <CommandError
            wording="money"
            error={failure}
            what="the payment"
            onRetry={() => void submit()}
          />

          {PAY_METHODS.length > 0 ? (
            <Button
              label={payLabel}
              icon="lock"
              size="lg"
              block
              busy={processing}
              disabled={!method || offline || blocked}
              onPress={() => void submit()}
              accessibilityHint="Pays the amount due now"
              testID="pay-submit"
            />
          ) : null}
          {offline ? (
            <Text variant="footnote" tone="muted" style={styles.center}>
              Paying needs a connection.
            </Text>
          ) : null}
          <Text variant="footnote" tone="muted" style={styles.center} testID="pay-desk-line">
            {DESK_LINE}
          </Text>
        </View>
      ) : null}
    </Sheet>
  );
}

function MethodRow({
  label,
  onChange,
  disabled,
}: {
  label: string;
  onChange: () => void;
  disabled: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.method} testID="pay-method">
      <View style={styles.methodIcon}>
        <Icon name="credit_card" size={20} color={colors.text} />
      </View>
      <View style={styles.methodWords}>
        <Text variant="callout" style={styles.methodTitle}>
          {label}
        </Text>
        <Text variant="footnote" tone="muted">
          {DEV_PAYMENT_WORDS?.methodNoPayment ?? ''}
        </Text>
      </View>
      <Pressable
        onPress={onChange}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Change payment method"
        style={styles.change}
        hitSlop={8}
      >
        <Text variant="callout" tone="accent" style={styles.semibold}>
          Change
        </Text>
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles(({ colors, toneBackgrounds }) => ({
  tile: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  tileArt: { width: 52, height: 52, borderRadius: radius.sm },
  tileWords: { flex: 1, gap: 2 },
  tileTitle: { ...fonts.bold, fontSize: 19, lineHeight: 24 },
  body: { gap: spacing.md, paddingBottom: spacing.sm },
  amountBox: { alignItems: 'center', gap: spacing.xxs, paddingVertical: spacing.sm },
  center: { textAlign: 'center' },
  amount: { ...tabular(type.largeTitle), fontSize: 40, lineHeight: 46, color: colors.text },
  method: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  methodDeclined: {
    borderWidth: 2,
    borderColor: colors.danger,
    backgroundColor: toneBackgrounds.danger,
  },
  methodIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  methodIconDeclined: { backgroundColor: colors.background },
  methodWords: { flex: 1, gap: 2 },
  methodTitle: { ...fonts.bold },
  change: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
  semibold: { ...fonts.semibold },
  declinedBox: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: toneBackgrounds.danger,
  },
  declinedTitle: { ...fonts.bold, color: colors.danger },
  pendingBox: { gap: spacing.sm },
  choices: { gap: spacing.sm },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  radio: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.primary },
  radioDot: { width: 12, height: 12, borderRadius: radius.pill, backgroundColor: colors.primary },
}));
