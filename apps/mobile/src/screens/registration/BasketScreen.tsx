/**
 * SCR-C-11 Household basket (SPK-REG-004, SPK-REG-002, SPK-REG-003, SPK-REG-006, SPK-REG-008;
 * SPK-AT-001 two children in one purchase, SPK-AT-004 one equivalent entitlement, SPK-AT-005
 * final-place contention). Reads `GET /v1/baskets/{id}`: every line keeps its own participant,
 * offering, eligibility result and reasons, price basis, policies, approval and outcome; held
 * places show the server's expiry with an informational countdown.
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
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import { ExpiryNotice } from '../../features/registration/ExpiryNotice';
import { useFormsStatus, type FormsStatus } from '../../features/registration/forms';
import { formatMoney } from '../../features/registration/format';
import { INTENT_LABELS } from '../../features/registration/intents';
import { JoinWaitlistButton } from '../../features/registration/JoinWaitlist';
import { useParticipantNames } from '../../features/registration/participants';
import { useRegistrationProgress } from '../../features/registration/progress';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { basketLineStatus, basketStatus, holdStatus } from '../../features/registration/status';
import { Body, ButtonRow, Detail, Section } from '../../features/registration/ui';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';

type Basket = Schema<'Basket'>;
type BasketLine = Schema<'BasketLine'>;

/** A failed command with the way to repeat that same intent (same idempotency key). */
interface Failure {
  error: ApiError;
  retry: () => void;
}

export const RELEASE_REASON = 'Released by the customer in the app';

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
  const router = useRouter();
  const remove = useApiCommand('post', '/baskets/{id}/lines/{lineId}/remove', {
    invalidate: [['api', '/baskets/{id}']],
  });
  const status = basketLineStatus(line);
  const reasons = blockingReasons(line);
  const alternatives =
    line.eligibility && !line.eligibility.eligible ? line.eligibility.alternatives : [];
  const title = `${participantName}: ${offeringName}`;

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
    <View style={styles.line} testID={`line-${line.id}`}>
      <View accessible accessibilityLabel={`${title}. ${status.label}`}>
        <Body>{title}</Body>
        <Body muted>{INTENT_LABELS[line.intent].title}</Body>
        <StatusBadge {...status} />
      </View>
      {line.price ? (
        <Detail
          label="Base price"
          value={formatMoney(line.price.basePriceMinor * line.quantity, line.price.currency)}
        />
      ) : (
        <Detail label="Price" value="No price published" />
      )}
      {reasons.map((reason) => (
        <Body key={reason}>{`✕ ${reason}`}</Body>
      ))}
      {alternatives.map((alternative) => (
        <Body key={alternative.kind + alternative.message}>{`→ ${alternative.message}`}</Body>
      ))}
      {line.policies.requiredFormPolicyVersionIds.length > 0 ? (
        <Body muted>{formsNote(line, participantName, forms)}</Body>
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
            label={`Remove ${participantName} from the basket`}
            variant="secondary"
            onPress={() => void removeLine()}
            busy={remove.isProcessing}
            disabled={offline}
          />
        ) : null}
      </View>
    </View>
  );
}

function BasketContent({ basket, refetch }: { basket: Basket; refetch: () => void }) {
  const router = useRouter();
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const { progress, update } = useRegistrationProgress();
  const [failure, setFailure] = useState<Failure | null>(null);
  const names = useParticipantNames(basket.lines.map((l) => l.participantPersonId));
  const offerings = useApiRecords(
    '/offerings/{id}',
    basket.lines.map((l) => l.offeringId),
  );
  const offeringName = (id: string) => offerings[id]?.data?.name ?? 'Activity';
  const quote = useApiCommand('post', '/registration-quotes');
  const release = useApiCommand('post', '/baskets/{id}/release', {
    invalidate: [['api', '/baskets/{id}']],
  });

  const status = basketStatus(basket, now);
  const ended = basket.status === 'expired' || basket.status === 'released';
  const capacityFailed = failure?.error.code === 'CAPACITY_UNAVAILABLE';
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

  const getPrice = async () => {
    setFailure(null);
    try {
      const created = await quote.submit({
        body: { basketId: basket.id, discountCodes: [], creditIds: [] },
      });
      await update({ basketId: basket.id, quoteId: created.id });
      router.push(registrationRoutes.quote(created.id));
    } catch (error) {
      setFailure({ error: error as ApiError, retry: () => void getPrice() });
    }
  };
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
      <Section title="Your basket">
        <StatusBadge {...status} testID="basket-status" />
        <Body muted>
          {basket.fulfillmentMode === 'partial'
            ? 'You accepted that some places may be confirmed without the others.'
            : 'All places in this basket are confirmed together, or none are.'}
        </Body>
      </Section>
      {basket.status === 'held' && basket.holdExpiresAt ? (
        <ExpiryNotice
          expiresAt={basket.holdExpiresAt}
          status={holdStatus(basket.holdExpiresAt, now)}
          explanation="The facility's system releases held places at this time; the countdown is a guide."
          onLapsed={refetch}
          testID="basket-hold"
        />
      ) : null}
      {basket.approvalPending ? (
        <Section title="Approval">
          <Body>
            A line in this basket needs approval by staff before you can pay. Places are held only
            when you check out.
          </Body>
        </Section>
      ) : null}
      {basket.lines.length === 0 ? (
        <Section title="Nothing in your basket">
          <Body>Add an activity from Discover.</Body>
        </Section>
      ) : (
        <View accessibilityRole="list">
          {basket.lines.map((line) => (
            <LineCard
              key={line.id}
              basket={basket}
              line={line}
              participantName={names(line.participantPersonId)}
              offeringName={offeringName(line.offeringId)}
              showWaitlist={(capacityFailed || ended) && line.outcome !== 'confirmed'}
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
          <Detail label="Subtotal" value={formatMoney(basket.subtotalMinor, basket.currency)} />
          <Body muted>Your quote adds approved taxes and fees, discounts and credits.</Body>
        </Section>
      ) : null}
      <CommandError
        error={failure?.error ?? null}
        onRetry={failure?.retry}
        onReload={() => {
          setFailure(null);
          refetch();
        }}
        onCompleteForms={() => router.push(registrationRoutes.basketForms(basket.id))}
      />
      {capacityFailed ? (
        <Section title="No place available">
          <Body>
            There is no place left for at least one line. Nothing was charged. You can join the
            waitlist for a participant, or remove the line and continue.
          </Body>
        </Section>
      ) : null}
      <ButtonRow>
        {needsForms && basket.status === 'open' ? (
          <Button
            label="Complete required forms"
            onPress={() => router.push(registrationRoutes.basketForms(basket.id))}
          />
        ) : null}
        {priceable ? (
          <Button
            label="Get your price"
            onPress={() => void getPrice()}
            busy={quote.isProcessing}
            disabled={offline}
            accessibilityHint="Prices every line from the facility's current price rules"
          />
        ) : null}
        {basket.status === 'checking_out' && progress.checkoutId ? (
          <Button
            label="See your payment"
            onPress={() => router.push(registrationRoutes.outcome(progress.checkoutId as string))}
          />
        ) : null}
        {basket.status === 'held' ? (
          <Button
            label="Release my held places"
            variant="secondary"
            onPress={() => void releaseHold()}
            busy={release.isProcessing}
            disabled={offline}
          />
        ) : null}
        {basket.status === 'open' || ended ? (
          <Button
            label="Add another activity"
            variant="secondary"
            onPress={() => router.push(registrationRoutes.discover())}
          />
        ) : null}
        {offline ? (
          <Body muted>
            Getting a price and checking out need a connection. Your basket is kept.
          </Body>
        ) : null}
      </ButtonRow>
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
      <RequireSession what="your basket">
        <QueryBoundary
          query={basket}
          label="your basket"
          empty={{ title: 'Nothing in your basket', description: 'Add an activity from Discover.' }}
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
      <Stack.Screen options={{ title: 'Basket' }} />
      <BasketScreen basketId={basketId} />
    </>
  );
}

const styles = StyleSheet.create({
  line: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  lineActions: { gap: spacing.sm, paddingTop: spacing.xs },
});
