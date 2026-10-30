/**
 * Book a rental or party (Package G, conditional; §3.16 Rentals and Parties rows; SPK-COND-003:
 * everything a booking needs is reserved together or nothing is; ENR-13). Route:
 * `/bookings/new/[offeringId]`, opened from the intent chooser (SCR-C-09) for a rental or party
 * offering.
 *
 * 1. The offering (`GET /v1/offerings/{id}`) says whether it is a rental or a party and its
 *    facility time zone (SPK-SCHED-008). Its approved booking terms (`bookingTermsPolicyVersionId`,
 *    `GET /v1/policy-versions/{id}`, POL-040) say whether it is booked at once or by request, and
 *    whether a deposit is taken, the access conditions and the host's responsibilities; they are
 *    shown before anything is sent. An offering without approved terms cannot be booked (the API
 *    answers BOOKING_TERMS_REQUIRED): it is shown as not bookable yet.
 * 2. Free times: `GET /v1/offerings/{id}/booking-availability` for one local day of the facility
 *    at a time. A rental asks the customer how long (minutes; the API takes 15 to 1440 and has no
 *    default); a party lasts its package's duration, which the API states. Only start times at
 *    which the offering's number of resources are free are offered, and the customer chooses which
 *    of the free resources (exactly the number the API states).
 * 3. Forms the offering requires (`requiredFormPolicyVersionIds`) are signed by the booker first
 *    (`BookingForms`, `POST /v1/acknowledgments`); the API answers MISSING_ACKNOWLEDGMENT otherwise.
 *    A party states its number of guests (the package's guest limit is checked by the API, which
 *    answers GUEST_LIMIT_EXCEEDED next to the field). A rental may repeat every week for a number of
 *    weeks; the API checks every week (RESOURCE_CONFLICT lists the ones that are not free).
 * 4. `POST /v1/bookings`, one idempotency key per booking intent (a retry after no answer reuses
 *    it). Request mode: the booking is `requested` and holds nothing until staff approve it
 *    (DEC-029, DEC-030 stay pending: whether a request ever reserves or takes a deposit first).
 *    Instant mode: the booking is `held` with its own basket; it is paid through the basket, quote
 *    and checkout (SCR-C-11 to SCR-C-15), never here, and it is confirmed only when paid and staffed.
 *
 * No price, deposit, duration, guest limit or term is decided here: the basket's quote states the
 * money, the API's answers state the rest.
 *
 * Behind `CapabilityGate` for `rentals` or `parties` (DEC-016, DEC-076, DEC-077), then for the
 * offering's own kind; a CAPABILITY_DISABLED answer shows the turned-off state. A malformed id is
 * "Link not available" without a request.
 *
 * States: loading; ready; empty (no free time that day); validation failure (field messages, input
 * kept); permission restriction (not available); turned off; offline or stale (free times read
 * earlier stay listed under the offline or stale notice with the time they were read; booking
 * disabled offline, "Needs a connection"); processing (busy); no answer ("Check again", same
 * key); success (request sent, or held with "Go to basket").
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import {
  Body,
  ButtonRow,
  Caption,
  ChoiceRow,
  Field,
  Section,
  TextField,
} from '../../features/money/ui';
import {
  bookableTimes,
  bookingKindOf,
  bookingStatus,
  bookingTermsOf,
  capabilityOfKind,
  confirmationText,
  conflictsOf,
  KIND_LABELS,
  outstandingText,
  paymentText,
  resourceName,
  type Booking,
  type BookingKind,
  type BookingTerms,
} from '../../features/package-g/booking-model';
import { packageGRoutes, routeId } from '../../features/package-g/routes';
import { registrationRoutes } from '../../features/registration/routes';
import {
  addLocalDays,
  displayZone,
  formatDay,
  formatRange,
  formatWhen,
  startOfLocalDay,
  zoneAbbreviation,
  type DisplayZone,
} from '../../features/today/time';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { LastUpdated } from '../../ui/LastUpdated';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { BookingForms } from './BookingForms';

type Offering = Schema<'Offering'>;

/** The API's bounds for a rental's length (BookingAvailabilityQuery.durationMinutes). */
export const RENTAL_MINUTES = { min: 15, max: 1440 } as const;
/** The API's bounds for a weekly rental (BookingRecurrence.count, the first week included). */
export const REPEAT_WEEKS = { min: 2, max: 52 } as const;

/** A whole number within [min, max] typed by the customer, or null. */
export function parseWhole(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

interface FieldErrors {
  duration?: string;
  guests?: string;
  weeks?: string;
  time?: string;
  resources?: string;
}

/** Field messages for a VALIDATION_FAILED answer that names its field (`details.path`). */
function fieldErrorOf(error: ApiError): FieldErrors | null {
  if (error.code !== 'VALIDATION_FAILED') return null;
  const path = (error.details as { path?: unknown } | null | undefined)?.path;
  switch (path) {
    case 'guestCount':
      return { guests: error.message };
    case 'recurrence':
      return { weeks: error.message };
    case 'resourceIds':
      return { resources: error.message };
    case 'start':
    case 'end':
      return { time: error.message };
    default:
      return null;
  }
}

function TermsBlock({ terms }: { terms: BookingTerms }) {
  return (
    <Section title="Booking terms" testID="booking-terms">
      <Field label="How it is confirmed" value={confirmationText(terms.confirmationMode)} />
      <Field label="Paying" value={paymentText(terms)} />
      {terms.accessConditions ? (
        <Field label="Access conditions" value={terms.accessConditions} />
      ) : null}
      {terms.hostResponsibilities ? (
        <Field label="Host responsibilities" value={terms.hostResponsibilities} />
      ) : null}
      {terms.confirmationMode === 'request' ? (
        <StateView
          variant="pending-decision"
          subject="Reserving the time or taking a deposit before approval"
          decisions={['DEC-029', 'DEC-030']}
          owner="Product and operations; Finance for refund rules"
        />
      ) : null}
    </Section>
  );
}

function Outcome({ booking, zone }: { booking: Booking; zone: DisplayZone }) {
  const router = useRouter();
  const first = booking.occurrences[0];
  const basketId = booking.basketId;
  return (
    <Section
      title={booking.status === 'requested' ? 'Request sent' : 'Booked'}
      testID="booking-outcome"
    >
      <StatusBadge {...bookingStatus(booking)} testID="booking-outcome-status" />
      {first ? <Field label="When" value={formatRange(first.start, first.end, zone.zone)} /> : null}
      {booking.occurrences.length > 1 ? (
        <Field label="Weeks" value={String(booking.occurrences.length)} />
      ) : null}
      {booking.status === 'requested' ? (
        <Body>
          Nothing is reserved or charged until staff approve your request. The decision appears
          under Rentals and parties.
        </Body>
      ) : null}
      {outstandingText(booking.outstanding).map((text) => (
        <Caption key={text}>{text}</Caption>
      ))}
      <ButtonRow>
        {booking.status === 'held' && basketId ? (
          <Button
            label="Go to basket"
            onPress={() => router.push(registrationRoutes.basket(basketId))}
            accessibilityHint="Opens the basket where this booking is paid"
          />
        ) : null}
        <Button
          label="Open the booking"
          variant={booking.status === 'held' ? 'secondary' : 'primary'}
          onPress={() => router.push(packageGRoutes.booking(booking.id))}
        />
      </ButtonRow>
    </Section>
  );
}

function BookingForm({
  offering,
  kind,
  terms,
}: {
  offering: Offering;
  kind: BookingKind;
  terms: BookingTerms;
}) {
  const now = useNow();
  const { services } = useApp();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const zone = displayZone(offering.facility.timezone);
  const [dayOffset, setDayOffset] = useState(0);
  const [durationText, setDurationText] = useState('');
  const [guestText, setGuestText] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [weeksText, setWeeksText] = useState('');
  const [start, setStart] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [conflicts, setConflicts] = useState<{ occurrenceStart: string; resourceId: string }[]>([]);
  const [booked, setBooked] = useState<Booking | null>(null);

  const duration =
    kind === 'rental' ? parseWhole(durationText, RENTAL_MINUTES.min, RENTAL_MINUTES.max) : null;
  const dayStart = addLocalDays(startOfLocalDay(now, zone.zone), dayOffset, zone.zone);
  const dayEnd = addLocalDays(dayStart, 1, zone.zone);
  const availability = useApiQuery({
    path: '/offerings/{id}/booking-availability',
    request: {
      path: { id: offering.id },
      query: {
        from: dayStart.toISOString(),
        to: dayEnd.toISOString(),
        ...(duration !== null ? { durationMinutes: duration } : {}),
      },
    },
    enabled: kind === 'party' || duration !== null,
  });
  const book = useApiCommand('post', '/bookings', { invalidate: [['api', '/me/bookings']] });

  if (booked) return <Outcome booking={booked} zone={zone} />;

  const times = availability.data ? bookableTimes(availability.data, now) : [];
  const time = times.find((t) => t.start === start) ?? null;
  const resourceCount = availability.data?.resourceCount ?? null;
  const resourceNames = new Map(
    (availability.data?.resources ?? []).map((r) => [r.resourceId, r.name]),
  );

  const resetTime = () => {
    setStart(null);
    setChosen([]);
  };
  const changeDay = (delta: number) => {
    setDayOffset((d) => Math.max(0, d + delta));
    resetTime();
  };

  const toggleResource = (id: string) => {
    setErrors((e) => ({ ...e, resources: undefined }));
    if (resourceCount === 1) {
      setChosen([id]);
      return;
    }
    setChosen((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  };

  const submit = async () => {
    const next: FieldErrors = {};
    const guests = kind === 'party' ? parseWhole(guestText, 1, 10_000) : null;
    const weeks = repeat ? parseWhole(weeksText, REPEAT_WEEKS.min, REPEAT_WEEKS.max) : null;
    if (kind === 'rental' && duration === null) {
      next.duration = `Enter how long, in minutes (${RENTAL_MINUTES.min} to ${RENTAL_MINUTES.max}).`;
    }
    if (kind === 'party' && guests === null) next.guests = 'Enter the number of guests.';
    if (repeat && weeks === null) {
      next.weeks = `Enter the number of weeks (${REPEAT_WEEKS.min} to ${REPEAT_WEEKS.max}).`;
    }
    if (!time) next.time = 'Choose a start time.';
    else if (resourceCount !== null && chosen.length !== resourceCount) {
      next.resources = `Choose ${resourceCount} of the free ${resourceCount === 1 ? 'space' : 'spaces'}.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || !time) return;
    setFailure(null);
    setConflicts([]);
    try {
      const result = await book.submit({
        body: {
          offeringId: offering.id,
          start: time.start,
          ...(kind === 'rental' ? { end: time.end } : {}),
          resourceIds: chosen,
          ...(kind === 'party' && guests !== null ? { guestCount: guests } : {}),
          ...(repeat && weeks !== null ? { recurrence: { count: weeks } } : {}),
        },
      });
      setBooked(result);
    } catch (error) {
      const e = error as ApiError;
      const fields = fieldErrorOf(e);
      if (fields) {
        setErrors(fields);
        return;
      }
      if (e.code === 'RESOURCE_CONFLICT') {
        setConflicts(conflictsOf(e.details));
        void availability.refetch();
      }
      setFailure(e);
    }
  };

  const dayLabel = `${formatDay(dayStart, zone.zone)} (${zoneAbbreviation(dayStart, zone.zone)})`;
  // SPK-UX-008, §4.15: free times read earlier are shown with their age while offline, after a
  // failed refresh or once older than the stale threshold; booking needs a fresh connection.
  const staleThreshold = services.config.staleDataThresholdMs;
  const timesStale =
    staleThreshold !== null &&
    availability.updatedAt !== null &&
    now.getTime() - availability.updatedAt.getTime() > staleThreshold;
  const refreshFailed =
    availability.error !== null && presentationForError(availability.error) === 'offline';
  const timesNotice =
    offline || refreshFailed || timesStale ? (
      <StateView
        variant="offline-stale"
        offline={offline || refreshFailed}
        updatedAt={availability.updatedAt}
        now={now}
        unavailableActions={['Booking']}
        onRetry={() => void availability.refetch()}
      />
    ) : (
      <LastUpdated at={availability.updatedAt} now={now} />
    );

  return (
    <View>
      <TermsBlock terms={terms} />
      <BookingForms policyVersionIds={offering.requiredFormPolicyVersionIds} zone={zone.zone} />

      <Section title="When" testID="booking-when">
        {kind === 'rental' ? (
          <TextField
            label="How long, in minutes"
            hint={`${RENTAL_MINUTES.min} to ${RENTAL_MINUTES.max} minutes`}
            value={durationText}
            onChangeText={(text) => {
              setDurationText(text);
              setErrors((e) => ({ ...e, duration: undefined }));
              resetTime();
            }}
            error={errors.duration}
            testID="booking-duration"
          />
        ) : availability.data ? (
          <Field label="Length" value={`${availability.data.durationMinutes} minutes`} />
        ) : null}
        <View style={styles.dayRow}>
          <Button
            label="Earlier day"
            variant="secondary"
            disabled={dayOffset === 0}
            onPress={() => changeDay(-1)}
          />
          <Text style={styles.day} accessibilityRole="header" testID="booking-day">
            {dayLabel}
          </Text>
          <Button label="Later day" variant="secondary" onPress={() => changeDay(1)} />
        </View>
        {zone.facility ? (
          <Caption>{`Times are in the facility's time zone (${zoneAbbreviation(dayStart, zone.zone)}).`}</Caption>
        ) : null}
        {kind === 'rental' && duration === null ? (
          <Caption>Enter how long to see the free times.</Caption>
        ) : availability.data === undefined ? (
          availability.error ? (
            <QueryErrorView
              error={availability.error}
              onRetry={() => void availability.refetch()}
              unavailableOffline={['Booking']}
            />
          ) : offline ? (
            <StateView
              variant="offline-stale"
              offline
              updatedAt={null}
              now={now}
              unavailableActions={['Booking']}
              onRetry={() => void availability.refetch()}
            />
          ) : (
            <StateView variant="loading" label="free times" />
          )
        ) : times.length === 0 ? (
          <>
            {timesNotice}
            <StateView
              variant="empty"
              title="No free time this day"
              description="Try a later day."
              actionLabel="Later day"
              onAction={() => changeDay(1)}
            />
          </>
        ) : (
          <>
            {timesNotice}
            <View accessibilityRole="radiogroup" accessibilityLabel="Start time">
              {times.map((t) => (
                <ChoiceRow
                  key={t.start}
                  mode="radio"
                  label={formatRange(t.start, t.end, zone.zone)}
                  detail={`${t.resources.length} free: ${t.resources.map((r) => resourceName(r.name)).join(', ')}`}
                  checked={start === t.start}
                  onPress={() => {
                    setStart(t.start);
                    setChosen([]);
                    setErrors((e) => ({ ...e, time: undefined }));
                  }}
                />
              ))}
            </View>
          </>
        )}
        {errors.time ? (
          <Text style={styles.error} accessibilityRole="alert">
            {`▲ ${errors.time}`}
          </Text>
        ) : null}
      </Section>

      {time && resourceCount !== null ? (
        <Section title="What to reserve" testID="booking-resources">
          <Caption>
            {`This ${kind} reserves ${resourceCount} ${resourceCount === 1 ? 'space' : 'spaces'}. Choose from those free at ${formatWhen(time.start, zone.zone)}.`}
          </Caption>
          <View
            accessibilityRole={resourceCount === 1 ? 'radiogroup' : 'list'}
            accessibilityLabel="Spaces to reserve"
          >
            {time.resources.map((r) => (
              <ChoiceRow
                key={r.resourceId}
                mode={resourceCount === 1 ? 'radio' : 'checkbox'}
                label={resourceName(r.name)}
                checked={chosen.includes(r.resourceId)}
                onPress={() => toggleResource(r.resourceId)}
              />
            ))}
          </View>
          {errors.resources ? (
            <Text style={styles.error} accessibilityRole="alert">
              {`▲ ${errors.resources}`}
            </Text>
          ) : null}
        </Section>
      ) : null}

      {kind === 'party' ? (
        <Section title="Guests">
          <TextField
            label="Number of guests"
            hint="The package's guest limit is checked when you book."
            value={guestText}
            onChangeText={(text) => {
              setGuestText(text);
              setErrors((e) => ({ ...e, guests: undefined }));
            }}
            error={errors.guests}
            testID="booking-guests"
          />
        </Section>
      ) : (
        <Section title="Repeat">
          <ChoiceRow
            mode="checkbox"
            label="Repeat every week"
            detail="Same time and spaces each week"
            checked={repeat}
            onPress={() => {
              setRepeat(!repeat);
              setErrors((e) => ({ ...e, weeks: undefined }));
            }}
          />
          {repeat ? (
            <>
              <TextField
                label="Number of weeks, including the first"
                hint={`${REPEAT_WEEKS.min} to ${REPEAT_WEEKS.max} weeks`}
                value={weeksText}
                onChangeText={(text) => {
                  setWeeksText(text);
                  setErrors((e) => ({ ...e, weeks: undefined }));
                }}
                error={errors.weeks}
                testID="booking-weeks"
              />
              <Caption>
                Only the first week's time is shown free here; every week is checked when you book.
              </Caption>
            </>
          ) : null}
        </Section>
      )}

      <Section title={terms.confirmationMode === 'request' ? 'Send the request' : 'Book'}>
        <Body>
          {terms.confirmationMode === 'request'
            ? 'Staff review your request. Nothing is reserved or charged until they approve it.'
            : 'The time is held for you when you book. You then pay in your basket, which shows the price, taxes and fees.'}
        </Body>
        {conflicts.length > 0 ? (
          <View accessibilityRole="list" accessibilityLabel="Times that are not free">
            {conflicts.map((c) => (
              <Caption key={`${c.occurrenceStart}-${c.resourceId}`}>
                {`▲ Not free: ${formatWhen(c.occurrenceStart, zone.zone)}, ${resourceName(resourceNames.get(c.resourceId) ?? null)}`}
              </Caption>
            ))}
          </View>
        ) : null}
        {failure ? (
          <CommandFailure
            error={failure}
            what="the booking"
            onRetry={() => void submit()}
            onReload={() => {
              setFailure(null);
              book.reset();
              resetTime();
              void availability.refetch();
            }}
          />
        ) : null}
        {offline ? <Caption>Booking needs a connection.</Caption> : null}
        <ButtonRow>
          <Button
            label={terms.confirmationMode === 'request' ? 'Send request' : 'Book now'}
            onPress={() => void submit()}
            disabled={offline}
            busy={book.isProcessing}
            accessibilityHint={
              terms.confirmationMode === 'request'
                ? 'Sends the request to staff; nothing is reserved or charged yet'
                : 'Holds the time and opens the payment step in your basket'
            }
          />
        </ButtonRow>
      </Section>
    </View>
  );
}

/** The approved booking terms of the offering, read before the form is shown. */
function TermsThenForm({
  offering,
  kind,
  termsId,
}: {
  offering: Offering;
  kind: BookingKind;
  termsId: string;
}) {
  const policy = useApiQuery({ path: '/policy-versions/{id}', request: { path: { id: termsId } } });
  if (policy.data === undefined) {
    return policy.error ? (
      <QueryErrorView
        error={policy.error}
        onRetry={() => void policy.refetch()}
        unavailable={{
          title: 'Booking terms not available',
          description:
            'The booking terms of this activity cannot be shown, so it cannot be booked in the app. The front desk can help.',
        }}
        unavailableOffline={['Booking']}
      />
    ) : (
      <StateView variant="loading" label="the booking terms" />
    );
  }
  const terms = bookingTermsOf(policy.data);
  if (!terms) {
    return (
      <StateView
        variant="unavailable"
        title="Booking terms not available"
        description="The booking terms of this activity cannot be shown, so it cannot be booked in the app. The front desk can help."
      />
    );
  }
  return <BookingForm offering={offering} kind={kind} terms={terms} />;
}

function OfferingBooking({ offeringId }: { offeringId: string }) {
  const router = useRouter();
  const offering = useApiQuery({ path: '/offerings/{id}', request: { path: { id: offeringId } } });
  return (
    <QueryBoundary
      query={offering}
      label="the activity"
      empty={{ title: 'Not available', description: '' }}
      unavailableOffline={['Booking']}
    >
      {(o) => {
        const kind = bookingKindOf(o.kind);
        return (
          <View>
            <View style={styles.header}>
              <Text style={styles.title} accessibilityRole="header">
                {o.name}
              </Text>
              <Caption>{`${kind ? KIND_LABELS[kind] : 'Activity'} at ${o.facility.name}`}</Caption>
            </View>
            {kind === null ? (
              <StateView
                variant="unavailable"
                title="Not booked here"
                description="This activity is not a rental or a party. Open it to see how to take part."
                actionLabel="Open the activity"
                onAction={() => router.push(registrationRoutes.offering(o.id))}
              />
            ) : (
              <CapabilityGate
                capability={capabilityOfKind(kind)}
                subject={kind === 'rental' ? 'Rentals' : 'Parties'}
              >
                {o.bookingTermsPolicyVersionId ? (
                  <TermsThenForm offering={o} kind={kind} termsId={o.bookingTermsPolicyVersionId} />
                ) : (
                  <StateView
                    variant="unavailable"
                    title="Not bookable yet"
                    description="This activity has no approved booking terms yet (POL-040), so it cannot be booked. The front desk can help."
                  />
                )}
              </CapabilityGate>
            )}
          </View>
        );
      }}
    </QueryBoundary>
  );
}

export function BookingFlowScreen({ offeringId }: { offeringId: string | null }) {
  if (offeringId === null) return <NotFoundScreen />;
  return (
    <Screen>
      <View testID="screen-booking-flow">
        <RequireSession what="booking">
          <CapabilityGate capability={['rentals', 'parties']} subject="Book a rental or party">
            <OfferingBooking offeringId={offeringId} />
          </CapabilityGate>
        </RequireSession>
      </View>
    </Screen>
  );
}

export function BookingFlowRoute() {
  const params = useLocalSearchParams<{ offeringId: string }>();
  return <BookingFlowScreen offeringId={routeId(params.offeringId)} />;
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.xs },
  title: { ...type.title, color: colors.text },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  day: { ...type.body, color: colors.text, fontWeight: '600' },
  error: { ...type.caption, color: colors.danger },
});
