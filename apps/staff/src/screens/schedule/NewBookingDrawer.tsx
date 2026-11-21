/**
 * New booking from the schedule (handoff S 5a; INTERACTIONS 1b rows 1 and 2, 2b row 4; key flow
 * "Book a free slot for a caller"; ENR-13, SPK-COND-003, SPK-SCHED-008, SPK-PAY-002, §4.9):
 * the space and time come filled in from the free gap, the empty time tapped, or the held slot.
 *
 * - **Hold (proposed, pending decision 5):** a slot held from "Find a free slot" is kept on this
 *   screen for 15 minutes with the countdown in the header; at 2:00 it turns amber with "Keep
 *   holding"; at 0 it is released. Nothing is reserved on the server (the API has no slot hold):
 *   another booking can still take the time, and the booking command checks again.
 * - Customer: regulars first (the facility's bookers from `GET /v1/bookings`, with what they
 *   usually book, named through `GET /v1/people/{id}`), then a people search on Enter
 *   (`GET /v1/people?query=`, adults; at least two letters). Enter picks the top match.
 * - Use: the facility's bookable rental and party offerings (published with approved booking
 *   terms, POL-040); players are the booking's guest count; Repeat is weekly (2 to 52 times) or
 *   every N weeks.
 * - Book: `POST /v1/bookings` (one idempotency key per intent; money is never optimistic, so the
 *   drawer is locked while it runs). The block appears on the schedule at once as booked (held for
 *   payment) or requested. The price is the API's: the basket is quoted
 *   (`POST /v1/registration-quotes`) and shown; staff-side prices before booking are pending
 *   decision 5, so none is shown before.
 * - Charge card: no card on file exists in the API (proposed; DEC-019 provider behaviour pending),
 *   so payment is taken at the desk checkout of the booking's basket (assisted registration:
 *   the provider's own card entry or a desk tender). "Text a pay link" is proposed: the API sends
 *   no payment links yet.
 */
import { apiQueryKey, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { usePersonNameRecords } from '../../api/person-names';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { asApiError, useIntentSend } from '../../api/useIntentSend';
import type { FacilityContext } from '../../features/schedule-facilities/facility-scope';
import {
  formatLocalDate,
  localDateOf,
  startOfLocalDay,
} from '../../features/schedule-facilities/time';
import { formatMoney } from '../../features/operations/format';
import { useApi, useApp, useNow } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Icon } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { regularsOf, shortClock, MINUTE } from './schedule-model';
import { SCHEDULE_INVALIDATE } from './useScheduleMove';

type Resource = Schema<'Resource'>;
type Booking = Schema<'Booking'>;
type Quote = Schema<'Quote'>;

export interface BookingSlot {
  resourceId: string;
  start: number;
  end: number;
  /** Held from "Find a free slot" (the 15-minute screen hold applies). */
  held: boolean;
}

/** Screen hold length and its warning (INTERACTIONS 2b row 4). */
export const HOLD_MS = 15 * MINUTE;
export const HOLD_WARN_MS = 2 * MINUTE;

const BOOKABLE = new Set(['published', 'registration_open', 'registration_paused']);

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

interface Customer {
  personId: string;
  name: string;
  habit: string | null;
}

export function NewBookingDrawer({
  facility,
  resources,
  slot,
  onClose,
}: {
  facility: FacilityContext;
  resources: readonly Resource[];
  slot: BookingSlot;
  onClose: () => void;
}) {
  const { online } = useApp();
  const api = useApi();
  const now = useNow(1_000);
  const tz = facility.timezone;
  const { send } = useIntentSend([...SCHEDULE_INVALIDATE, ['api', '/baskets']]);
  const [holdUntil, setHoldUntil] = useState(() => now.getTime() + HOLD_MS);
  const left = holdUntil - now.getTime();
  const released = slot.held && left <= 0;
  const resource = resources.find((r) => r.id === slot.resourceId);
  const [length, setLength] = useState(() => Math.round((slot.end - slot.start) / MINUTE));
  const end = slot.start + length * MINUTE;

  // Customers: the facility's regular bookers first.
  const bookings = useApiPages({
    path: '/bookings',
    request: { query: { facilityId: facility.id, limit: 200 } },
  });
  const regulars = useMemo(
    () => regularsOf(bookings.data ?? [], tz).slice(0, 20),
    [bookings.data, tz],
  );
  const names = usePersonNameRecords(regulars.map((r) => r.personId));
  const [term, setTerm] = useState('');
  const [searched, setSearched] = useState('');
  const people = useApiPages({
    path: '/people',
    request: { query: { query: searched, kind: 'adult', limit: 8 } },
    enabled: searched.length >= 2,
  });
  const [customer, setCustomer] = useState<Customer | null>(null);
  // The search runs once typing pauses (at least two letters, the API's minimum).
  useEffect(() => {
    const value = term.trim();
    if (value.length < 2 || value === searched) return;
    const id = setTimeout(() => setSearched(value), 400);
    return () => clearTimeout(id);
  }, [term, searched]);
  const lower = term.trim().toLowerCase();
  const regularMatches: Customer[] = regulars
    .map((r): Customer | null => {
      const n = names.get(r.personId)?.data;
      return n
        ? { personId: r.personId, name: `${n.givenName} ${n.familyName}`, habit: r.habit }
        : null;
    })
    .filter(
      (c): c is Customer =>
        c !== null && (lower.length === 0 || c.name.toLowerCase().includes(lower)),
    );
  const searchMatches: Customer[] = (searched === term.trim() ? (people.data ?? []) : [])
    .filter((p) => !regularMatches.some((r) => r.personId === p.id))
    .map((p) => ({ personId: p.id, name: `${p.givenName} ${p.familyName}`.trim(), habit: null }));
  const suggestions = [...regularMatches, ...searchMatches].slice(0, 5);

  // Use: bookable rental and party offerings at this facility.
  const rentals = useApiQuery({
    path: '/offerings',
    request: { query: { kind: 'rental', view: 'staff', limit: 200, facilityId: facility.id } },
  });
  const parties = useApiQuery({
    path: '/offerings',
    request: { query: { kind: 'party', view: 'staff', limit: 200, facilityId: facility.id } },
  });
  const bookable = [...(rentals.data?.items ?? []), ...(parties.data?.items ?? [])].filter(
    (o, i, all) =>
      BOOKABLE.has(o.publicationState) &&
      o.bookingTermsPolicyVersionId !== null &&
      all.findIndex((x) => x.id === o.id) === i,
  );
  // Only offerings that book this space: their booking availability lists it for the day.
  const dayStart = startOfLocalDay(localDateOf(slot.start, tz), tz);
  const dayEnd = new Date(Date.parse(dayStart) + 26 * 60 * MINUTE).toISOString();
  const spaceFits = useQueries({
    queries: bookable.map((o) => ({
      queryKey: apiQueryKey('/offerings/{id}/booking-availability', {
        path: { id: o.id },
        query: { from: dayStart, to: dayEnd },
      }),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (
          await api.request('get', '/offerings/{id}/booking-availability', {
            path: { id: o.id },
            query: { from: dayStart, to: dayEnd },
            signal,
          })
        ).data,
      staleTime: 60_000,
      retry: false,
    })),
  });
  const offerings = bookable.filter((o, i) =>
    (spaceFits[i]?.data?.resources ?? []).some((r) => r.resourceId === slot.resourceId),
  );
  const checkingOfferings = spaceFits.some((q) => q.isPending);
  const [offeringId, setOfferingId] = useState('');
  useEffect(() => {
    if (!offeringId && offerings.length > 0) {
      const preferred = offerings.find((o) =>
        resource?.kind === 'room' ? o.kind === 'party' : o.kind === 'rental',
      );
      setOfferingId((preferred ?? offerings[0])!.id);
    }
  }, [offeringId, offerings, resource?.kind]);
  const offering = offerings.find((o) => o.id === offeringId) ?? null;
  const [players, setPlayers] = useState('');
  const [repeat, setRepeat] = useState<'once' | 'weekly' | 'custom'>('once');
  const [every, setEvery] = useState('2');
  const [count, setCount] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booking | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const when = `${formatLocalDate(localDateOf(slot.start, tz)).replace(/,.*$/, '')} ${Number(localDateOf(slot.start, tz).slice(8))} · ${shortClock(slot.start, tz)}–${shortClock(end, tz)}`;

  const book = async () => {
    const next: Record<string, string> = {};
    if (!customer) next.customer = 'Choose who the booking is for.';
    if (!offering) next.offering = 'Choose what the space is booked for.';
    if (offering?.kind === 'party' && !/^\d+$/.test(players))
      next.players = 'Enter the number of guests.';
    if (repeat !== 'once' && (!/^\d+$/.test(count) || Number(count) < 2 || Number(count) > 52)) {
      next.count = 'Enter 2 to 52 times, including the first.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || !customer || !offering) return;
    setBusy(true);
    setFailure(null);
    try {
      const created = await send(
        `book:${offering.id}:${customer.personId}:${slot.resourceId}:${slot.start}:${length}`,
        'post',
        '/bookings',
        {
          body: {
            offeringId: offering.id,
            bookerPersonId: customer.personId,
            start: new Date(slot.start).toISOString(),
            ...(offering.kind === 'rental' ? { end: new Date(end).toISOString() } : {}),
            resourceIds: [slot.resourceId],
            ...(/^\d+$/.test(players) ? { guestCount: Number(players) } : {}),
            ...(repeat !== 'once' && offering.kind === 'rental'
              ? {
                  recurrence: {
                    interval: repeat === 'weekly' ? 1 : Number(every),
                    count: Number(count),
                  },
                }
              : {}),
          },
        },
      );
      setBooked(created);
      if (created.basketId) {
        try {
          setQuote(
            await send(`quote:${created.basketId}`, 'post', '/registration-quotes', {
              body: {
                basketId: created.basketId,
                discountCodes: [],
                creditIds: [],
                paymentPlan: { kind: 'full' },
              },
            }),
          );
        } catch (cause) {
          setQuoteError(asApiError(cause).message);
        }
      }
    } catch (cause) {
      setFailure(asApiError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  const total = quote ? formatMoney(quote.totalMinor, quote.currency) : null;
  const holdTone = released ? 'danger' : left <= HOLD_WARN_MS ? 'warning' : 'success';

  return (
    <Drawer
      open
      onClose={onClose}
      labelledBy="new-booking-title"
      width={520}
      locked={busy}
      testId="new-booking"
      header={
        <div className="nb-head">
          <h3 id="new-booking-title">New booking</h3>
          <div className="nb-hold" data-tone={slot.held ? holdTone : 'neutral'} role="status">
            <Icon name={slot.held ? 'lock' : 'event_available'} size={20} />
            <span className="nb-hold-text">
              <b>{when}</b> · <b>{resource?.name ?? 'Space'}</b>
              {slot.held ? (released ? ' was released' : ' held for you') : ''}
            </span>
            {slot.held && !booked ? (
              released ? null : (
                <span className="nb-hold-clock" aria-label={`${clock(left)} left`}>
                  {clock(left)}
                </span>
              )
            ) : null}
            {slot.held && !booked && left <= HOLD_WARN_MS && !released ? (
              <Button
                variant="secondary"
                className="button-sm"
                onClick={() => setHoldUntil(now.getTime() + HOLD_MS)}
              >
                Keep holding
              </Button>
            ) : null}
          </div>
          {slot.held ? (
            <span className="proposed-tag">
              ◷ Proposed: kept on this screen only. Another booking can still take it.
            </span>
          ) : null}
        </div>
      }
      footer={
        booked ? (
          <div className="nb-foot">
            <Button variant="secondary" disabled title="Proposed: pay links are not in the API yet">
              <Icon name="sms" size={18} />
              Text a pay link
            </Button>
            {booked.basketId && booked.outstanding.includes('payment') ? (
              <Link
                className="button button-primary"
                to={`/registrations/assisted/${booked.basketId}`}
              >
                <Icon name="credit_card" size={18} />
                {total ? `Charge card · ${total}` : 'Take payment'}
              </Link>
            ) : (
              <Button onClick={onClose}>Done</Button>
            )}
            <p className="caption nb-foot-note">
              ◷ A pay link that keeps the hold is proposed. A card on file is not in the API: take
              the card at checkout.
            </p>
          </div>
        ) : (
          <div className="nb-foot">
            <Button variant="secondary" disabled title="Proposed: pay links are not in the API yet">
              <Icon name="sms" size={18} />
              Text a pay link
            </Button>
            <Button busy={busy} disabled={!online || busy} onClick={() => void book()}>
              <Icon name="credit_card" size={18} />
              Book and take payment
            </Button>
            <p className="caption nb-foot-note">
              {online
                ? 'Booking reserves the space; payment follows at checkout.'
                : 'Booking needs a connection.'}
            </p>
          </div>
        )
      }
    >
      {booked ? (
        <div className="nb-done" role="status">
          <p className="nb-done-title">
            <span aria-hidden="true">✓</span>{' '}
            {booked.status === 'requested'
              ? 'Requested: waits for approval'
              : booked.outstanding.includes('payment')
                ? 'Booked · pending payment'
                : 'Booked'}
          </p>
          <p className="caption">
            {customer?.name} · {offering?.name} · {when} · {resource?.name}. It is on the schedule
            now.
          </p>
          {quote ? (
            <dl className="nb-price">
              {quote.lines.map((l) => (
                <div key={l.id}>
                  <dt>{l.description}</dt>
                  <dd>{formatMoney(l.baseAmountMinor, quote.currency)}</dd>
                </div>
              ))}
              <div className="nb-total">
                <dt>Total</dt>
                <dd>{total}</dd>
              </div>
            </dl>
          ) : quoteError ? (
            <p className="caption">
              The price could not be worked out yet ({quoteError}). It is shown at checkout.
            </p>
          ) : null}
          <Link to={`/schedule/${booked.kind === 'party' ? 'parties' : 'rentals'}/${booked.id}`}>
            Open the booking →
          </Link>
        </div>
      ) : (
        <form
          className="nb-form"
          noValidate
          aria-label="New booking"
          onSubmit={(e) => {
            e.preventDefault();
            void book();
          }}
        >
          <div className="nb-field nb-customer">
            <label htmlFor="nb-customer">Customer</label>
            {customer ? (
              <div className="nb-chosen">
                <Avatar name={customer.name} personKey={customer.personId} size={36} decorative />
                <span>
                  <b>{customer.name}</b>
                  {customer.habit ? <span className="caption"> · {customer.habit}</span> : null}
                </span>
                <button type="button" className="link-button" onClick={() => setCustomer(null)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="nb-search">
                  <Icon name="search" size={20} />
                  <input
                    id="nb-customer"
                    ref={searchRef}
                    value={term}
                    autoComplete="off"
                    placeholder="Name, phone or email"
                    aria-invalid={errors.customer ? true : undefined}
                    aria-describedby={errors.customer ? 'nb-customer-error' : undefined}
                    onChange={(e) => setTerm(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      const top = suggestions[0];
                      if (top) setCustomer(top);
                      else if (term.trim().length >= 2) setSearched(term.trim());
                    }}
                  />
                  {term.trim().length >= 2 && searched !== term.trim() ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setSearched(term.trim())}
                    >
                      Search
                    </button>
                  ) : null}
                </div>
                {suggestions.length > 0 || term.trim().length >= 2 ? (
                  <ul className="nb-suggest" aria-label="Customers">
                    {suggestions.map((c, i) => (
                      <li key={c.personId}>
                        <button
                          type="button"
                          data-top={i === 0 || undefined}
                          onClick={() => setCustomer(c)}
                        >
                          <Avatar name={c.name} personKey={c.personId} size={32} decorative />
                          <span className="nb-suggest-text">
                            <b>{c.name}</b>
                            {c.habit ? <span className="caption">{c.habit}</span> : null}
                          </span>
                          {i === 0 ? (
                            <span className="nb-enter" aria-hidden="true">
                              ↵
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                    {term.trim().length >= 2 ? (
                      <li>
                        <Link className="nb-new" to="/people">
                          <span className="nb-new-icon" aria-hidden="true">
                            <Icon name="person_add" size={18} />
                          </span>
                          New customer “{term.trim()}…”
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
                {people.fetchStatus === 'fetching' ? <p className="caption">Searching…</p> : null}
              </>
            )}
            {errors.customer ? (
              <span className="error-text" id="nb-customer-error">
                {errors.customer}
              </span>
            ) : null}
          </div>
          <div className="nb-row">
            <label className="nb-field">
              Use
              <select
                value={offeringId}
                onChange={(e) => setOfferingId(e.target.value)}
                aria-invalid={errors.offering ? true : undefined}
              >
                {offerings.length === 0 ? (
                  <option value="">
                    {checkingOfferings ? 'Checking…' : 'Nothing is booked on this space'}
                  </option>
                ) : null}
                {offerings.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              {errors.offering ? <span className="error-text">{errors.offering}</span> : null}
              {!checkingOfferings && offerings.length === 0 ? (
                <span className="caption">
                  No rental or party is set up for {resource?.name ?? 'this space'}. Spaces are
                  added to an offering in Programs.
                </span>
              ) : null}
            </label>
            <label className="nb-field">
              {offering?.kind === 'party' ? 'Guests' : 'Players (about)'}
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={players}
                onChange={(e) => setPlayers(e.target.value)}
                aria-invalid={errors.players ? true : undefined}
              />
              {errors.players ? <span className="error-text">{errors.players}</span> : null}
            </label>
          </div>
          <label className="nb-field">
            Length
            <select value={length} onChange={(e) => setLength(Number(e.target.value))}>
              {[...new Set([30, 60, 90, 120, 180, Math.round((slot.end - slot.start) / MINUTE)])]
                .filter((m) => m >= 15 && m <= 1440)
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {m} min (until {shortClock(slot.start + m * MINUTE, tz)})
                  </option>
                ))}
            </select>
          </label>
          {offering?.kind !== 'party' ? (
            <div className="nb-field">
              <span id="nb-repeat">Repeat</span>
              <SegmentedControl
                label="Repeat"
                size="lg"
                segments={[
                  { value: 'once', label: 'Once' },
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'custom', label: 'Custom' },
                ]}
                value={repeat}
                onChange={setRepeat}
              />
              {repeat !== 'once' ? (
                <div className="nb-row">
                  {repeat === 'custom' ? (
                    <label className="nb-field">
                      Every
                      <select value={every} onChange={(e) => setEvery(e.target.value)}>
                        {[2, 3, 4].map((n) => (
                          <option key={n} value={n}>
                            {n} weeks
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="nb-field">
                    Times, including the first
                    <input
                      type="number"
                      min={2}
                      max={52}
                      value={count}
                      onChange={(e) => setCount(e.target.value)}
                      aria-invalid={errors.count ? true : undefined}
                    />
                    {errors.count ? <span className="error-text">{errors.count}</span> : null}
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="nb-field">
            <span>Add-ons</span>
            <span className="proposed-tag">
              ◷ Proposed: extras on a booking are not in the API yet
            </span>
          </div>
          <dl className="nb-price">
            <div>
              <dt>
                {resource?.name ?? 'Space'} · {length} min
              </dt>
              <dd>Priced at booking</dd>
            </div>
          </dl>
          {failure ? (
            <p className="error-text" role="alert">
              Not booked: {failure}
            </p>
          ) : null}
          <button type="submit" hidden />
        </form>
      )}
    </Drawer>
  );
}
