/**
 * Register for an activity in three steps (redesign handoff M 1e Who, M 2a Options, M 1f Review &
 * pay, M 4e, then M 1g Done on the outcome route; INTERACTIONS "1e–1g"; key flow "Register for
 * camp weeks"; SPK-REG-001 to SPK-REG-009, SPK-PAY-001, SPK-PAY-007, SPK-AT-005, §4.9, §4.14).
 * Replaces the separate start, forms, quote and checkout screens: their routes open this flow
 * (start) or its Review (the cart's routes), so every deep link still lands.
 *
 * - **Who** (a sheet over the activity): the API's eligibility per person (`useWho`), the person
 *   from `?person=` (Explore's "Register Maya") pre-ticked when they can join.
 * - **Options**: shown when there is something to choose: the camp's weeks and extras, or a price
 *   tier and its days (`PurchaseChoices`). Anything else goes from Who straight to Review.
 * - **Review & pay** (`ReviewController`): the flow's own cart is brought to the choices, held and
 *   priced; forms are signed in place; paying is never optimistic.
 * - **Back**: the arrow goes back one step with the choices kept. Leaving from step 1 asks
 *   nothing; leaving from a later step asks "Leave registration? Your choices are kept for 30 min."
 *   The choices (and the cart made) are kept in memory for 30 minutes (`draft.ts`).
 *
 * Activities that are not registered through a cart (trials, pickup sessions, rentals, parties,
 * makeups, joining a known team) keep their own chooser (`RegistrationIntentScreen`).
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import {
  desiredLines,
  missingUniformSizes,
  type WeekExtras,
} from '../../features/register/basket-plan';
import {
  dropDraft,
  emptyDraft,
  readDraft,
  saveDraft,
  type RegisterDraft,
} from '../../features/register/draft';
import {
  lengthWords,
  meetingPattern,
  shortDate,
  shortRange,
  wholeMoney,
  weekLabel,
} from '../../features/register/fit';
import { useWho } from '../../features/register/useWho';
import { useCampWeeks, weekChoosable } from '../../features/registration/CampWeeks';
import type { RegistrationIntent } from '../../features/registration/format';
import { INTENT_HANDLING } from '../../features/registration/intents';
import {
  EMPTY_SELECTION,
  missingChoices,
  purchaseLineFields,
  type PurchaseSelection,
} from '../../features/registration/PurchaseChoices';
import { useApiRecords } from '../../features/registration/queries';
import { param } from '../../features/registration/routes';
import { useKnownFacilityZone } from '../../features/today/known-zone';
import { useApp, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { makeStyles, spacing, useTheme } from '../../ui/theme';
import { OptionsStep } from './register/OptionsStep';
import { ReviewController } from './register/ReviewController';
import { namesList, WhoStep } from './register/WhoStep';
import { RegistrationIntentScreen } from './RegistrationIntentScreen';

type Offering = Schema<'Offering'>;
type Step = 'who' | 'options' | 'review';

export const LEAVE_TITLE = 'Leave registration?';
export const LEAVE_MESSAGE = 'Your choices are kept for 30 min.';

/** "Saturdays from Mar 7 · 10 weeks": when it meets, from its sessions on the facility clock. */
export function whenLine(
  offering: Pick<Offering, 'startsOn' | 'endsOn' | 'facility'>,
  sessions: readonly Schema<'OfferingSession'>[] | undefined,
): string {
  const zone = offering.facility.timezone;
  const pattern = sessions ? meetingPattern(sessions, zone) : null;
  const days = pattern?.split(' ')[0];
  const length = sessions ? lengthWords(sessions, zone) : null;
  return [
    days && days !== 'Weekdays'
      ? `${days} from ${shortDate(offering.startsOn)}`
      : shortRange(offering.startsOn, offering.endsOn),
    length,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Maya's place", "Maya and Leo's places", "Maya's places" (two weeks). */
export function heldForWords(names: readonly string[], lines: number): string {
  const who = namesList(names);
  return `${who}'s ${lines > 1 ? 'places' : 'place'}`;
}

function Flow({ offering, personParam }: { offering: Offering; personParam: string | null }) {
  const styles = useStyles();
  const router = useRouter();
  const navigation = useNavigation();
  const now = useNow();
  const zone = useKnownFacilityZone(offering.facility.timezone).zone;
  const [chosenIntent, setChosenIntent] = useState<RegistrationIntent | null>(null);
  const who = useWho(offering.id, zone, true, chosenIntent);
  const [draft, setDraftState] = useState<RegisterDraft>(
    () => readDraft(offering.id, now) ?? emptyDraft(offering.id),
  );
  const [step, setStep] = useState<Step>('who');
  const [choices, setChoices] = useState<Readonly<Record<string, PurchaseSelection>>>({});
  const [choicesAsked, setChoicesAsked] = useState(false);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const setDraft = (update: (d: RegisterDraft) => RegisterDraft) =>
    setDraftState((d) => {
      const next = update(d);
      saveDraft(next, now);
      return next;
    });

  // Pre-tick the person Explore chose ("Register Maya"), once their row says they can join.
  const preticked = useRef(false);
  useEffect(() => {
    if (preticked.current || !personParam || who.rows.length === 0) return;
    const row = who.rows.find((r) => r.personId === personParam);
    // Wait for the API's eligibility (a row reads "unknown" until it answers).
    if (!row || (row.state === 'unknown' && who.options.data === undefined)) return;
    preticked.current = true;
    if (row.tickable && !draft.personIds.includes(personParam)) {
      setDraft((d) => ({ ...d, personIds: [...d.personIds, personParam] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the rows first answer
  }, [personParam, who.rows]);

  // Leaving the flow from a later step asks first (the stack's back gesture, Android back).
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (event) => {
        if (stepRef.current === 'who') return;
        event.preventDefault();
        setLeaving(() => () => navigation.dispatch(event.data.action));
      }),
    [navigation],
  );

  const isCamp = offering.kind === 'camp';
  const camp = useCampWeeks(offering, isCamp);
  const weekIds = isCamp ? camp.weeks.map((w) => w.id) : [offering.id];
  const purchase = useApiRecords('/offerings/{id}/purchase-options', weekIds);
  const sessions = useApiRecords('/offerings/{id}/sessions', weekIds);
  const lead = purchase[offering.id]?.data;
  const tierOptions = lead && lead.tiers.length > 0 ? lead : null;
  const addons = lead?.addons.filter((a) => a.status === 'active') ?? [];
  const needsOptions = isCamp || tierOptions !== null || addons.length > 0;
  const basketIntents =
    who.options.data?.availableIntents.filter((i) => INTENT_HANDLING[i] === 'basket') ?? [];
  const intent = who.intent;
  // A child's place: the account holder is listed only when they could join (handoff 1e).
  const rows = who.rows.filter(
    (r) =>
      !(
        intent === 'youth' &&
        !r.tickable &&
        who.people.find((p) => p.personId === r.personId)?.self
      ),
  );
  const selected = draft.personIds.filter((id) =>
    rows.some((r) => r.personId === id && r.tickable),
  );
  const nameOf = (personId: string) =>
    who.people.find((p) => p.personId === personId)?.name ?? 'Family member';
  const chosenWeeks = isCamp
    ? draft.weekIds.filter((id) => camp.weeks.some((w) => w.id === id && weekChoosable(w)))
    : [offering.id];
  const uniform = lead?.uniform && lead.uniform.status === 'active' ? lead.uniform : null;

  const extrasOf = (id: string): WeekExtras | undefined => {
    const options = purchase[id]?.data;
    if (!options) return undefined;
    return {
      addons: tierOptions ? [] : options.addons,
      uniform: options.uniform,
      sessionIds: (sessions[id]?.data ?? [])
        .filter((s) => s.status !== 'canceled')
        .map((s) => s.id),
    };
  };
  const missingSizes = missingUniformSizes(selected, uniform, draft.uniformSizes);
  const extrasKnown = chosenWeeks.every(
    (id) => purchase[id]?.data !== undefined && sessions[id]?.data !== undefined,
  );
  // Worked out each render; Review compares the lines by value, so nothing re-runs needlessly.
  const desired = (() => {
    if (!intent || selected.length === 0 || !extrasKnown || missingSizes.length > 0) return null;
    const lines = desiredLines({
      personIds: selected,
      weekIds: chosenWeeks,
      intent,
      extras: draft.extras,
      uniformSizes: draft.uniformSizes,
      extrasOf,
    });
    if (!tierOptions) return lines;
    return lines.map((line) => {
      const fields = purchaseLineFields(
        choices[line.participantPersonId] ?? EMPTY_SELECTION,
        tierOptions,
      );
      return {
        ...line,
        addons: (fields.addons ?? []).map((a) => ({
          addonId: a.addonId,
          ...(a.sessionIds ? { sessionIds: [...a.sessionIds] } : {}),
        })),
        ...(fields.priceTierId ? { priceTierId: fields.priceTierId } : {}),
        ...(fields.selectedSessionIds
          ? { selectedSessionIds: [...fields.selectedSessionIds] }
          : {}),
      };
    });
  })();

  if (who.namesError) {
    return <QueryErrorView error={who.namesError} onRetry={() => who.retryNames?.()} />;
  }
  if (who.options.error && !who.options.data) {
    return (
      <QueryErrorView
        error={who.options.error}
        onRetry={() => void who.options.refetch()}
        unavailable={{
          title: 'Registration not available',
          description: 'This activity cannot be registered for from your account.',
        }}
      />
    );
  }
  // Not registered through a cart: the activity's own chooser (trials, bookings, makeups).
  if (who.options.data && basketIntents.length === 0) {
    return <RegistrationIntentScreen offeringId={offering.id} />;
  }

  const price = offering.price && !offering.price.notQuotable ? offering.price : null;
  const leadSessions = sessions[offering.id]?.data;
  const subtitle = isCamp
    ? shortRange(
        camp.weeks[0]?.startsOn ?? offering.startsOn,
        camp.weeks[camp.weeks.length - 1]?.endsOn ?? offering.endsOn,
      )
    : whenLine(offering, leadSessions);
  const forNames = selected.map(nameOf);
  const review = () => {
    if (
      tierOptions &&
      selected.some((id) => missingChoices(choices[id] ?? EMPTY_SELECTION, tierOptions).length > 0)
    ) {
      setChoicesAsked(true);
      return;
    }
    setStep('review');
  };
  const weekNameOf = (id: string) => {
    if (!isCamp) return null;
    const week = camp.weeks.find((w) => w.id === id);
    return week ? `${weekLabel(week.name)} · ${shortRange(week.startsOn, week.endsOn)}` : null;
  };

  let body;
  if (step === 'who') {
    body = (
      <WhoStep
        offering={offering}
        subtitle={subtitle}
        fromPrice={price ? wholeMoney(price.basePriceMinor, price.currency) : null}
        rows={rows}
        selected={selected}
        onToggle={(id) =>
          setDraft((d) => ({
            ...d,
            personIds: d.personIds.includes(id)
              ? d.personIds.filter((p) => p !== id)
              : [...d.personIds, id],
          }))
        }
        intents={basketIntents.includes('youth') ? [] : basketIntents}
        intent={intent}
        onIntent={setChosenIntent}
        loading={who.loading}
        onContinue={() => (needsOptions ? setStep('options') : setStep('review'))}
        onClose={() => (router.canGoBack() ? router.back() : router.replace('/discover'))}
      />
    );
  } else if (step === 'options') {
    body = (
      <OptionsStep
        offering={offering}
        camp={isCamp ? camp : null}
        chosenWeeks={chosenWeeks}
        onToggleWeek={(id) =>
          setDraft((d) => {
            const current = d.weekIds.filter((w) => camp.weeks.some((x) => x.id === w));
            return {
              ...d,
              weekIds: current.includes(id) ? current.filter((w) => w !== id) : [...current, id],
            };
          })
        }
        addons={tierOptions ? [] : addons}
        extras={draft.extras}
        onToggleExtra={(code) =>
          setDraft((d) => ({
            ...d,
            extras: d.extras.includes(code)
              ? d.extras.filter((c) => c !== code)
              : [...d.extras, code],
          }))
        }
        extrasProposed={isCamp && addons.length === 0 && lead !== undefined}
        tierOptions={tierOptions}
        tierSessions={leadSessions ?? []}
        choices={choices}
        onChoices={(personId, value) => setChoices((all) => ({ ...all, [personId]: value }))}
        choicesAsked={choicesAsked}
        people={selected.map((id) => ({ personId: id, name: nameOf(id) }))}
        addonsOf={(id) => purchase[id]?.data?.addons ?? []}
        sessionsOf={(id) => sessions[id]?.data}
        onBack={() => setStep('who')}
        onReview={review}
      />
    );
  } else {
    body = (
      <ReviewController
        basketId={draft.basketId}
        desired={desired}
        waiting={desired === null}
        offering={offering}
        subtitle={[`For ${namesList(forNames)}`, subtitle].join(' · ')}
        heldFor={heldForWords(forNames, chosenWeeks.length)}
        weekNameOf={weekNameOf}
        nameOf={nameOf}
        peopleIds={selected}
        codes={draft.codes}
        onCodes={(codes) => setDraft((d) => ({ ...d, codes }))}
        uniform={uniform}
        sizes={draft.uniformSizes}
        onSize={(personId, size) =>
          setDraft((d) => ({ ...d, uniformSizes: { ...d.uniformSizes, [personId]: size } }))
        }
        onBasket={(basketId) => setDraft((d) => ({ ...d, basketId }))}
        onKeepWeeks={isCamp ? (keep) => setDraft((d) => ({ ...d, weekIds: keep })) : undefined}
        onStartOver={() => setStep(needsOptions ? 'options' : 'who')}
        onBack={() => setStep(needsOptions ? 'options' : 'who')}
        onEdit={() => setStep(needsOptions ? 'options' : 'who')}
        onPaid={() => {
          stepRef.current = 'who';
          dropDraft(offering.id);
        }}
      />
    );
  }

  return (
    <View style={styles.root}>
      {body}
      <Sheet
        open={leaving !== null}
        onClose={() => setLeaving(null)}
        title={LEAVE_TITLE}
        testID="leave-registration"
        footer={
          <View style={styles.leaveActions}>
            <Button
              label="Leave"
              variant="secondary"
              block
              onPress={() => {
                const go = leaving;
                setLeaving(null);
                stepRef.current = 'who';
                go?.();
              }}
            />
            <Button label="Stay" block onPress={() => setLeaving(null)} />
          </View>
        }
      >
        <Text variant="body">{LEAVE_MESSAGE}</Text>
      </Sheet>
    </View>
  );
}

export function RegisterFlowScreen({
  offeringId,
  personId,
}: {
  offeringId: string;
  personId: string | null;
}) {
  const { session } = useApp();
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    enabled: session.status === 'signed_in',
  });
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.page }}>
      <RequireSession what="registration">
        <QueryBoundary
          query={offering}
          label="activity"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['Registration']}
          hideUpdated
        >
          {(o) =>
            o.publicationState === 'registration_open' ? (
              <Flow offering={o} personParam={personId} />
            ) : (
              <Screen>
                <StateView
                  variant="unavailable"
                  title="Registration is not open"
                  description="Registration for this activity is not open now. Existing registrations are kept."
                />
              </Screen>
            )
          }
        </QueryBoundary>
      </RequireSession>
    </View>
  );
}

/** Route component for app/registration/start/[offeringId].tsx (`?person=` pre-ticks someone). */
export function RegisterFlowRoute() {
  const params = useLocalSearchParams<{ offeringId: string; person?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Register', headerShown: false }} />
      <RegisterFlowScreen
        offeringId={param(params.offeringId) ?? ''}
        personId={param(params.person) ?? null}
      />
    </>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.page },
  leaveActions: { gap: spacing.sm },
}));
