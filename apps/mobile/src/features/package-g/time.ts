/**
 * Facility-local times for the Package G screens (SPK-SCHED-008): a booking states its facility
 * zone (`Booking.timezone`), availability states it (`BookingAvailability.timezone`), a membership
 * reaches it through its offering (`GET /v1/offerings/{id}` `facility.timezone`) and a receipt
 * through its facility (`GET /v1/facilities/{id}`). When none is available the device's zone is
 * used and the screen says so (`zoneNotice`); a time is never shown without its zone.
 */
import { useApiRecords } from '../money/records';
import { displayZone, type DisplayZone } from '../today/time';

const LOCALE = 'en-US';

function clean(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, ' ');
}

/** "Oct 31, 2026" for the calendar day of an instant in `zone`. */
export function formatDayIn(iso: string, zone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return clean(
    new Intl.DateTimeFormat(LOCALE, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: zone,
    }).format(date),
  );
}

/** "Oct 31, 2026, 10:00 AM PDT" in `zone` (zone always named). */
export function formatInstantIn(iso: string, zone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return clean(
    new Intl.DateTimeFormat(LOCALE, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: zone,
    }).format(date),
  );
}

/** The display zone of each offering: its facility's when the offering read answered. */
export function useOfferingZones(offeringIds: readonly string[]): Map<string, DisplayZone> {
  const offerings = useApiRecords('/offerings/{id}', offeringIds);
  const zones = new Map<string, DisplayZone>();
  for (const id of new Set(offeringIds)) {
    zones.set(id, displayZone(offerings[id]?.data?.facility?.timezone ?? null));
  }
  return zones;
}

export interface FacilityDisplay {
  zone: DisplayZone;
  /** The facility's name when the read answered. */
  name: string | null;
}

/** The display zone and name of each facility (`GET /v1/facilities/{id}`, any signed-in person). */
export function useFacilities(facilityIds: readonly string[]): Map<string, FacilityDisplay> {
  const facilities = useApiRecords('/facilities/{id}', facilityIds);
  const out = new Map<string, FacilityDisplay>();
  for (const id of new Set(facilityIds)) {
    const data = facilities[id]?.data;
    out.set(id, { zone: displayZone(data?.timezone ?? null), name: data?.name ?? null });
  }
  return out;
}
