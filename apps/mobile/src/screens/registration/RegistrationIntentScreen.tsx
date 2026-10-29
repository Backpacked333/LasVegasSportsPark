/**
 * SCR-C-09 Registration intent chooser (SPK-REG-001, SPK-REG-002, SPK-IAM-003, SPK-REG-003,
 * SPK-REG-004; journeys A3, C2; SPK-AT-001 a returning parent registers two children).
 *
 * The intents offered are the API's: `GET /v1/offerings/{id}/registration-options`
 * `availableIntents` (ENR-05), never a table kept in the app. The same read names, per person the
 * account may register, the read-only eligibility of each intent; a person the API leaves out
 * (the account may only view them) is listed as not available to register, without a reason.
 *
 * How each intent is carried:
 * - basket intents (individual league entry, create a team entry, youth enrollment, membership,
 *   session package): choose the participant(s), then one basket line per participant:
 *   `POST /v1/baskets` when no open basket exists (the newest open one of `GET /v1/me/baskets`
 *   is reused), then `POST /v1/baskets/{id}/lines` with the basket's `expectedRevision`;
 * - rentals and parties exist only with their reservation: "Continue to booking" opens the
 *   Package G booking route (`/bookings/new/{offeringId}`), which this screen does not build;
 * - makeups are booked from the participant's makeup sessions (SCR-C-35); joining a known team
 *   uses the team's invitation; trials and pickup sessions are explained, not built.
 * A Package G intent whose capability switch is off reads "turned off" (DEC-016, DEC-072,
 * DEC-074, DEC-076, DEC-077, DEC-082), and a command refused with CAPABILITY_DISABLED shows the
 * same state.
 *
 * The API checks again on every line (PARTICIPANT_AUTHORITY_REQUIRED, eligibility reasons on the
 * line, DUPLICATE_ENTITLEMENT without revealing who else registered, SPK-AT-004).
 *
 * States: loading; empty (no one to register: family setup is in Account); ready; validation
 * failure (intent not available for this offering, a participant not eligible with the API's
 * reasons and alternatives, API errors with field messages); permission restriction; stale
 * (offering no longer open, basket changed: reload); offline (cannot start, the choice is kept);
 * processing (adding); success (the basket, SCR-C-11); turned off.
 */
import {
  CAPABILITY_PRESENTATION,
  turnedOffLabel,
  type ApiError,
  type Schema,
} from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { moneyRoutes } from '../../features/money/routes';
import { packageGRoutes } from '../../features/package-g/routes';
import { CommandError } from '../../features/registration/CommandError';
import type { RegistrationIntent } from '../../features/registration/format';
import {
  MY_BASKETS_KEY,
  openBasketOf,
  useMyBaskets,
} from '../../features/registration/in-progress';
import {
  HANDLING_NOTE,
  INTENT_CAPABILITY,
  INTENT_HANDLING,
  INTENT_LABELS,
} from '../../features/registration/intents';
import {
  blockingEligibilityReasons,
  eligibilityMessages,
  eligibilityOf,
  eligibilityStatus,
  mayRegister,
  useRegistrationOptions,
} from '../../features/registration/options';
import { useParticipants } from '../../features/registration/participants';
import { param, registrationRoutes } from '../../features/registration/routes';
import { registrationWindowStatus } from '../../features/registration/status';
import { Body, ButtonRow, ChoiceRow, Section, Title } from '../../features/registration/ui';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Offering = Schema<'Offering'>;
type Basket = Schema<'Basket'>;

function IntentChooser({ offering }: { offering: Offering }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const { participants, me, namesLoading } = useParticipants();
  const permissions = usePermissions();
  const options = useRegistrationOptions(
    offering.id,
    participants.map((p) => p.personId),
    me.data !== undefined && !namesLoading,
  );
  const intents = options.data?.availableIntents ?? [];
  const turnedOff = (intent: RegistrationIntent) => {
    const capability = INTENT_CAPABILITY[intent];
    return capability ? permissions.isCapabilityEnabled(capability) === false : false;
  };
  const firstUsable =
    intents.find((i) => INTENT_HANDLING[i] === 'basket' && !turnedOff(i)) ??
    intents.find((i) => INTENT_HANDLING[i] === 'booking' && !turnedOff(i)) ??
    null;
  const [chosen, setChosen] = useState<RegistrationIntent | null>(null);
  const intent = chosen ?? firstUsable;
  const [selected, setSelected] = useState<string[]>([]);
  /** Participants already added in this intent, so a retry never adds them twice. */
  const [added, setAdded] = useState<string[]>([]);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [working, setWorking] = useState(false);
  /** The basket as the API last answered in this intent (its revision is the next expected one). */
  const [lastBasket, setLastBasket] = useState<Basket | null>(null);

  const baskets = useMyBaskets();
  const openBasket = openBasketOf(baskets.data);
  const createBasket = useApiCommand('post', '/baskets', { invalidate: [MY_BASKETS_KEY] });
  const addLine = useApiCommand('post', '/baskets/{id}/lines', {
    invalidate: [['api', '/baskets/{id}'], MY_BASKETS_KEY],
  });

  if (me.isPending || namesLoading) {
    return <StateView variant="loading" label="your family" />;
  }
  if (me.error) {
    return <QueryErrorView error={me.error} onRetry={() => void me.refetch()} />;
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
  if (options.data === undefined) {
    if (options.error) {
      return (
        <QueryErrorView
          error={options.error}
          onRetry={() => void options.refetch()}
          unavailable={{
            title: 'Registration not available',
            description: 'This activity cannot be registered for from your account.',
          }}
        />
      );
    }
    return <StateView variant="loading" label="how you can register" />;
  }
  // Open baskets are still being read, or could not be read: never start a second basket in the
  // meantime (that would orphan the open one).
  const basketUnknown = openBasket === undefined && lastBasket === null;

  const toggle = (personId: string) =>
    setSelected((list) =>
      list.includes(personId) ? list.filter((id) => id !== personId) : [...list, personId],
    );

  const submit = async () => {
    if (!intent) return;
    setWorking(true);
    setFailure(null);
    try {
      let basket: Basket | null = lastBasket ?? openBasket ?? null;
      if (!basket && basketUnknown) return;
      if (!basket) {
        // SPK-REG-004 proposed default; partial fulfillment is never offered (DEC-026).
        basket = await createBasket.submit({
          body: { fulfillmentMode: 'all_or_nothing', acceptPartialFulfillment: false },
        });
        setLastBasket(basket);
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

  const handling = intent !== null ? INTENT_HANDLING[intent] : null;
  const basketIntent = handling === 'basket' && intent !== null && !turnedOff(intent);
  const pending = selected.filter((id) => !added.includes(id));
  return (
    <View>
      <Section title="How do you want to register?">
        {intents.length === 0 ? (
          <Body>This activity cannot be registered for in the app.</Body>
        ) : (
          <View accessibilityRole="radiogroup">
            {intents.map((option) => {
              const optionHandling = INTENT_HANDLING[option];
              const capability = INTENT_CAPABILITY[option];
              const off = turnedOff(option);
              const usable = !off && (optionHandling === 'basket' || optionHandling === 'booking');
              const detail =
                off && capability
                  ? `${INTENT_LABELS[option].description} ${turnedOffLabel(CAPABILITY_PRESENTATION[capability].label)} (${CAPABILITY_PRESENTATION[capability].decisions.join(', ')}).`
                  : optionHandling === 'basket'
                    ? INTENT_LABELS[option].description
                    : `${INTENT_LABELS[option].description} ${HANDLING_NOTE[optionHandling]}`;
              return (
                <ChoiceRow
                  key={option}
                  mode="radio"
                  label={INTENT_LABELS[option].title}
                  detail={detail}
                  checked={intent === option}
                  disabled={!usable}
                  onToggle={() => {
                    setChosen(option);
                    setFailure(null);
                  }}
                  testID={`intent-${option}`}
                />
              );
            })}
          </View>
        )}
        {intents.some((i) => INTENT_HANDLING[i] === 'makeup') ? (
          <Button
            label="Open your makeup sessions"
            variant="secondary"
            onPress={() => router.push(moneyRoutes.credits())}
          />
        ) : null}
      </Section>

      {handling === 'booking' && intent !== null && !turnedOff(intent) ? (
        <ButtonRow>
          <Button
            label="Continue to booking"
            onPress={() => router.push(packageGRoutes.newBooking(offering.id))}
            disabled={offline}
            accessibilityHint="Opens the booking for this activity: times, space and what you need"
          />
          {offline ? <Body muted>Booking needs a connection.</Body> : null}
        </ButtonRow>
      ) : null}

      {basketIntent ? (
        <Section title="Who are you registering?">
          {participants.map((p) => {
            const allowed = mayRegister(options.data, p.personId);
            const isAdded = added.includes(p.personId);
            const result = intent ? eligibilityOf(options.data, p.personId, intent) : null;
            const blocked = result ? blockingEligibilityReasons(result).length > 0 : false;
            const messages = result ? eligibilityMessages(result) : null;
            const detail = isAdded
              ? 'Added to your basket'
              : !allowed
                ? 'Not available: your account can view this person but not register them.'
                : result
                  ? [
                      eligibilityStatus(result).label,
                      ...(messages?.reasons ?? []),
                      ...(messages?.alternatives ?? []),
                    ].join('. ')
                  : undefined;
            return (
              <ChoiceRow
                key={p.personId}
                label={p.displayName}
                detail={detail}
                checked={selected.includes(p.personId)}
                disabled={!allowed || isAdded || blocked}
                onToggle={() => toggle(p.personId)}
                testID={`participant-${p.self ? 'self' : p.personId}`}
              />
            );
          })}
        </Section>
      ) : null}
      {basketIntent && openBasket === undefined && baskets.error ? (
        <QueryErrorView error={baskets.error} onRetry={() => void baskets.refetch()} />
      ) : null}
      <CommandError
        error={failure}
        onRetry={() => void submit()}
        onReload={() => {
          // STALE_REVISION: the basket changed elsewhere. Drop the basket this screen last saw and
          // take the reloaded one, so the next attempt carries its revision (a new intent).
          setLastBasket(null);
          setFailure(null);
          addLine.reset();
          void baskets.refetch();
          void options.refetch();
        }}
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
            disabled={pending.length === 0 || offline || (basketUnknown && !baskets.error)}
            busy={working || (basketUnknown && baskets.fetchStatus === 'fetching')}
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
