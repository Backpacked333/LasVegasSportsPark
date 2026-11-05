/**
 * SCR-S-51 / SCR-S-52: rental or party bookings for staff (`GET /v1/bookings`, ENR-13,
 * SPK-COND-003), newest first in keyset pages with "Load more" (§4.5), in the facility chosen in
 * the header (or every facility in the viewer's scope; the API narrows to it, §4.3).
 *
 * The API lists rentals and parties together (no kind filter, reported), so this list shows the
 * bookings of its kind among the loaded pages and says so; "Load more" keeps looking. Each row
 * names the booker (names only, §4.14), the times in the booking's facility zone (SPK-SCHED-008),
 * its status in the machine's words and what is still outstanding. Bookings stay listed while the
 * capability is off (reads are never gated, DEC-016).
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiPages } from '../../../api/useApiPages';
import { useApp } from '../../../providers/AppProviders';
import { SelectField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { formatInstant, formatRange, plural } from '../participation/format';
import { personNameText, usePersonNames } from '../participation/names';
import {
  BOOKING_STATUS,
  BOOKING_STATUSES,
  KIND_PATH,
  KIND_WORDS,
  OUTSTANDING,
  type Booking,
  type BookingKind,
  type BookingStatus,
} from './labels';

function BookingRow({ booking, booker }: { booking: Booking; booker: string }) {
  const status = BOOKING_STATUS[booking.status];
  const words = KIND_WORDS[booking.kind];
  const resources = booking.occurrences[0]?.resources ?? [];
  return (
    <li>
      <div className="row-text">
        <Link className="row-title" to={`${KIND_PATH[booking.kind]}/${booking.id}`}>
          {booking.offeringName ?? `${words.title} booking`}
        </Link>
        <span>
          {formatRange(
            booking.firstStart,
            booking.occurrences[0]?.end ?? booking.lastEnd,
            booking.timezone,
          )}
          {booking.occurrences.length > 1
            ? `; weekly, ${plural(booking.occurrences.length, 'occurrence')}, the last on ${formatInstant(
                booking.occurrences[booking.occurrences.length - 1]?.start ?? booking.lastEnd,
                booking.timezone,
              )}`
            : ''}
        </span>
        <span>Booked for {booker}</span>
        {resources.length > 0 ? (
          <span className="caption">
            {resources.map((r) => r.name ?? `Resource ${r.id.slice(0, 8)}`).join(', ')}
            {booking.guestCount !== null ? `; ${plural(booking.guestCount, 'guest')}` : ''}
          </span>
        ) : null}
      </div>
      <div className="row-text">
        <StatusBadge tone={status.tone} label={status.label} />
        {booking.outstanding.length > 0 ? (
          <span className="caption">
            Outstanding: {booking.outstanding.map((o) => OUTSTANDING[o]).join(', ')}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function BookingList({ kind }: { kind: BookingKind }) {
  const { facilityId } = useApp();
  const [status, setStatus] = useState<BookingStatus | ''>('');
  const words = KIND_WORDS[kind];
  const pages = useApiPages({
    path: '/bookings',
    request: {
      query: {
        limit: 50,
        ...(facilityId ? { facilityId } : {}),
        ...(status ? { status } : {}),
      },
    },
  });
  const ofKind = pages.data?.filter((b) => b.kind === kind);
  const names = usePersonNames((ofKind ?? []).map((b) => b.bookerPersonId));
  const query = { ...pages, data: ofKind };
  return (
    <section aria-labelledby={`${kind}-bookings-title`}>
      <h4 id={`${kind}-bookings-title`}>{words.title} bookings</h4>
      <div className="pg-toolbar">
        <SelectField
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as BookingStatus | '')}
          placeholder="All statuses"
          options={BOOKING_STATUSES.map((s) => ({ value: s, label: BOOKING_STATUS[s].label }))}
        />
      </div>
      <p className="caption">
        The API lists rentals and parties together; this list shows the {words.many} among the
        bookings loaded so far, newest first.
      </p>
      <QueryBoundary
        query={query}
        label={`${words.one} bookings`}
        isEmpty={(items) => items.length === 0}
        empty={
          pages.hasNextPage
            ? {
                title: `No ${words.many} on the pages loaded so far`,
                description: `More bookings exist. Load more to keep looking for ${words.many}.`,
              }
            : {
                title: `No ${words.many}`,
                description: status
                  ? `No ${words.many} are ${BOOKING_STATUS[status].label} here.`
                  : `No ${words.many} have been booked or requested here.`,
              }
        }
      >
        {(items) => (
          <ul className="list" aria-label={`${words.title} bookings`}>
            {items.map((booking) => (
              <BookingRow
                key={booking.id}
                booking={booking}
                booker={personNameText(names.get(booking.bookerPersonId), 'Booker')}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="bookings" />
    </section>
  );
}
