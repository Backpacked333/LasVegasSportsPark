/**
 * Review & pay for a cart that already holds its lines (redesign handoff M 1f; SPK-REG-005 to
 * SPK-REG-009, SPK-PAY-007): the household cart (`/registration/basket/{id}` → "Review"), a
 * waitlist offer's held cart, and the old links of the replaced screens: a price
 * (`/registration/quote/{quoteId}`), a checkout (`/registration/checkout/{quoteId}`) and the forms
 * of a cart (`/registration/forms?basketId=`) all open here, so links in messages keep working.
 * The cart's lines are not changed here; the places are held, priced and paid as in the flow.
 */
import type { Schema } from '@sportspark/api-client';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { shortRange, weekLabel } from '../../features/register/fit';
import { useParticipantNames } from '../../features/registration/participants';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { useApp } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { useTheme } from '../../ui/theme';
import { ReviewController } from './register/ReviewController';
import { namesList } from './register/WhoStep';

type Basket = Schema<'Basket'>;

function CartReview({ basket, offerEndsAt }: { basket: Basket; offerEndsAt?: string | null }) {
  const router = useRouter();
  const [codes, setCodes] = useState<string[]>([]);
  const lines = basket.lines.filter((l) => l.outcome === 'pending' || l.outcome === 'held');
  const offeringIds = [...new Set(lines.map((l) => l.offeringId))];
  const offerings = useApiRecords('/offerings/{id}', offeringIds);
  const people = [...new Set(lines.map((l) => l.participantPersonId))];
  const names = useParticipantNames(people);
  const first = offeringIds[0] ? offerings[offeringIds[0]]?.data : undefined;
  const offering = offeringIds.length === 1 ? (first ?? null) : null;
  const camp =
    offeringIds.length > 1 && offeringIds.every((id) => offerings[id]?.data?.kind === 'camp');
  const nameOf = (id: string) => names(id);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return (
    <ReviewController
      basketId={basket.id}
      desired={null}
      waiting={false}
      offering={offering ?? (camp ? (first ?? null) : null)}
      subtitle={`For ${namesList(people.map(nameOf))}`}
      heldFor={`${namesList(people.map(nameOf))}'s ${lines.length > 1 ? 'places' : 'place'}`}
      weekNameOf={(id) => {
        const o = offerings[id]?.data;
        if (!o || offeringIds.length < 2) return null;
        return o.kind === 'camp'
          ? `${weekLabel(o.name)} · ${shortRange(o.startsOn, o.endsOn)}`
          : o.name;
      }}
      nameOf={nameOf}
      peopleIds={people}
      codes={codes}
      onCodes={setCodes}
      uniform={null}
      sizes={{}}
      onSize={() => undefined}
      onBasket={() => undefined}
      offerEndsAt={offerEndsAt}
      onStartOver={back}
      onBack={back}
    />
  );
}

export function ReviewScreen({
  basketId,
  offerEndsAt,
}: {
  basketId: string;
  offerEndsAt?: string | null;
}) {
  const { session } = useApp();
  const { colors } = useTheme();
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: basketId } },
    enabled: session.status === 'signed_in' && basketId !== '',
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.page }}>
      <RequireSession what="your registration">
        <QueryBoundary
          query={basket}
          label="registration"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['Holding places', 'Payment']}
          hideUpdated
        >
          {(b) => (
            <CartReview
              key={b.id}
              basket={b}
              offerEndsAt={offerEndsAt === undefined ? undefined : (offerEndsAt ?? b.holdExpiresAt)}
            />
          )}
        </QueryBoundary>
      </RequireSession>
    </View>
  );
}

/** A price or checkout link (the replaced quote and checkout screens): its cart's Review. */
export function QuoteReviewScreen({ quoteId }: { quoteId: string }) {
  const { session } = useApp();
  const { colors } = useTheme();
  const quote = useApiQuery({
    path: '/registration-quotes/{id}',
    request: { path: { id: quoteId } },
    enabled: session.status === 'signed_in' && quoteId !== '',
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.page }}>
      <RequireSession what="your registration">
        <QueryBoundary
          query={quote}
          label="registration"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['Holding places', 'Payment']}
          hideUpdated
        >
          {(q) => {
            // A price already used for a checkout opens that checkout's outcome (never pays twice).
            if (q.consumedByCheckoutId) {
              return <Redirect href={registrationRoutes.outcome(q.consumedByCheckoutId)} />;
            }
            return <ReviewScreen basketId={q.basketId} />;
          }}
        </QueryBoundary>
      </RequireSession>
    </View>
  );
}

/** Route component for app/registration/review/[basketId].tsx. */
export function ReviewRoute() {
  const params = useLocalSearchParams<{ basketId: string; offer?: string }>();
  const basketId = param(params.basketId) ?? '';
  // `?offer=1`: a taken waitlist place, held until the offer ends (the cart's hold expiry).
  const fromOffer = param(params.offer) === '1';
  return (
    <>
      <Stack.Screen options={{ title: 'Review', headerShown: false }} />
      <ReviewScreen basketId={basketId} offerEndsAt={fromOffer ? null : undefined} />
    </>
  );
}

/** Route component for app/registration/quote/[quoteId].tsx and checkout/[quoteId].tsx. */
export function QuoteReviewRoute() {
  const quoteId = param(useLocalSearchParams<{ quoteId: string }>().quoteId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Review', headerShown: false }} />
      <QuoteReviewScreen quoteId={quoteId} />
    </>
  );
}
