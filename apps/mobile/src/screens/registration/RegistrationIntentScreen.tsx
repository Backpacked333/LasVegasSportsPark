/**
 * SCR-C-09 Registration intent chooser (SPK-REG-001, SPK-IAM-003, SPK-REG-003, SPK-REG-004;
 * journeys A3, C2; SPK-AT-001 a returning parent registers two children). Choose how to register
 * (individual league entry, create a team entry, youth enrollment, rental request; joining a known
 * team and session bookings are explained), then the participant(s), then add one basket line per
 * participant: `POST /v1/baskets` when no open basket is in progress, then
 * `POST /v1/baskets/{id}/lines` with the basket's `expectedRevision`.
 *
 * Who can be chosen comes from `GET /v1/me` authorities (the API's answer, never inferred): a
 * person the account may only view is listed as not available to register. The API checks again on
 * every line (PARTICIPANT_AUTHORITY_REQUIRED, ELIGIBILITY reasons on the line,
 * DUPLICATE_ENTITLEMENT without revealing who else registered, SPK-AT-004).
 *
 * States: loading; empty (no one to register: family setup is in Account); ready; validation
 * failure (intent not available for this offering, API errors with field messages); permission
 * restriction; stale (offering no longer open, basket changed: reload); offline (cannot start, the
 * choice is kept); processing (adding); success (the basket, SCR-C-11).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import type { RegistrationIntent } from '../../features/registration/format';
import { INTENT_HANDLING, INTENT_LABELS, intentsFor } from '../../features/registration/intents';
import { useParticipants, type Participant } from '../../features/registration/participants';
import { useRegistrationProgress } from '../../features/registration/progress';
import { param, registrationRoutes } from '../../features/registration/routes';
import { registrationWindowStatus } from '../../features/registration/status';
import { Body, ButtonRow, ChoiceRow, Section, Title } from '../../features/registration/ui';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Offering = Schema<'Offering'>;
type Basket = Schema<'Basket'>;

const HANDLING_NOTE = {
  team_invitation: 'Joining a team uses the invitation the team sends you (Account, invitations).',
  session_booking: 'Booking a single session is not available in the app yet.',
} as const;

function canRegister(participant: Participant): boolean {
  return participant.self || participant.permissions.includes('register');
}

function IntentChooser({ offering }: { offering: Offering }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const { participants, me, namesLoading } = useParticipants();
  const { progress, update } = useRegistrationProgress();
  const intents = intentsFor(offering.kind);
  const firstBasketIntent = intents.find((i) => INTENT_HANDLING[i] === 'basket') ?? null;
  const [intent, setIntent] = useState<RegistrationIntent | null>(firstBasketIntent);
  const [selected, setSelected] = useState<string[]>([]);
  /** Participants already added in this intent, so a retry never adds them twice. */
  const [added, setAdded] = useState<string[]>([]);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [working, setWorking] = useState(false);
  /** The basket as the API last answered in this intent (its revision is the next expected one). */
  const [lastBasket, setLastBasket] = useState<Basket | null>(null);

  const current = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: progress.basketId ?? '' } },
    enabled: progress.basketId !== null,
  });
  const openBasket = current.data?.status === 'open' ? current.data : null;
  const createBasket = useApiCommand('post', '/baskets');
  const addLine = useApiCommand('post', '/baskets/{id}/lines', {
    invalidate: [['api', '/baskets/{id}']],
  });

  if (me.isPending || namesLoading) {
    return <StateView variant="loading" label="your family" />;
  }
  if (me.error) {
    return <CommandError error={me.error} onRetry={() => void me.refetch()} />;
  }
  if (participants.length === 0) {
    return (
      <StateView
        variant="empty"
        title="No one to register yet"
        description="Add yourself or your family members in Account, then come back to register."
        actionLabel="Open Account"
        onAction={() => router.push('/account')}
      />
    );
  }

  const toggle = (personId: string) =>
    setSelected((list) =>
      list.includes(personId) ? list.filter((id) => id !== personId) : [...list, personId],
    );

  const submit = async () => {
    if (!intent) return;
    setWorking(true);
    setFailure(null);
    try {
      let basket: Basket | null = lastBasket ?? openBasket;
      if (!basket) {
        // SPK-REG-004 proposed default; partial fulfillment is never offered (DEC-026).
        basket = await createBasket.submit({
          body: { fulfillmentMode: 'all_or_nothing', acceptPartialFulfillment: false },
        });
        setLastBasket(basket);
        await update({ basketId: basket.id, quoteId: null, checkoutId: null });
      }
      for (const personId of selected) {
        if (added.includes(personId)) continue;
        basket = await addLine.submit({
          path: { id: basket.id },
          body: {
            participantPersonId: personId,
            offeringId: offering.id,
            intent,
            quantity: 1,
            expectedRevision: basket.revision,
          },
        });
        setLastBasket(basket);
        setAdded((list) => [...list, personId]);
      }
      router.push(registrationRoutes.basket(basket.id));
    } catch (error) {
      setFailure(error as ApiError);
    } finally {
      setWorking(false);
    }
  };

  const basketIntent = intent !== null && INTENT_HANDLING[intent] === 'basket';
  const pending = selected.filter((id) => !added.includes(id));
  return (
    <View>
      <Section title="How do you want to register?">
        <View accessibilityRole="radiogroup">
          {intents.map((option) => {
            const handling = INTENT_HANDLING[option];
            return (
              <ChoiceRow
                key={option}
                mode="radio"
                label={INTENT_LABELS[option].title}
                detail={
                  handling === 'basket'
                    ? INTENT_LABELS[option].description
                    : `${INTENT_LABELS[option].description} ${HANDLING_NOTE[handling]}`
                }
                checked={intent === option}
                disabled={handling !== 'basket'}
                onToggle={() => setIntent(option)}
                testID={`intent-${option}`}
              />
            );
          })}
        </View>
        {intents.length === 0 ? (
          <Body>This activity cannot be registered for in the app.</Body>
        ) : null}
      </Section>
      {basketIntent ? (
        <Section title="Who are you registering?">
          {participants.map((p) => {
            const allowed = canRegister(p);
            const isAdded = added.includes(p.personId);
            return (
              <ChoiceRow
                key={p.personId}
                label={p.displayName}
                detail={
                  isAdded
                    ? 'Added to your basket'
                    : allowed
                      ? undefined
                      : 'Not available: your account can view this person but not register them.'
                }
                checked={selected.includes(p.personId)}
                disabled={!allowed || isAdded}
                onToggle={() => toggle(p.personId)}
                testID={`participant-${p.self ? 'self' : p.personId}`}
              />
            );
          })}
        </Section>
      ) : null}
      <CommandError
        error={failure}
        onRetry={() => void submit()}
        onReload={() => void current.refetch()}
      />
      {basketIntent ? (
        <ButtonRow>
          <Button
            label={
              pending.length > 1
                ? `Add ${pending.length} people to your basket`
                : 'Add to your basket'
            }
            onPress={() => void submit()}
            disabled={pending.length === 0 || offline}
            busy={working}
          />
          {offline ? (
            <Body muted>Adding to your basket needs a connection. Your choices are kept.</Body>
          ) : null}
        </ButtonRow>
      ) : null}
    </View>
  );
}

export function RegistrationIntentScreen({ offeringId }: { offeringId: string }) {
  const { session } = useApp();
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    enabled: session.status === 'signed_in',
  });
  return (
    <Screen>
      <RequireSession what="registration">
        <QueryBoundary
          query={offering}
          label="activity"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['Registration']}
        >
          {(o) => (
            <View>
              <Section title="Register for">
                <Title>{o.name}</Title>
                <StatusBadge {...registrationWindowStatus(o)} />
              </Section>
              {o.publicationState === 'registration_open' ? (
                <IntentChooser offering={o} />
              ) : (
                <StateView
                  variant="unavailable"
                  title="Registration is not open"
                  description="Registration for this activity is not open now. Existing registrations are kept."
                />
              )}
            </View>
          )}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/start/[offeringId].tsx. */
export function RegistrationIntentRoute() {
  const offeringId = param(useLocalSearchParams<{ offeringId: string }>().offeringId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Register' }} />
      <RegistrationIntentScreen offeringId={offeringId} />
    </>
  );
}
