/**
 * SCR-C-16 Waitlist status and offer (SPK-REG-008, SPK-AT-006 late payment never displaces a valid
 * offer, POL-006, DEC-006; journey A3). Reads `GET /v1/waitlist-entries/{id}`: participant,
 * offering, status, position and offer history. An open offer shows its server expiry ("Place
 * offered. Accept by <server time>.") with an informational countdown; accepting
 * (`POST /v1/waitlist-offers/{id}/accept` with the offer's `expectedRevision`) consumes the
 * reserved place once and hands off to the held basket (SCR-C-11) and checkout (SCR-C-14).
 * Declining (`/decline`) releases it; leaving the waitlist is `POST /waitlist-entries/{id}/withdraw`.
 *
 * Offer duration and priority are POL-006 / DEC-006 (Product and operations): the app shows only
 * the server's expiry, never a duration of its own.
 *
 * States: loading; ready; validation failure (no longer eligible, forms missing); permission
 * restriction (an entry the account may not see is "not available"); stale (offer expired or
 * already accepted: reload); offline (offer shown with its expiry, accept disabled); processing
 * (accepting); success (held basket).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import { ExpiryNotice } from '../../features/registration/ExpiryNotice';
import { formatInstant } from '../../features/registration/format';
import { useParticipantNames } from '../../features/registration/participants';
import { MY_BASKETS_KEY, MY_WAITLIST_KEY } from '../../features/registration/in-progress';
import { param, registrationRoutes } from '../../features/registration/routes';
import {
  openOffer,
  waitlistEntryStatus,
  waitlistOfferStatus,
} from '../../features/registration/status';
import { Body, ButtonRow, Detail, Section } from '../../features/registration/ui';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';

type WaitlistEntry = Schema<'WaitlistEntry'>;

interface Failure {
  error: ApiError;
  retry: () => void;
}

function EntryContent({ entry, refetch }: { entry: WaitlistEntry; refetch: () => void }) {
  const router = useRouter();
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const names = useParticipantNames([entry.participantPersonId]);
  const name = names(entry.participantPersonId);
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: entry.offeringId } },
  });
  const offeringName = offering.data?.name ?? 'this activity';
  /** SPK-SCHED-008: the offer deadline in the facility's zone when the offering is readable. */
  const timeZone = offering.data?.facility.timezone;
  const [failure, setFailure] = useState<Failure | null>(null);
  const invalidate = [['api', '/waitlist-entries/{id}'], MY_WAITLIST_KEY] as const;
  const accept = useApiCommand('post', '/waitlist-offers/{id}/accept', {
    invalidate: [...invalidate, MY_BASKETS_KEY],
  });
  const decline = useApiCommand('post', '/waitlist-offers/{id}/decline', { invalidate });
  const withdraw = useApiCommand('post', '/waitlist-entries/{id}/withdraw', { invalidate });
  const offer = openOffer(entry);

  const acceptOffer = async () => {
    if (!offer) return;
    setFailure(null);
    try {
      const result = await accept.submit({
        path: { id: offer.id },
        body: { expectedRevision: offer.revision },
      });
      if (result.basket) {
        router.push(registrationRoutes.basket(result.basket.id));
      } else {
        refetch();
      }
    } catch (error) {
      setFailure({ error: error as ApiError, retry: () => void acceptOffer() });
    }
  };
  const declineOffer = async () => {
    if (!offer) return;
    setFailure(null);
    try {
      await decline.submit({ path: { id: offer.id }, body: { expectedRevision: offer.revision } });
    } catch (error) {
      setFailure({ error: error as ApiError, retry: () => void declineOffer() });
    }
  };
  const leave = async () => {
    setFailure(null);
    try {
      await withdraw.submit({ path: { id: entry.id }, body: { expectedRevision: entry.revision } });
    } catch (error) {
      setFailure({ error: error as ApiError, retry: () => void leave() });
    }
  };

  const active = entry.status === 'waiting' || entry.status === 'offered';
  return (
    <View>
      <Section title={name === 'You' ? 'Your place on the waitlist' : `Waitlist for ${name}`}>
        <Body>{offeringName}</Body>
        <StatusBadge
          {...waitlistEntryStatus(entry, offeringName, now, timeZone)}
          testID="waitlist-status"
        />
        <Detail label="Joined" value={formatInstant(entry.joinedAt, timeZone)} />
      </Section>

      {offer ? (
        <Section title="A place is offered">
          <ExpiryNotice
            expiresAt={offer.expiresAt}
            status={waitlistOfferStatus(offer, now, timeZone)}
            explanation="The place is reserved for you until this time; after it, the place is released under the waitlist policy. The countdown is a guide."
            onLapsed={refetch}
            testID="waitlist-offer"
          />
          <ButtonRow>
            <Button
              label="Accept the place"
              onPress={() => void acceptOffer()}
              busy={accept.isProcessing}
              disabled={offline}
              accessibilityHint="Holds the place in a basket so you can pay"
            />
            <Button
              label="Decline the offer"
              variant="secondary"
              onPress={() => void declineOffer()}
              busy={decline.isProcessing}
              disabled={offline}
            />
            {offline ? <Body muted>Accepting needs a connection.</Body> : null}
          </ButtonRow>
        </Section>
      ) : null}

      <CommandError
        error={failure?.error ?? null}
        onRetry={failure?.retry}
        onReload={() => {
          setFailure(null);
          refetch();
        }}
        onAlternatives={() => {
          setFailure(null);
          refetch();
        }}
        onCompleteForms={() => router.push(registrationRoutes.waitlistForms(entry.id))}
      />

      {entry.offers.length > 0 ? (
        <Section title="Offer history">
          <View accessibilityRole="list">
            {entry.offers.map((o) => (
              <View
                key={o.id}
                style={styles.offer}
                accessible
                accessibilityLabel={`Offered ${formatInstant(o.offeredAt, timeZone)}. ${waitlistOfferStatus(o, now, timeZone).label}`}
              >
                <Body>{`Offered ${formatInstant(o.offeredAt, timeZone)}`}</Body>
                <StatusBadge {...waitlistOfferStatus(o, now, timeZone)} />
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      {active ? (
        <ButtonRow>
          <Button
            label="Leave the waitlist"
            variant="secondary"
            onPress={() => void leave()}
            busy={withdraw.isProcessing}
            disabled={offline}
          />
        </ButtonRow>
      ) : null}
    </View>
  );
}

export function WaitlistScreen({ entryId }: { entryId: string }) {
  const { session } = useApp();
  const entry = useApiQuery({
    path: '/waitlist-entries/{id}',
    request: { path: { id: entryId } },
    enabled: session.status === 'signed_in',
  });
  return (
    <Screen>
      <RequireSession what="your waitlist">
        <QueryBoundary
          query={entry}
          label="waitlist"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['Accepting an offer', 'Leaving the waitlist']}
        >
          {(e) => <EntryContent entry={e} refetch={() => void entry.refetch()} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/waitlist/[entryId].tsx. */
export function WaitlistRoute() {
  const entryId = param(useLocalSearchParams<{ entryId: string }>().entryId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Waitlist' }} />
      <WaitlistScreen entryId={entryId} />
    </>
  );
}

const styles = StyleSheet.create({
  offer: {
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
