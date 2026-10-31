/**
 * "In progress" on Discover (SCR-C-07 entry to SCR-C-11, SCR-C-14, SCR-C-15, SCR-C-16; SPK-UX-001,
 * SPK-AT-023, SPK-PAY-007, §4.11): what the customer started and can come back to, from the API's
 * own lists, so it is there after a restart, a reinstall or on another device.
 *
 * Order: a checkout request whose answer never arrived (the only thing the device remembers),
 * then checkouts that need attention ("Payment received. We are completing your registration.",
 * "Payment outcome being confirmed. Do not pay again.", "Payment processing"), baskets still open
 * or held, and waitlist offers with the server's deadline (in the facility zone of the entry's
 * offering, SPK-SCHED-008). Each read has its own error state
 * (code and "Try again"); a list the API does not show this account is simply absent.
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import {
  basketInProgress,
  checkoutNeedsAttention,
  useMyBaskets,
  useMyCheckouts,
  useMyOffers,
} from './in-progress';
import { useParticipantNames } from './participants';
import { useRegistrationProgress } from './progress';
import { useOfferingTimeZones } from './queries';
import { registrationRoutes } from './routes';
import { basketStatus, checkoutStatus, offerDeadlineStatus } from './status';
import { Body, Section } from './ui';

type Basket = Schema<'Basket'>;

function ReadError({ error, onRetry }: { error: ApiError | null; onRetry: () => void }) {
  // Not available to this account, or offline (the banner says so): nothing to add here.
  if (!error) return null;
  const presentation = presentationForError(error);
  if (presentation === 'unavailable' || presentation === 'offline') return null;
  return <StateView variant="error" error={error} onRetry={onRetry} />;
}

function lineCount(basket: Basket): string {
  return `${basket.lines.length} registration${basket.lines.length === 1 ? '' : 's'}`;
}

export function InProgressCard() {
  const router = useRouter();
  const now = useNow();
  const { progress, update } = useRegistrationProgress();
  const baskets = useMyBaskets();
  const checkouts = useMyCheckouts();
  const offers = useMyOffers();

  const attention = (checkouts.data?.items ?? []).filter(checkoutNeedsAttention);
  const coveredBaskets = new Set(attention.map((c) => c.basketId));
  const active = (baskets.data?.items ?? []).filter(
    (b) => basketInProgress(b) && !coveredBaskets.has(b.id),
  );
  const offered = (offers.data?.items ?? []).filter((e) => e.openOffer?.status === 'offered');
  const names = useParticipantNames(offered.map((e) => e.participantPersonId));
  /** SPK-SCHED-008: offer deadlines in the facility zone of the entry's offering. */
  const zoneOf = useOfferingTimeZones(offered.map((e) => e.offeringId));
  const pendingQuote = progress.pendingCheckoutQuoteId;
  // The API now lists that checkout: its own row says what is known about it.
  const pendingListed =
    pendingQuote !== null && (checkouts.data?.items ?? []).some((c) => c.quoteId === pendingQuote);
  // Once the API lists it, the device no longer needs to remember the unanswered request.
  useEffect(() => {
    if (pendingListed) void update({ pendingCheckoutQuoteId: null });
  }, [pendingListed, update]);
  const loading =
    (baskets.data === undefined && baskets.fetchStatus === 'fetching') ||
    (checkouts.data === undefined && checkouts.fetchStatus === 'fetching') ||
    (offers.data === undefined && offers.fetchStatus === 'fetching');
  const nothing =
    baskets.data !== undefined &&
    checkouts.data !== undefined &&
    offers.data !== undefined &&
    attention.length + active.length + offered.length === 0 &&
    !(pendingQuote && !pendingListed);

  return (
    <Section title="In progress" testID="discover-resume">
      {pendingQuote && !pendingListed ? (
        // A checkout was sent and its answer never arrived: that payment comes first.
        <Button
          label="Check your payment and registration"
          onPress={() => router.push(registrationRoutes.checkout(pendingQuote))}
        />
      ) : null}
      {loading ? <StateView variant="loading" label="registrations in progress" /> : null}
      <ReadError error={checkouts.error} onRetry={() => void checkouts.refetch()} />
      <ReadError error={baskets.error} onRetry={() => void baskets.refetch()} />
      <ReadError error={offers.error} onRetry={() => void offers.refetch()} />
      <View accessibilityRole="list">
        {attention.map((checkout) => (
          <ListRow
            key={checkout.id}
            title="Payment and registration"
            status={checkoutStatus(checkout)}
            onPress={() => router.push(registrationRoutes.outcome(checkout.id))}
            accessibilityHint="Opens what is known about this payment and registration"
            testID={`resume-checkout-${checkout.id}`}
          />
        ))}
        {active.map((basket) => (
          <ListRow
            key={basket.id}
            title="Your basket"
            detail={lineCount(basket)}
            status={basketStatus(basket, now)}
            onPress={() => router.push(registrationRoutes.basket(basket.id))}
            accessibilityHint="Continues this registration"
            testID={`resume-basket-${basket.id}`}
          />
        ))}
        {offered.map((entry) => (
          <ListRow
            key={entry.id}
            title={`${names(entry.participantPersonId)}: ${entry.offeringName ?? 'Activity'}`}
            status={offerDeadlineStatus(
              (entry.openOffer as { expiresAt: string }).expiresAt,
              now,
              zoneOf(entry.offeringId),
            )}
            onPress={() => router.push(registrationRoutes.waitlist(entry.id))}
            accessibilityHint="Opens the offer so you can accept or decline it"
            testID={`resume-offer-${entry.id}`}
          />
        ))}
      </View>
      {nothing ? <Body muted>Nothing in progress right now.</Body> : null}
      <View style={styles.more}>
        <Button
          label="Your waitlists"
          variant="secondary"
          onPress={() => router.push(registrationRoutes.waitlists())}
        />
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  more: { paddingTop: spacing.xs },
});
