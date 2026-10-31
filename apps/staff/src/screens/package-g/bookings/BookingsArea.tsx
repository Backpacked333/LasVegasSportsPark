/**
 * SCR-S-51 Rentals and SCR-S-52 Parties (Package G, conditional; §3.16, SPK-COND-003, ENR-13),
 * nested in the Schedule area (its heading and section navigation come from ScheduleArea). One
 * screen per kind, owning everything below its path:
 *
 * - `/schedule/<kind>`: the bookings of that kind (`GET /v1/bookings`), paged;
 * - `/schedule/<kind>/new`: book or request one for a customer (`POST /v1/bookings`);
 * - `/schedule/<kind>/offerings`: the offerings with their booking terms and definitions
 *   (read-only, as catalog exposes them);
 * - `/schedule/<kind>/<bookingId>`: one booking with approve, decline and cancel.
 *
 * Behind `CapabilityGate` for `rentals` or `parties` (DEC-016, DEC-076, DEC-077; off until a system
 * administrator turns it on) with `whenOff="notice"`: existing bookings stay readable, declinable
 * and cancelable while the switch is off (the API never gates those); new bookings and approvals
 * are not offered. Route parameters are opaque ids only (§4.14).
 */
import { NavLink, Route, Routes } from 'react-router';
import { CapabilityGate } from '../../../ui/CapabilityGate';
import { StateView } from '../../../ui/StateView';
import '../participation/participation.css';
import type { PackageGScreen } from '../registry';
import { BookingDetail } from './BookingDetail';
import { BookingList } from './BookingList';
import { BookingOfferings } from './BookingOfferings';
import { KIND_CAPABILITY, KIND_PATH, KIND_WORDS, type BookingKind } from './labels';
import { NewBooking } from './NewBooking';

function Sections({ kind }: { kind: BookingKind }) {
  const base = KIND_PATH[kind];
  const words = KIND_WORDS[kind];
  const items = [
    { to: base, label: `${words.title} bookings`, end: true },
    { to: `${base}/new`, label: `New ${words.one}`, end: false },
    { to: `${base}/offerings`, label: 'Offerings and terms', end: false },
  ];
  return (
    <nav aria-label={`${words.title} sections`} className="sub-nav">
      <ul>
        {items.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end}>
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function BookingsArea({ kind, meta }: { kind: BookingKind; meta: PackageGScreen }) {
  const headingId = `package-g-${meta.slug}`;
  const words = KIND_WORDS[kind];
  return (
    <section aria-labelledby={headingId} data-testid={`package-g-${meta.slug}`}>
      <h3 id={headingId}>{meta.title}</h3>
      <p className="caption">
        {meta.id}: {meta.purpose}
      </p>
      <CapabilityGate
        capability={KIND_CAPABILITY[kind]}
        subject={meta.title}
        whenOff="notice"
        stillAvailable={`Existing ${words.many} stay listed and can still be read, declined and canceled. New ${words.many} and approvals need the switch on.`}
      >
        <Sections kind={kind} />
        <Routes>
          <Route index element={<BookingList kind={kind} />} />
          <Route path="new" element={<NewBooking kind={kind} />} />
          <Route path="offerings" element={<BookingOfferings kind={kind} meta={meta} />} />
          <Route path=":bookingId" element={<BookingDetail kind={kind} />} />
          <Route
            path="*"
            element={<StateView variant="unavailable" title="Page not available" />}
          />
        </Routes>
      </CapabilityGate>
    </section>
  );
}
