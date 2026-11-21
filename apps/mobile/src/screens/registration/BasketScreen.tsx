/**
 * SCR-C-11 Household basket, shown to customers as the cart (PA-11: basket → cart; ADR-008: a
 * container between the registration steps, not a step itself) (SPK-REG-004, SPK-REG-002, SPK-REG-003, SPK-REG-006, SPK-REG-008;
 * SPK-AT-001 two children in one purchase, SPK-AT-004 one equivalent entitlement, SPK-AT-005
 * final-place contention). Reads `GET /v1/baskets/{id}`: every line keeps its own participant,
 * offering, eligibility result and reasons, price basis, policies, approval and outcome; held
 * places show the server's expiry with an informational countdown.
 *
 * A checkout already started for this basket is found in `GET /v1/me/registration-checkouts`, so
 * "See your payment" works after a restart or reinstall (SPK-UX-001): in the newest page of all
 * the caller's checkouts, or among every page of those in recovery, which can be older than any
 * number of newer checkouts (R3-SCREEN-STATES-04). While neither read has found it, a failed read
 * is shown with its code and "Try again".
 *
 * Commands: remove a line (`POST /baskets/{id}/lines/{lineId}/remove`), get a price
 * (`POST /registration-quotes`, SCR-C-12), release held places (`POST /baskets/{id}/release`), and
 * join the waitlist for a line when no place is available (`POST /waitlist-entries`, SCR-C-16).
 * Every command sends the basket's `expectedRevision` where the API takes it and one idempotency
 * key per intent.
 *
 * Fulfillment is all-or-nothing (the proposed default). Partial fulfillment needs configuration
 * and the customer's explicit acceptance (DEC-026, Product and operations): the app never offers
 * it, and shows a basket that already has it as such.
 *
 * States: loading; empty (no lines); ready; validation failure (ineligible line with reasons,
 * DUPLICATE_ENTITLEMENT); permission restriction (a participant the payer may not pay for: the
 * quote is "not available"); stale (STALE_REVISION or a changed basket: reload); offline (basket
 * kept, price and checkout disabled); processing; success (quote ready).
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../ui/CommandError';
import { ExpiryNotice } from '../../features/registration/ExpiryNotice';
import { useFormsStatus, type FormsStatus } from '../../features/registration/forms';
import { formatMoney } from '../../features/registration/format';
import { basketLinePrice } from '../../features/registration/price-basis';
import { INTENT_LABELS } from '../../features/registration/intents';
import { JoinWaitlistButton } from '../../features/registration/JoinWaitlist';
import { useParticipantNames } from '../../features/registration/participants';
import {
  basketCheckoutOf,
  MY_BASKETS_KEY,
  useMyCheckouts,
  useRecoveryCheckouts,
} from '../../features/registration/in-progress';
import { useRegistrationProgress } from '../../features/registration/progress';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { basketLineStatus, basketStatus, holdStatus } from '../../features/registration/status';
import { useKnownFacilityZone } from '../../features/today/known-zone';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { illustrations } from '../../artwork/manifest';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { FieldValue } from '../../ui/Field';
import { Section } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { layout, makeStyles, spacing } from '../../ui/theme';

type Basket = Schema<'Basket'>;
type BasketLine = Schema<'BasketLine'>;

/** A failed command with the way to repeat that same intent (same idempotency key). */
interface Failure {
  error: ApiError;
  retry: () => void;
}

export const RELEASE_REASON = 'Released by the customer in the app';

/** A failure to show here: not "not available" (§4.10) and not offline (the banner says so). */
function visibleFailure(error: ApiError | null): ApiError | null {
  if (!error) return null;
  const presentation = presentationForError(error);
  return presentation === 'unavailable' || presentation === 'offline' ? null : error;
}

/**
 * A failed read behind a checking-out basket's checkout (the newest page of all checkouts, or the
 * first or a later page of those in recovery), with the way to read it again.
 */
function checkoutReadError(
  checkouts: { error: ApiError | null; refetch: () => unknown },
  recovery: ReturnType<typeof useRecoveryCheckouts>,
): Failure | null {
  const first = visibleFailure(checkouts.error);
  if (first) return { error: first, retry: () => void checkouts.refetch() };
  const recoveryFirst = recovery.data === undefined ? visibleFailure(recovery.error) : null;
  if (recoveryFirst) return { error: recoveryFirst, retry: () => void recovery.refetch() };
  const later = visibleFailure(recovery.nextPageError);
  return later ? { error: later, retry: recovery.loadMore } : null;
}

/** A line needs forms when the API's eligibility names a missing acknowledgment. */
export function lineNeedsForms(line: BasketLine): boolean {
  return line.eligibility?.reasons.some((r) => r.code === 'acknowledgment_missing') === true;
}

/** Reasons other than missing forms that make a line ineligible as entered. */
export function blockingReasons(line: BasketLine): string[] {
  if (!line.eligibility || line.eligibility.eligible || line.eligibility.overridden) return [];
  return line.eligibility.reasons
    .filter((r) => r.code !== 'acknowledgment_missing' && r.severity !== 'info')
    .map((r) => r.message);
}

function formsNote(line: BasketLine, participantName: string, forms: FormsStatus): string {
  const required = line.policies.requiredFormPolicyVersionIds;
  const plural = required.length === 1 ? 'form' : 'forms';
  if (!forms.known(line.participantPersonId)) {
    return `${required.length} required ${plural} for ${participantName}.`;
  }
  const unsigned = required.filter((id) => !forms.acknowledgment(line.participantPersonId, id));
  return unsigned.length === 0
    ? `Required ${plural} for ${participantName}: signed.`
    : `Required ${plural} for ${participantName}: ${unsigned.length} still to sign.`;
}

function LineCard({
  basket,
  line,
  participantName,
  offeringName,
  showWaitlist,
  offline,
  forms,
  onRemoved,
  onFailure,
}: {
  basket: Basket;
  line: BasketLine;
  participantName: string;
  offeringName: string;
  showWaitlist: boolean;
  offline: boolean;
  forms: FormsStatus;
  onRemoved: () => void;
  onFailure: (failure: Failure) => void;
}) {
  const styles = useStyles();
  const router = useRouter();
  const remove = useApiCommand('post', '/baskets/{id}/lines/{lineId}/remove', {
    invalidate: [['api', '/baskets/{id}'], MY_BASKETS_KEY],
  });
  const status = basketLineStatus(line);
  const reasons = blockingReasons(line);
  const alternatives =
    line.eligibility && !line.eligibility.eligible ? line.eligibility.alternatives : [];
  const title = `${participantName}: ${offeringName}`;
  const price = line.price ? basketLinePrice(line.price) : null;

  const removeLine = async () => {
    try {
      await remove.submit({
        path: { id: basket.id, lineId: line.id },
        body: { expectedRevision: basket.revision },
      });
      onRemoved();
    } catch (error) {
      onFailure({ error: error as ApiError, retry: () => void removeLine() });
    }
  };
  return (
    <Card style={styles.line} testID={`line-${line.id}`}>
      <View style={styles.lineHead}>
        <Avatar name={participantName} id={line.participantPersonId} decorative />
        <View style={styles.lineWords} accessible accessibilityLabel={`${title}. ${status.label}`}>
          <Text variant="headline">{title}</Text>
          <Text variant="caption" tone="muted">
            {INTENT_LABELS[line.intent].title}
          </Text>
          <StatusBadge {...status} />
        </View>
      </View>
      {price ? (
        // Only the amount the API sent; line totals belong to the quote (SPK-PAY-001, SCR-C-12).
        // SPK-PAY-013, SPK-PAY-014, SPK-PAY-015: where the line is priced per class, by tier or
        // at a member price, the API's estimate is shown, never the price of one class.
        <>
          <FieldValue layout="inline" label={price.label} value={price.value} />
          {price.notes.map((note) => (
            <Text key={note} variant="caption" tone="muted">
              {note}
            </Text>
          ))}
          {line.quantity > 1 ? (
            <FieldValue layout="inline" label="Quantity" value={String(line.quantity)} />
          ) : null}
        </>
      ) : (
        <FieldValue layout="inline" label="Price" value="No price published" />
      )}
      {line.selectedSessionIds ? (
        <FieldValue
          layout="inline"
          label="Days chosen"
          value={String(line.selectedSessionIds.length)}
          testID={`line-days-${line.id}`}
        />
      ) : null}
      {line.addons.map((addon) => (
        // SPK-PAY-014: each add-on with its own price; the quote shows it as its own line.
        <FieldValue
          layout="inline"
          key={addon.addonId}
          label={
            addon.selection === 'per_session'
              ? `${addon.name} × ${addon.quantity === 1 ? '1 day' : `${addon.quantity} days`}`
              : addon.name
          }
          value={`${formatMoney(addon.priceMinor, addon.currency)} each`}
        />
      ))}
      {line.uniform ? (
        // SPK-REG-012: the uniform and the size chosen for this participant.
        <>
          <FieldValue
            layout="inline"
            label={`${line.uniform.name}, size ${line.uniform.size}`}
            value={
              line.uniform.priceMinor !== null && line.uniform.currency
                ? formatMoney(line.uniform.priceMinor, line.uniform.currency)
                : 'Not charged'
            }
          />
          {line.uniform.returningHolderFree && line.uniform.heldUniformOrderId ? (
            <Text variant="caption" tone="muted">
              {`${participantName} already has this uniform: it is not charged again.`}
            </Text>
          ) : null}
        </>
      ) : null}
      {reasons.map((reason) => (
        <Text key={reason} variant="body">{`✕ ${reason}`}</Text>
      ))}
      {alternatives.map((alternative) => (
        <Text
          key={alternative.kind + alternative.message}
          variant="body"
        >{`→ ${alternative.message}`}</Text>
      ))}
      {line.policies.requiredFormPolicyVersionIds.length > 0 ? (
        <Text variant="caption" tone="muted">
          {formsNote(line, participantName, forms)}
        </Text>
      ) : null}
      <View style={styles.lineActions}>
        {line.intent === 'individual_league' && basket.status === 'open' ? (
          <Button
            label={`Add placement information for ${participantName}`}
            variant="secondary"
            onPress={() => router.push(registrationRoutes.placement(basket.id, line.id))}
          />
        ) : null}
        {showWaitlist ? (
          <JoinWaitlistButton line={line} participantName={participantName} disabled={offline} />
        ) : null}
        {basket.status === 'open' ? (
          <Button
            label={`Remove ${participantName} from the cart`}
            variant="secondary"
            onPress={() => void removeLine()}
            busy={remove.isProcessing}
            disabled={offline}
          />
        ) : null}
      </View>
    </Card>
  );
}

function BasketContent({ basket, refetch }: { basket: Basket; refetch: () => void }) {
  const styles = useStyles();
  const router = useRouter();
  const now = useNow();
  const zone = useKnownFacilityZone().zone;
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const { progress } = useRegistrationProgress();
  const checkingOut = basket.status === 'checking_out';
  const checkouts = useMyCheckouts(checkingOut);
  const recovery = useRecoveryCheckouts(checkingOut);
  const checkout = basketCheckoutOf(checkouts.data, recovery.data, basket.id);
  // Neither read found this basket's checkout and one of them failed: say so (SPK-UX-008).
  const checkoutReadFailure =
    !checkingOut || checkout ? null : checkoutReadError(checkouts, recovery);
  const [failure, setFailure] = useState<Failure | null>(null);
  const names = useParticipantNames(basket.lines.map((l) => l.participantPersonId));
  const offerings = useApiRecords(
    '/offerings/{id}',
    basket.lines.map((l) => l.offeringId),
  );
  const offeringName = (id: string) => offerings[id]?.data?.name ?? 'Activity';
  const release = useApiCommand('post', '/baskets/{id}/release', {
    invalidate: [['api', '/baskets/{id}'], MY_BASKETS_KEY],
  });

  const status = basketStatus(basket, now, zone);
  const ended = basket.status === 'expired' || basket.status === 'released';
  const forms = useFormsStatus(
    basket.lines.map((l) => ({
      participantPersonId: l.participantPersonId,
      policyVersionIds: l.policies.requiredFormPolicyVersionIds,
    })),
  );
  // The line's eligibility is a snapshot from when it was added; acknowledgments are current.
  const needsForms = forms.loading ? basket.lines.some(lineNeedsForms) : forms.outstanding > 0;
  const priceable =
    (basket.status === 'open' || basket.status === 'held') &&
    basket.lines.length > 0 &&
    !basket.approvalPending;

  // Review & pay (1f) holds the places, prices them and takes the forms and the payment.
  const getPrice = () => router.push(registrationRoutes.review(basket.id));
  const releaseHold = async () => {
    setFailure(null);
    try {
      await release.submit({
        path: { id: basket.id },
        body: { reason: RELEASE_REASON, expectedRevision: basket.revision },
      });
    } catch (error) {
      setFailure({ error: error as ApiError, retry: () => void releaseHold() });
    }
  };

  return (
    <View>
      <Section title="Your cart">
        <StatusBadge {...status} testID="basket-status" />
        <Text variant="caption" tone="muted">
          {basket.fulfillmentMode === 'partial'
            ? 'You accepted that some spots may be confirmed without the others.'
            : 'All spots in this cart are confirmed together, or none are.'}
        </Text>
      </Section>
      {checkoutReadFailure ? (
        <Section title="Your payment">
          <Text variant="body">The payment for this cart could not be looked up.</Text>
          <StateView
            variant="error"
            error={checkoutReadFailure.error}
            onRetry={checkoutReadFailure.retry}
          />
        </Section>
      ) : null}
      {basket.status === 'held' && basket.holdExpiresAt ? (
        <ExpiryNotice
          expiresAt={basket.holdExpiresAt}
          status={holdStatus(basket.holdExpiresAt, now, zone)}
          explanation="The facility's system lets your saved spots go at this time; the countdown is a guide."
          onLapsed={refetch}
          testID="basket-hold"
        />
      ) : null}
      {basket.approvalPending ? (
        <Section title="Approval">
          <Text variant="body">
            A line in this cart needs approval by staff before you can pay. Your spots are saved
            only when you check out.
          </Text>
        </Section>
      ) : null}
      {basket.lines.length === 0 ? (
        <EmptyState
          source={illustrations['empty-cart']}
          title="Your cart is empty"
          message="Add an activity from Explore."
          action={{
            label: 'Explore activities',
            onPress: () => router.push(registrationRoutes.discover()),
          }}
        />
      ) : (
        <View accessibilityRole="list" style={styles.lines}>
          {basket.lines.map((line) => (
            <LineCard
              key={line.id}
              basket={basket}
              line={line}
              participantName={names(line.participantPersonId)}
              offeringName={offeringName(line.offeringId)}
              showWaitlist={ended && line.outcome !== 'confirmed'}
              offline={offline}
              forms={forms}
              onRemoved={() => setFailure(null)}
              onFailure={setFailure}
            />
          ))}
        </View>
      )}
      {basket.currency && basket.lines.length > 0 ? (
        <Section title="Before taxes, fees and discounts">
          <FieldValue
            layout="inline"
            label="Subtotal"
            value={formatMoney(basket.subtotalMinor, basket.currency)}
            emphasis
          />
          <Text variant="caption" tone="muted">
            The review adds approved taxes and fees, discounts and credits.
          </Text>
        </Section>
      ) : null}
      <CommandError
        wording="registration"
        error={failure?.error ?? null}
        onRetry={failure?.retry}
        onReload={() => {
          setFailure(null);
          refetch();
        }}
        onCompleteForms={() => router.push(registrationRoutes.review(basket.id))}
      />
      <View style={styles.actions}>
        {needsForms && basket.status === 'open' ? (
          <Button
            label="Complete required forms"
            onPress={() => router.push(registrationRoutes.review(basket.id))}
          />
        ) : null}
        {priceable ? (
          <Button
            label="Review and pay"
            onPress={getPrice}
            disabled={offline}
            accessibilityHint="Holds your places, prices every line and takes the forms and payment"
          />
        ) : null}
        {checkingOut && checkout ? (
          // The API lists this basket's checkout (SPK-UX-001: also after a reinstall).
          <Button
            label="See your payment"
            onPress={() => router.push(registrationRoutes.outcome(checkout.id))}
          />
        ) : checkingOut && progress.pendingCheckoutQuoteId ? (
          // The checkout's answer never arrived (the app was closed mid-payment): the checkout
          // screen asks again for this quote, and the API returns the existing checkout.
          <Button
            label="Check your payment"
            onPress={() => router.push(registrationRoutes.review(basket.id))}
          />
        ) : null}
        {basket.status === 'held' ? (
          <Button
            label="Release my saved spots"
            variant="secondary"
            onPress={() => void releaseHold()}
            busy={release.isProcessing}
            disabled={offline}
          />
        ) : null}
        {(basket.status === 'open' && basket.lines.length > 0) || ended ? (
          <Button
            label="Add another activity"
            variant="secondary"
            onPress={() => router.push(registrationRoutes.discover())}
          />
        ) : null}
        {offline ? (
          <Text variant="caption" tone="muted">
            Getting a price and checking out need a connection. Your cart is kept.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function BasketScreen({ basketId }: { basketId: string }) {
  const { session } = useApp();
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: basketId } },
    enabled: session.status === 'signed_in',
  });
  return (
    <Screen>
      <RequireSession what="your cart">
        <QueryBoundary
          query={basket}
          label="your cart"
          empty={{ title: 'Your cart is empty', description: 'Add an activity from Explore.' }}
          unavailableOffline={['Getting a price', 'Checkout']}
        >
          {(b) => <BasketContent basket={b} refetch={() => void basket.refetch()} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/basket/[basketId].tsx. */
export function BasketRoute() {
  const basketId = param(useLocalSearchParams<{ basketId: string }>().basketId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Cart' }} />
      <BasketScreen basketId={basketId} />
    </>
  );
}

const useStyles = makeStyles(() => ({
  lines: { gap: layout.cardGap, paddingHorizontal: layout.gutter, marginTop: spacing.lg },
  line: { gap: spacing.xs },
  lineHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  lineWords: { flex: 1, gap: spacing.xs },
  lineActions: { gap: spacing.sm, paddingTop: spacing.xs },
  actions: { gap: spacing.sm, paddingHorizontal: layout.gutter, paddingVertical: spacing.lg },
}));
