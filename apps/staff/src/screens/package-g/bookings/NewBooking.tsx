/**
 * Book or request a rental or party for a customer (SCR-S-51, SCR-S-52; ENR-13, SPK-COND-003,
 * SPK-REG-001 rental request, SPK-SCHED-008): `POST /v1/bookings` with the booker, the start (and a
 * rental's end), a rental's weekly repetition, the resources and a party's guests, one idempotency
 * key per booking intent.
 *
 * - The offering's approved booking terms are shown before anything is sent: confirmed at once
 *   (reserved and held for payment) or by request (nothing reserved until approved, DEC-029
 *   pending), and the deposit as the terms state it. An offering without approved terms cannot be
 *   booked (POL-040). No price, term, deposit, length or repetition is preset.
 * - Free start times come from `GET /v1/offerings/{id}/booking-availability` for one facility-local
 *   day (the party's length is the package's; a rental's is typed, 15 to 1440 minutes). Only times
 *   where enough resources are free are offered, and exactly the offering's number of resources
 *   must be chosen: everything is reserved together or not at all (partial completion is not
 *   permitted). The API checks every repetition again; RESOURCE_CONFLICT lists what is taken, and
 *   "Check free times again" clears the refused time and resources so a time that is still free
 *   must be chosen. A start or resource no longer in the latest free times is never sent.
 * - On a day when the clocks go back, two starts share a wall-clock time; each is labelled with
 *   its zone abbreviation (for example 01:00 PDT and 01:00 PST) so the instant is unambiguous.
 * - New bookings need the capability on (DEC-076, DEC-077); the form is not offered while off.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import {
  addDaysToLocalDate,
  localTimeOf,
  startOfLocalDay,
  weekdayOfLocalDate,
  zoneName,
} from '../../../features/schedule-facilities/time';
import { useApp } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { SelectField, TextField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { CommandProblem, validationPath } from '../participation/CommandProblem';
import { DateField } from '../participation/DateField';
import { formatInstant, plural } from '../participation/format';
import { PersonPicker, type ChosenPerson } from '../participation/PersonPicker';
import {
  ACTIONS,
  NotAvailableToYou,
  useActionAllowed,
  useCapabilityOn,
} from '../participation/permission';
import { BOOKING_KEYS } from './BookingDecision';
import { BookingTermsView } from './BookingTermsView';
import { BOOKING_STATUS, KIND_CAPABILITY, KIND_PATH, KIND_WORDS, type BookingKind } from './labels';

const BOOKABLE_STATES = new Set(['published', 'registration_open', 'registration_paused']);
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

type Availability = NonNullable<ReturnType<typeof useAvailability>['data']>;

function useAvailability(args: {
  offeringId: string;
  date: string;
  zone: string | null;
  durationMinutes: number | null;
  kind: BookingKind;
}) {
  const window = useMemo(() => {
    if (!args.zone || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) return null;
    try {
      return {
        from: startOfLocalDay(args.date, args.zone),
        to: startOfLocalDay(addDaysToLocalDate(args.date, 1), args.zone),
      };
    } catch {
      return null;
    }
  }, [args.date, args.zone]);
  const needsDuration = args.kind === 'rental';
  return useApiQuery({
    path: '/offerings/{id}/booking-availability',
    request: {
      path: { id: args.offeringId },
      query: {
        from: window?.from ?? '',
        to: window?.to ?? '',
        ...(needsDuration && args.durationMinutes ? { durationMinutes: args.durationMinutes } : {}),
      },
    },
    enabled:
      !!args.offeringId && window !== null && (!needsDuration || args.durationMinutes !== null),
  });
}

/** Start instants where at least `resourceCount` resources have a free slot, in order. */
function startTimes(availability: Availability): string[] {
  const counts = new Map<string, number>();
  for (const resource of availability.resources) {
    for (const slot of resource.freeIntervals) {
      counts.set(slot.start, (counts.get(slot.start) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= availability.resourceCount)
    .map(([start]) => start)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}

function freeAt(availability: Availability, start: string) {
  return availability.resources.filter((r) => r.freeIntervals.some((s) => s.start === start));
}

/**
 * "18:00", or "01:00 PDT" and "01:00 PST" when two starts share a wall-clock time (the hour the
 * clocks go back, SPK-SCHED-008).
 */
function startLabels(starts: readonly string[], timeZone: string): Map<string, string> {
  const local = starts.map((s) => localTimeOf(s, timeZone));
  return new Map(
    starts.map((s, index) => {
      const time = local[index] as string;
      const repeated = local.filter((t) => t === time).length > 1;
      return [s, repeated ? `${time} ${zoneName(s, timeZone)}` : time];
    }),
  );
}

export function NewBooking({ kind }: { kind: BookingKind }) {
  const { online, facilityId } = useApp();
  const words = KIND_WORDS[kind];
  const capabilityOn = useCapabilityOn(KIND_CAPABILITY[kind]);
  const allowed = useActionAllowed(ACTIONS.requestBooking, facilityId);
  const offerings = useApiQuery({
    path: '/offerings',
    request: { query: { kind, view: 'staff', limit: 200, ...(facilityId ? { facilityId } : {}) } },
  });
  const [offeringId, setOfferingId] = useState('');
  const [booker, setBooker] = useState<ChosenPerson | null>(null);
  const [date, setDate] = useState('');
  const [length, setLength] = useState('');
  const [start, setStart] = useState('');
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [guests, setGuests] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [repeatEvery, setRepeatEvery] = useState('');
  const [count, setCount] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useApiCommand('post', '/bookings', { invalidate: BOOKING_KEYS });

  const bookable = (offerings.data?.items ?? []).filter(
    (o) => BOOKABLE_STATES.has(o.publicationState) && o.bookingTermsPolicyVersionId !== null,
  );
  const offering = bookable.find((o) => o.id === offeringId) ?? null;
  const zone = offering?.facility.timezone ?? null;
  const lengthMinutes = /^\d+$/.test(length) ? Number(length) : null;
  const lengthValid = lengthMinutes !== null && lengthMinutes >= 15 && lengthMinutes <= 1440;
  const availability = useAvailability({
    offeringId,
    date,
    zone,
    durationMinutes: kind === 'rental' ? (lengthValid ? lengthMinutes : null) : null,
    kind,
  });

  if (!allowed) {
    return <NotAvailableToYou what={`Booking ${words.many}`} action={ACTIONS.requestBooking} />;
  }
  if (!capabilityOn) {
    return (
      <p>
        New {words.many} are not taken while {words.many} are turned off. Existing ones stay listed.
      </p>
    );
  }

  const created = create.status === 'success' ? create.data : undefined;
  if (created) {
    const status = BOOKING_STATUS[created.status];
    return (
      <section className="pg-panel" aria-labelledby="new-booking-done">
        <h4 id="new-booking-done">
          {created.status === 'requested' ? 'Request sent' : `${words.title} booked`}
        </h4>
        <p role="status">
          Now {status.label}: {status.meaning}
        </p>
        <p>
          <Link to={`${KIND_PATH[kind]}/${created.id}`}>Open the {words.one}</Link>
        </p>
        {created.status === 'held' && created.basketId ? (
          <p>
            <Link to={`/registrations/assisted/${created.basketId}`}>
              Continue to checkout in assisted registration
            </Link>
          </p>
        ) : null}
        <Button variant="secondary" onClick={() => create.reset()}>
          Book another {words.one}
        </Button>
      </section>
    );
  }

  const changeOffering = (id: string) => {
    setOfferingId(id);
    setStart('');
    setResourceIds([]);
  };
  const serverField = validationPath(create.error);
  const fieldError = (key: string) =>
    errors[key] ?? (serverField === key ? (create.error?.message ?? null) : null);

  const submit = () => {
    const next: Record<string, string> = {};
    if (!offering) next.offeringId = `Choose the ${words.one} offering.`;
    if (!booker) next.bookerPersonId = 'Choose who the booking is for.';
    if (!date) next.date = 'Choose the date.';
    if (kind === 'rental' && !lengthValid) next.end = 'Enter a length from 15 to 1440 minutes.';
    // Only a start and resources the latest free times still offer are sent.
    const free = availability.data;
    const offered = free ? startTimes(free) : [];
    if (!start || !offered.includes(start)) next.start = 'Choose a free start time.';
    const needed = free?.resourceCount ?? 0;
    const freeIds = free && start ? freeAt(free, start).map((r) => r.resourceId) : [];
    if (
      start &&
      !next.start &&
      (resourceIds.length !== needed || resourceIds.some((id) => !freeIds.includes(id)))
    ) {
      next.resourceIds = `Choose exactly ${plural(needed, 'resource')}.`;
    }
    if (kind === 'party' && !/^\d+$/.test(guests)) next.guestCount = 'Enter the number of guests.';
    if (repeat) {
      if (!repeatEvery) next.recurrence = 'Choose how often it repeats.';
      if (!/^\d+$/.test(count) || Number(count) < 2 || Number(count) > 52) {
        next['recurrence.count'] = 'Enter 2 to 52 occurrences.';
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || !offering || !booker) return;
    const end =
      kind === 'rental' && lengthMinutes !== null
        ? new Date(Date.parse(start) + lengthMinutes * 60_000).toISOString()
        : undefined;
    void create
      .submit({
        body: {
          offeringId: offering.id,
          bookerPersonId: booker.id,
          start,
          ...(end ? { end } : {}),
          resourceIds,
          ...(kind === 'party' ? { guestCount: Number(guests) } : {}),
          ...(kind === 'rental' && repeat
            ? { recurrence: { interval: Number(repeatEvery), count: Number(count) } }
            : {}),
        },
      })
      .catch(() => undefined);
  };

  return (
    <section aria-labelledby="new-booking-title">
      <h4 id="new-booking-title">New {words.one}</h4>
      <QueryBoundary
        query={offerings}
        label={`${words.one} offerings`}
        isEmpty={() => bookable.length === 0}
        empty={{
          title: `No bookable ${words.one} offering`,
          description: `An offering can be booked once it is published with approved booking terms (POL-040).`,
        }}
        unavailableOffline={['booking']}
      >
        {(page) => (
          <form
            className="pg-form"
            noValidate
            aria-label={`New ${words.one}`}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <SelectField
              label="Offering"
              required
              value={offeringId}
              onChange={changeOffering}
              placeholder={`Choose a ${words.one} offering`}
              options={bookable.map((o) => ({
                value: o.id,
                label: `${o.name} (${o.facility.name})`,
              }))}
              error={fieldError('offeringId')}
            />
            {page.nextCursor ? (
              <p className="caption">
                More offerings exist; choose a facility in the header to narrow the list.
              </p>
            ) : null}
            {offering ? (
              <div className="pg-panel" role="group" aria-label="Booking terms">
                <BookingTermsView
                  policyVersionId={offering.bookingTermsPolicyVersionId}
                  timeZone={zone}
                />
              </div>
            ) : null}
            <PersonPicker
              label="Booked for"
              required
              value={booker}
              onChange={setBooker}
              error={fieldError('bookerPersonId')}
            />
            <DateField
              label={`Date (${zone ?? 'facility time'})`}
              required
              value={date}
              onChange={(v) => {
                setDate(v);
                setStart('');
                setResourceIds([]);
              }}
              hint="The facility's local date; free times are shown for that day."
              error={fieldError('date')}
            />
            {kind === 'rental' ? (
              <TextField
                label="Length in minutes"
                type="number"
                required
                value={length}
                onChange={(v) => {
                  setLength(v);
                  setStart('');
                  setResourceIds([]);
                }}
                hint="15 to 1440 minutes; there is no default length."
                error={fieldError('end')}
              />
            ) : null}
            {offering && date ? (
              <QueryBoundary
                query={availability}
                label="free times"
                isEmpty={(a) => startTimes(a).length === 0}
                empty={{
                  title: 'No free time that day',
                  description: `No start time on ${date} has enough free resources. Try another day.`,
                }}
                unavailableOffline={['booking']}
              >
                {(a) => {
                  const labels = startLabels(startTimes(a), a.timezone);
                  return (
                    <>
                      <fieldset
                        className="field fieldset"
                        aria-invalid={fieldError('start') ? true : undefined}
                      >
                        <legend>
                          Start ({a.timezone}, {a.durationMinutes} minutes)
                          <span className="field-required"> (required)</span>
                        </legend>
                        {startTimes(a).map((s) => (
                          <label key={s} className="choice">
                            <input
                              type="radio"
                              name="booking-start"
                              checked={start === s}
                              onChange={() => {
                                setStart(s);
                                const free = freeAt(a, s);
                                setResourceIds(
                                  free.length === a.resourceCount
                                    ? free.map((r) => r.resourceId)
                                    : [],
                                );
                              }}
                            />
                            {labels.get(s)}
                          </label>
                        ))}
                        {fieldError('start') ? (
                          <span className="error-text">{fieldError('start')}</span>
                        ) : null}
                      </fieldset>
                      {start ? (
                        <fieldset className="field fieldset">
                          <legend>
                            Resources: exactly {plural(a.resourceCount, 'resource')}, reserved
                            together
                          </legend>
                          {freeAt(a, start).map((r) => (
                            <label key={r.resourceId} className="choice">
                              <input
                                type="checkbox"
                                checked={resourceIds.includes(r.resourceId)}
                                onChange={(event) =>
                                  setResourceIds((ids) =>
                                    event.target.checked
                                      ? [...ids, r.resourceId]
                                      : ids.filter((id) => id !== r.resourceId),
                                  )
                                }
                              />
                              {r.name ?? `Resource ${r.resourceId.slice(0, 8)}`}
                            </label>
                          ))}
                          {fieldError('resourceIds') ? (
                            <span className="error-text">{fieldError('resourceIds')}</span>
                          ) : null}
                        </fieldset>
                      ) : null}
                      {kind === 'rental' && start ? (
                        <fieldset className="field fieldset">
                          <legend>Repeat</legend>
                          <label className="choice">
                            <input
                              type="checkbox"
                              checked={repeat}
                              onChange={(event) => setRepeat(event.target.checked)}
                            />
                            Repeat weekly on{' '}
                            {WEEKDAY_NAMES[weekdayOfLocalDate(date)] ?? 'the same day'}s
                          </label>
                          {repeat ? (
                            <>
                              <SelectField
                                label="How often"
                                required
                                value={repeatEvery}
                                onChange={setRepeatEvery}
                                placeholder="Choose"
                                options={[1, 2, 3, 4].map((n) => ({
                                  value: String(n),
                                  label: n === 1 ? 'Every week' : `Every ${n} weeks`,
                                }))}
                                error={fieldError('recurrence')}
                              />
                              <TextField
                                label="Number of occurrences"
                                type="number"
                                required
                                value={count}
                                onChange={setCount}
                                hint="2 to 52, including the first; the API checks every one."
                                error={fieldError('recurrence.count')}
                              />
                            </>
                          ) : null}
                        </fieldset>
                      ) : null}
                    </>
                  );
                }}
              </QueryBoundary>
            ) : null}
            {kind === 'party' ? (
              <TextField
                label="Guests"
                type="number"
                required
                value={guests}
                onChange={setGuests}
                hint="The package's guest limit applies."
                error={fieldError('guestCount')}
              />
            ) : null}
            {start ? (
              <p className="caption">
                Starts {formatInstant(start, zone)}
                {repeat && /^\d+$/.test(count) ? `, ${plural(Number(count), 'occurrence')}` : ''}.
              </p>
            ) : null}
            <div className="pg-actions">
              <Button type="submit" busy={create.isProcessing} disabled={!online}>
                Book the {words.one}
              </Button>
            </div>
            {!online ? <p className="caption">Booking needs a connection.</p> : null}
            <CommandProblem
              error={create.error}
              onRetry={submit}
              onReload={() => {
                // The refused time may be gone: staff choose again from the fresh free times.
                create.reset();
                setStart('');
                setResourceIds([]);
                void availability.refetch();
              }}
              reloadLabel="Check free times again"
              timeZone={zone}
              resourceLabel={(id) =>
                availability.data?.resources.find((r) => r.resourceId === id)?.name ??
                `Resource ${id.slice(0, 8)}`
              }
            />
          </form>
        )}
      </QueryBoundary>
      {!offeringId && bookable.length === 0 && offerings.data ? (
        <StateView
          variant="pending-decision"
          subject={`Booking terms for ${words.many}`}
          decisions={['POL-040']}
          owner="Product and operations; Finance approves the terms"
        />
      ) : null}
    </section>
  );
}
