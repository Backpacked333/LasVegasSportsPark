/**
 * SCR-C-08 Offering detail, shown as the activity page (SPK-CAT-001, SPK-REG-002, §4.5 date-based
 * eligibility, POL-001, POL-007; journey A1; ADR-008 visual system v2, PA-11 **Proposed**
 * customer words). Reads `GET /v1/offerings/{id}` (public, child-safe view) and its sessions:
 * name, description, activity type, format, location, dates, registration window, age band,
 * capacity units, price basis with approved taxes and fees, required forms and the cancellation
 * policy, then the entry point to registration (SCR-C-09). A price for each class is shown with
 * the classes still to come and their product, and a member price with the membership it is for
 * (SPK-PAY-013, SPK-PAY-015; proposed amendments PA-02 and PA-04), all as the API states them.
 *
 * Layout: the activity's picture (`artworkFor`, decorative), its name and registration window,
 * the key facts as tags (ages, dates, days and times, place, places, price), the description
 * clamped with "Read more", then folds: Schedule, Options and add-ons, What you'll need,
 * Cancellation and eligibility, Location. A bar at the bottom shows the price and the one action
 * that fits (`detailActionFor`): Register; Book for a trial, pickup, rental or party; Join
 * waitlist when the API offers only the waitlist to everyone the account may register; "In your
 * cart" with Check out when an open cart already holds this activity; "Opens <date>" (disabled)
 * before registration opens; "Sign in to register" signed out. Register, Book and Join waitlist
 * open the registration chooser (SCR-C-09), Check out the cart. When nothing can be done online
 * (paused, closed, or a price no quote would give) there is no bar and a notice says why.
 *
 * Times are shown in the facility's time zone (`facility.timezone`, SPK-SCHED-008), with the
 * zone named. Signed in, "Who can take part" shows the read-only eligibility of each person the
 * account may register, for each intent the activity accepts
 * (`GET /v1/offerings/{id}/registration-options`, ENR-05, SPK-REG-002): reasons and permitted
 * alternatives as the API words them, unknown evidence as "not known yet", never a pass. A person
 * the account may only view is "not available to register", with no further detail (SPK-IAM-003).
 * Signed in, the customer's carts (`GET /v1/me/baskets`, the same read as Home and the header's
 * cart button) say whether this activity is already in one.
 *
 * States: loading; withdrawn or never published reads "not available" (NOT_FOUND, no hint it
 * exists); ready; stale (re-read on return to the app: a paused or closed window shows as such);
 * offline (cached detail with its age, registration disabled); registration unavailable unless the
 * API reports `registration_open`; the eligibility section has its own loading, error and
 * not-available states.
 *
 * Not shown: the responsible manager, which the API gives to staff only (`staff` is null for
 * customers; reported). Places left: the public view gives each capacity's size, not what is
 * left, so the page shows the size.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { artworkFor } from '../../artwork/artworkFor';
import {
  ageBandLabel,
  capacityLabel,
  formatInstant,
  formatMoney,
} from '../../features/registration/format';
import { basketInProgress, useMyBaskets } from '../../features/registration/in-progress';
import { INTENT_LABELS } from '../../features/registration/intents';
import {
  eligibilityMessages,
  eligibilityOf,
  eligibilityStatus,
  mayRegister,
  useRegistrationOptions,
  type RegistrationOptionsState,
} from '../../features/registration/options';
import { eligibilitySupportLines } from '../../features/registration/eligibility-words';
import { useParticipants } from '../../features/registration/participants';
import { listedPerSessionLine } from '../../features/registration/price-basis';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { offeringDates, registrationWindowStatus } from '../../features/registration/status';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { Artwork } from '../../ui/Artwork';
import { Card } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { FieldValue } from '../../ui/Field';
import { InfoCard } from '../../ui/InfoCard';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { StickyActionBar, type StickyAction } from '../../ui/StickyActionBar';
import { SupportDetails } from '../../ui/SupportDetails';
import { Tag } from '../../ui/Tag';
import { Text } from '../../ui/Text';
import { fonts, layout, makeStyles, MIN_TOUCH_SIZE, spacing } from '../../ui/theme';
import { advertisedPrice, KIND_WORD, shortDates } from '../discover/offering-look';

type Offering = Schema<'Offering'>;
type OfferingSession = Schema<'OfferingSession'>;
type ChargeLine = Schema<'ChargeLine'>;
type Basket = Schema<'Basket'>;

export const SESSIONS_SHOWN = 8;

/** The description is clamped to this many lines until "Read more". */
export const DESCRIPTION_LINES = 4;
/** A description longer than this many characters is clamped (text cannot be measured in tests). */
export const DESCRIPTION_CLAMP_CHARS = 180;

/** Kinds that are booked (a trial, a pickup game, a rental, a party) rather than registered for. */
const BOOKED_KINDS: ReadonlySet<Offering['kind']> = new Set(['trial', 'pickup', 'rental', 'party']);

const WEEKDAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Mon & Thu · 3:00 PM": the weekdays of the sessions still on, in the facility's zone. */
export function sessionPattern(
  sessions: readonly Pick<OfferingSession, 'scheduledStart' | 'status'>[] | undefined,
  timeZone: string,
): string | null {
  const live = (sessions ?? []).filter((s) => s.status !== 'canceled');
  if (live.length === 0) return null;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone });
  const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  const days = new Set(live.map((s) => weekday.format(new Date(s.scheduledStart))));
  const times = new Set(live.map((s) => clock.format(new Date(s.scheduledStart))));
  const ordered = WEEKDAY_ORDER.filter((d) => days.has(d));
  const dayText =
    ordered.length <= 1
      ? (ordered[0] ?? '')
      : `${ordered.slice(0, -1).join(', ')} & ${ordered[ordered.length - 1]}`;
  const [time] = [...times];
  return times.size === 1 && time ? `${dayText} · ${time}` : dayText;
}

/** "Opens Nov 3": the day registration opens, in the facility's zone. */
export function opensLabel(opensAt: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone });
  return `Opens ${day.format(new Date(opensAt))}`;
}

/** The one action of the bar, or null when nothing can be done online (a notice says why). */
export type DetailAction =
  | { kind: 'sign_in' }
  | { kind: 'register' }
  | { kind: 'book' }
  | { kind: 'waitlist' }
  | { kind: 'checkout'; basketId: string }
  | { kind: 'opens'; label: string };

/**
 * Which action the bar offers, from what the screen has read: the activity's registration window
 * and price, the session, an open cart that holds it, and whether the API offers only the waitlist
 * to everyone the account may register.
 */
export function detailActionFor({
  offering,
  signedIn,
  now,
  cartBasketId,
  waitlistOnly,
}: {
  offering: Pick<Offering, 'kind' | 'publicationState' | 'registrationOpensAt' | 'price'> & {
    facility: { timezone: string };
  };
  signedIn: boolean;
  now: Date;
  cartBasketId: string | null;
  waitlistOnly: boolean;
}): DetailAction | null {
  if (offering.publicationState === 'published') {
    const opensAt = offering.registrationOpensAt;
    return opensAt && new Date(opensAt).getTime() > now.getTime()
      ? { kind: 'opens', label: opensLabel(opensAt, offering.facility.timezone) }
      : null;
  }
  if (offering.publicationState !== 'registration_open') return null;
  // Quality review M-6: a price no quote would give is not registered for online.
  if (offering.price?.notQuotable) return null;
  if (!signedIn) return { kind: 'sign_in' };
  if (cartBasketId) return { kind: 'checkout', basketId: cartBasketId };
  if (waitlistOnly) return { kind: 'waitlist' };
  return BOOKED_KINDS.has(offering.kind) ? { kind: 'book' } : { kind: 'register' };
}

/** The newest open or held cart of the caller that has a line for this activity. */
export function cartHolding(
  baskets: readonly Basket[] | undefined,
  offeringId: string,
): Basket | null {
  return (
    baskets?.find(
      (b) =>
        (b.status === 'open' || b.status === 'held') &&
        basketInProgress(b) &&
        b.lines.some((line) => line.offeringId === offeringId),
    ) ?? null
  );
}

/**
 * True when the API answered for everyone the account may register, nobody is eligible for any
 * intent, and each of them is offered the waitlist (SPK-REG-008).
 */
export function waitlistOnlyFor(
  options: RegistrationOptionsState['data'],
  personIds: readonly string[],
): boolean {
  if (!options) return false;
  const people = personIds.filter((id) => mayRegister(options, id));
  if (people.length === 0) return false;
  return people.every((id) => {
    const results = options.availableIntents
      .map((intent) => eligibilityOf(options, id, intent))
      .filter((r): r is NonNullable<typeof r> => r !== null && r !== undefined);
    return (
      results.length > 0 &&
      results.every((r) => !r.eligible) &&
      results.some((r) => r.alternatives.some((a) => a.kind === 'join_waitlist'))
    );
  });
}

function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text variant={muted ? 'footnote' : 'body'} tone={muted ? 'muted' : 'default'}>
      {children}
    </Text>
  );
}

function Detail(props: { label: string; value: string; emphasis?: boolean; testID?: string }) {
  return <FieldValue {...props} layout="inline" />;
}

function chargeText(charge: ChargeLine, currency: string): string {
  const amount =
    charge.amountMinor !== undefined
      ? formatMoney(charge.amountMinor, currency)
      : `${(charge.basisPoints ?? 0) / 100}%`;
  return `${amount}${charge.inclusive ? ', included in the price' : ', added to the price'}`;
}

function PriceDetails({ offering }: { offering: Offering }) {
  const price = offering.price;
  const perSession = price?.pricingBasis === 'per_session';
  const perSessionLine = price ? listedPerSessionLine(price) : null;
  // SPK-PAY-013 (quality review M-6): the reason is the notice at the top of the page.
  if (price?.notQuotable) return <Body>The front desk can tell you the price.</Body>;
  if (!price) return <Body>No price is published for this activity yet.</Body>;
  return (
    <>
      <Detail
        label={perSession ? 'Price per class' : 'Base price'}
        value={formatMoney(price.basePriceMinor, price.currency)}
        emphasis
      />
      {/* SPK-PAY-013: the classes still to come at the per-class price, as the API counts. */}
      {perSessionLine ? <Body>{perSessionLine}</Body> : null}
      {perSession ? (
        <Body muted>
          You pay for the classes still to come. They are counted again when you ask for a price.
        </Body>
      ) : null}
      {/* SPK-PAY-015: the member price and the membership it is for. */}
      {price.memberPrice ? (
        <>
          <Detail
            label={`Member price (${price.memberPrice.entitlementName})`}
            value={`${formatMoney(price.memberPrice.priceMinor, price.currency)}${
              perSession ? ' per class' : ''
            }`}
            testID="offering-member-price"
          />
          <Body muted>
            The member price applies to a participant who holds this membership when the price is
            made.
          </Body>
        </>
      ) : null}
      {price.chargeLines.map((charge) => (
        <Detail key={charge.code} label={charge.label} value={chargeText(charge, price.currency)} />
      ))}
      <Body muted>
        Days, extras and sizes are chosen when you register. Your price summary shows the final
        price for each participant, with discounts and credits.
      </Body>
    </>
  );
}

function ScheduleDetails({
  offering,
  sessions,
}: {
  offering: Offering;
  sessions: OfferingSession[] | undefined;
}) {
  const timeZone = offering.facility.timezone;
  const pattern = sessionPattern(sessions, timeZone);
  const shown = (sessions ?? []).slice(0, SESSIONS_SHOWN);
  return (
    <>
      <Detail label="Dates" value={offeringDates(offering)} />
      {pattern ? <Detail label="Days and times" value={pattern} /> : null}
      {offering.registrationOpensAt ? (
        <Detail
          label="Registration opens"
          value={formatInstant(offering.registrationOpensAt, timeZone)}
        />
      ) : null}
      {offering.registrationClosesAt ? (
        <Detail
          label="Registration closes"
          value={formatInstant(offering.registrationClosesAt, timeZone)}
        />
      ) : null}
      {shown.length > 0 ? (
        <View accessibilityRole="list">
          {shown.map((s) => (
            <Detail
              key={s.id}
              label={s.title ?? `Session ${s.sequence}`}
              value={
                s.status === 'canceled'
                  ? `Canceled (was ${formatInstant(s.scheduledStart, timeZone)})`
                  : formatInstant(s.scheduledStart, timeZone)
              }
            />
          ))}
        </View>
      ) : null}
      {sessions && sessions.length > shown.length ? (
        <Body muted>{`And ${sessions.length - shown.length} more sessions.`}</Body>
      ) : null}
    </>
  );
}

type PolicyTitles = (id: string) => string | null;

function FormsDetails({
  offering,
  signedIn,
  titleOf,
}: {
  offering: Offering;
  signedIn: boolean;
  titleOf: PolicyTitles;
}) {
  const forms = offering.requiredFormPolicyVersionIds;
  return (
    <>
      {forms.length === 0 ? (
        <Body>No forms are required.</Body>
      ) : (
        <>
          <Body>
            {`${forms.length} form${forms.length === 1 ? '' : 's'} must be signed for each participant before a place is saved. A guardian signs for a child.`}
          </Body>
          {signedIn
            ? forms.map((id) => (titleOf(id) ? <Body key={id}>{`• ${titleOf(id)}`}</Body> : null))
            : null}
        </>
      )}
      {offering.capacity.length > 0 ? (
        <Body muted>Places are saved for you only when you check out.</Body>
      ) : null}
    </>
  );
}

function CancellationDetails({
  offering,
  signedIn,
  titleOf,
}: {
  offering: Offering;
  signedIn: boolean;
  titleOf: PolicyTitles;
}) {
  const cancellation = offering.cancellationPolicyVersionId;
  return (
    <>
      <Text variant="headline" heading>
        Cancellation
      </Text>
      {cancellation ? (
        <Body>
          {titleOf(cancellation) ??
            (signedIn
              ? 'This activity has a cancellation policy. Its wording is shown on your price summary.'
              : 'This activity has a cancellation policy. Sign in to read it.')}
        </Body>
      ) : (
        <Body>No cancellation policy is attached to this activity.</Body>
      )}
    </>
  );
}

/**
 * SPK-REG-002: read-only eligibility per participant the account may register. Nothing is saved;
 * the API evaluates again when someone is added.
 */
function EligibilityDetails({
  offering,
  people,
  options,
}: {
  offering: Offering;
  people: ReturnType<typeof useParticipants>;
  options: RegistrationOptionsState;
}) {
  const styles = useStyles();
  const { participants, me, namesLoading, namesError, retryNames } = people;
  return (
    <>
      <Text variant="headline" heading>
        Who can take part
      </Text>
      <Detail label="Age" value={ageBandLabel(offering.ageBand) ?? 'No age limits'} />
      {me.isPending ||
      namesLoading ||
      (options.data === undefined && options.isPending && options.fetchStatus === 'fetching') ? (
        <StateView variant="loading" label="eligibility for your family" />
      ) : me.error ? (
        <QueryErrorView error={me.error} onRetry={() => void me.refetch()} />
      ) : namesError ? (
        <QueryErrorView error={namesError} onRetry={() => retryNames?.()} />
      ) : options.data === undefined && options.error ? (
        <QueryErrorView
          error={options.error}
          onRetry={() => void options.refetch()}
          unavailable={{
            title: 'Eligibility not available',
            description: 'Eligibility is checked for each participant when you register.',
          }}
        />
      ) : participants.length === 0 ? (
        <Body muted>Add yourself or your family members in You to see who can take part.</Body>
      ) : (
        <View accessibilityRole="list" testID="eligibility-preview">
          {participants.map((p) => {
            if (!mayRegister(options.data, p.personId)) {
              return (
                <Detail
                  key={p.personId}
                  label={p.displayName}
                  value="Not available to register from your account"
                  testID={`eligibility-${p.self ? 'self' : p.personId}`}
                />
              );
            }
            return (
              <View key={p.personId} testID={`eligibility-${p.self ? 'self' : p.personId}`}>
                {(options.data?.availableIntents ?? []).map((intent) => {
                  const result = eligibilityOf(options.data, p.personId, intent);
                  if (!result) return null;
                  const status = eligibilityStatus(result);
                  const { reasons, alternatives } = eligibilityMessages(result, p.displayName);
                  return (
                    <View
                      key={intent}
                      style={styles.eligibility}
                      accessible
                      accessibilityLabel={[
                        `${p.displayName}, ${INTENT_LABELS[intent].title}: ${status.label}`,
                        ...reasons,
                        ...alternatives,
                      ].join('. ')}
                    >
                      <Body>{`${p.displayName}: ${INTENT_LABELS[intent].title}`}</Body>
                      <StatusBadge {...status} />
                      {reasons.map((reason) => (
                        <Body key={reason} muted>{`• ${reason}`}</Body>
                      ))}
                      {alternatives.map((alternative) => (
                        <Body key={alternative} muted>{`→ ${alternative}`}</Body>
                      ))}
                    </View>
                  );
                })}
              </View>
            );
          })}
          <SupportDetails
            lines={participants.flatMap((p) =>
              (options.data?.availableIntents ?? []).flatMap((intent) => {
                const result = eligibilityOf(options.data, p.personId, intent);
                return result
                  ? eligibilitySupportLines(
                      result,
                      `${p.displayName}, ${INTENT_LABELS[intent].title}`,
                    )
                  : [];
              }),
            )}
            testID="eligibility-preview-support"
          />
        </View>
      )}
      <Body muted>
        Eligibility is checked again when you add someone, against the activity&apos;s rules and
        dates of birth. Nothing is saved until you check out.
      </Body>
    </>
  );
}

/** The description, clamped to a few lines until the person asks for the rest. */
function Description({ text }: { text: string }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const long = text.length > DESCRIPTION_CLAMP_CHARS;
  return (
    <View style={styles.description}>
      <Text
        variant="body"
        numberOfLines={long && !open ? DESCRIPTION_LINES : undefined}
        testID="offering-description"
      >
        {text}
      </Text>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? 'Show less' : 'Read more'}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)}
          style={({ pressed }) => [styles.more, pressed && styles.pressed]}
        >
          <Text variant="callout" tone="accent" style={styles.moreLabel}>
            {open ? 'Show less' : 'Read more'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Why nothing can be done online, when the bar has no action. */
function RegistrationNotice({ offering }: { offering: Offering }) {
  const styles = useStyles();
  if (offering.publicationState === 'registration_paused') {
    return (
      <InfoCard
        tone="warning"
        message="Registration is paused. Existing registrations are kept."
        style={styles.notice}
      />
    );
  }
  if (offering.publicationState === 'published') return null;
  if (offering.publicationState !== 'registration_open') {
    return (
      <InfoCard
        message="Registration is not open for this activity right now."
        style={styles.notice}
      />
    );
  }
  // SPK-PAY-013 (quality review M-6): the reason a quote of this price would be refused.
  if (offering.price?.notQuotable) {
    return (
      <InfoCard
        title="Not open for online registration"
        message={offering.price.notQuotable.message}
        style={styles.notice}
      />
    );
  }
  return null;
}

function ActionBar({ offering, action }: { offering: Offering; action: DetailAction }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const price = offering.price;
  const perSession = price?.pricingBasis === 'per_session';
  const amount = price ? formatMoney(price.basePriceMinor, price.currency) : undefined;
  const start = () => router.push(registrationRoutes.start(offering.id));
  const needsConnection = action.kind !== 'sign_in' && action.kind !== 'opens';
  const button: StickyAction = (() => {
    switch (action.kind) {
      case 'sign_in':
        return { label: 'Sign in to register', onPress: () => router.push('/sign-in') };
      case 'opens':
        return { label: action.label, onPress: () => undefined, disabled: true };
      case 'checkout':
        return {
          label: 'Check out',
          onPress: () => router.push(registrationRoutes.basket(action.basketId)),
          accessibilityHint: 'Opens your cart',
        };
      case 'waitlist':
        return {
          label: 'Join waitlist',
          onPress: start,
          accessibilityHint: 'Choose who to add to the waitlist',
        };
      case 'book':
        return { label: 'Book', onPress: start, accessibilityHint: 'Choose who to book for' };
      case 'register':
        return {
          label: 'Register',
          onPress: start,
          accessibilityHint: 'Choose who to register and how',
        };
    }
  })();
  return (
    <StickyActionBar
      summaryLabel={
        action.kind === 'checkout'
          ? 'In your cart'
          : amount
            ? perSession
              ? 'Per class'
              : 'From'
            : undefined
      }
      summaryValue={amount}
      summaryNote={offline && needsConnection ? 'Registration needs a connection.' : undefined}
      action={{ ...button, disabled: button.disabled || (offline && needsConnection) }}
      testID="offering-action"
    />
  );
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <Disclosure title={title} style={styles.fold}>
      {children}
    </Disclosure>
  );
}

function OfferingPage({
  offering: o,
  sessions,
  signedIn,
  titleOf,
  people,
  options,
}: {
  offering: Offering;
  sessions: OfferingSession[] | undefined;
  signedIn: boolean;
  titleOf: PolicyTitles;
  people: ReturnType<typeof useParticipants>;
  options: RegistrationOptionsState;
}) {
  const styles = useStyles();
  const pattern = sessionPattern(sessions, o.facility.timezone);
  const facts = [
    { icon: 'person', label: ageBandLabel(o.ageBand) ?? 'All ages' },
    { icon: 'calendar_today', label: shortDates(o) },
    ...(pattern ? [{ icon: 'schedule', label: pattern }] : []),
    { icon: 'place', label: o.locationLabel ?? o.facility.name },
    ...o.capacity.map((c) => ({ icon: 'group', label: capacityLabel(c) })),
    ...(advertisedPrice(o.price)
      ? [{ icon: 'sell', label: advertisedPrice(o.price) as string }]
      : []),
  ];
  return (
    <View>
      <Artwork source={artworkFor(o, 'wide').source} aspectRatio={16 / 9} rounded={false} />
      <View style={styles.head}>
        <Text variant="label" tone="muted">
          {[KIND_WORD[o.kind], o.locationLabel ?? o.facility.name].filter(Boolean).join(' · ')}
        </Text>
        <Text variant="title1" heading>
          {o.name}
        </Text>
        <StatusBadge {...registrationWindowStatus(o)} testID="offering-window" />
        <View style={styles.tags} testID="offering-facts">
          {facts.map((fact) => (
            <Tag key={`${fact.icon}-${fact.label}`} icon={fact.icon} label={fact.label} />
          ))}
        </View>
        {o.description ? <Description text={o.description} /> : null}
      </View>
      <RegistrationNotice offering={o} />
      <Card style={styles.folds}>
        <Fold title="Schedule">
          <ScheduleDetails offering={o} sessions={sessions} />
        </Fold>
        <Fold title="Options and add-ons">
          <Detail label="Activity" value={o.activityType} />
          {o.format ? <Detail label="Format" value={o.format} /> : null}
          <PriceDetails offering={o} />
        </Fold>
        <Fold title="What you'll need">
          <FormsDetails offering={o} signedIn={signedIn} titleOf={titleOf} />
        </Fold>
        <Fold title="Cancellation and eligibility">
          {signedIn ? (
            <EligibilityDetails offering={o} people={people} options={options} />
          ) : (
            <>
              <Text variant="headline" heading>
                Who can take part
              </Text>
              <Detail label="Age" value={ageBandLabel(o.ageBand) ?? 'No age limits'} />
              <Body muted>
                Sign in to see whether you or your family members can take part. Eligibility is
                checked against the activity&apos;s rules and dates of birth.
              </Body>
            </>
          )}
          <CancellationDetails offering={o} signedIn={signedIn} titleOf={titleOf} />
        </Fold>
        <Fold title="Location">
          <Detail label="Facility" value={o.facility.name} />
          {o.locationLabel ? <Detail label="Location" value={o.locationLabel} /> : null}
          <Body
            muted
          >{`Times are shown in the facility's time zone (${o.facility.timezone}).`}</Body>
        </Fold>
      </Card>
    </View>
  );
}

export function OfferingDetailScreen({ offeringId }: { offeringId: string }) {
  const { session } = useApp();
  const now = useNow();
  const signedIn = session.status === 'signed_in';
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    enabled: session.status !== 'loading',
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId } },
    enabled: offering.data !== undefined,
  });
  const o = offering.data;
  // Read for the folds and the bar at once, so the reads do not wait for a fold to open.
  const policyIds = o
    ? [
        ...o.requiredFormPolicyVersionIds,
        ...(o.cancellationPolicyVersionId ? [o.cancellationPolicyVersionId] : []),
      ]
    : [];
  const policies = useApiRecords('/policy-versions/{id}', policyIds, signedIn);
  const titleOf: PolicyTitles = (id) => policies[id]?.data?.title ?? null;
  const people = useParticipants();
  const personIds = people.participants.map((p) => p.personId);
  const options = useRegistrationOptions(
    offeringId,
    personIds,
    signedIn &&
      o !== undefined &&
      people.me.data !== undefined &&
      !people.namesLoading &&
      people.namesError === null,
  );
  const baskets = useMyBaskets(signedIn && o !== undefined);
  const cart = cartHolding(baskets.data?.items, offeringId);
  const action = o
    ? detailActionFor({
        offering: o,
        signedIn,
        now,
        cartBasketId: cart?.id ?? null,
        waitlistOnly: waitlistOnlyFor(options.data, personIds),
      })
    : null;
  // §4.10: once the API answers NOT_FOUND or ACCESS_DENIED, the cached activity is not shown.
  const shown =
    o && !(offering.error && presentationForError(offering.error) === 'unavailable')
      ? o
      : undefined;
  return (
    <Screen footer={shown && action ? <ActionBar offering={shown} action={action} /> : undefined}>
      <QueryBoundary
        query={offering}
        label="activity"
        empty={{ title: 'Not available', description: '' }}
        unavailableOffline={['Registration']}
      >
        {(data) => (
          <OfferingPage
            offering={data}
            sessions={sessions.data}
            signedIn={signedIn}
            titleOf={titleOf}
            people={people}
            options={options}
          />
        )}
      </QueryBoundary>
    </Screen>
  );
}

const useStyles = makeStyles(() => ({
  head: { paddingHorizontal: layout.gutter, paddingTop: spacing.lg, gap: spacing.sm },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingTop: spacing.xs },
  description: { gap: spacing.xxs, paddingTop: spacing.sm },
  more: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center', alignSelf: 'flex-start' },
  moreLabel: { ...fonts.semibold },
  pressed: { opacity: 0.6 },
  notice: { marginHorizontal: layout.gutter, marginTop: spacing.lg },
  folds: { marginHorizontal: layout.gutter, marginTop: spacing.lg, marginBottom: spacing.xl },
  fold: { paddingVertical: spacing.xxs },
  eligibility: { paddingVertical: spacing.xs, gap: spacing.xs },
}));

/** Route component for app/registration/offering/[offeringId].tsx. */
export function OfferingDetailRoute() {
  const offeringId = param(useLocalSearchParams<{ offeringId: string }>().offeringId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Activity' }} />
      <OfferingDetailScreen offeringId={offeringId} />
    </>
  );
}
