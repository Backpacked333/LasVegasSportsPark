/**
 * Facility-local dates for money records that name an offering (SPK-SCHED-008): a session
 * package carries its `offeringId`, and the public offering (`GET /v1/offerings/{id}`) carries its
 * facility with the IANA time zone. When that read is not available (a closed offering, offline,
 * an error), the device's zone is used and named, as everywhere else in the app: a date is never
 * shown without saying which clock it is on.
 *
 * Payment attempts, receipts and orders carry no facility (reported; "facility zone on money
 * records" stays open in the API), so those keep the device zone with the zone named.
 */
import { displayZone, type DisplayZone } from '../today/time';
import { useApiRecords } from './records';

const LOCALE = 'en-US';

function clean(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, ' ');
}

/** "Nov 1, 2026, 11:59 PM PDT" in `zone`. */
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

/**
 * The display zone of each offering id: the facility's when the offering read answered, else the
 * device's (with `facility: false`, so the screen says so).
 */
export function useOfferingZones(offeringIds: readonly string[]): Map<string, DisplayZone> {
  const offerings = useApiRecords('/offerings/{id}', offeringIds);
  const zones = new Map<string, DisplayZone>();
  for (const id of new Set(offeringIds)) {
    zones.set(id, displayZone(offerings[id]?.data?.facility?.timezone ?? null));
  }
  return zones;
}
