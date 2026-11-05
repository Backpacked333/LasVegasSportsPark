/**
 * Times on staff screens (SPK-SCHED-008): facility-local when the facility's timezone is known
 * (from the facility directory, `GET /v1/facilities`), otherwise the device's zone, always with the zone named so a time is never
 * mistaken for facility-local time.
 */

export function formatDateTime(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatTime(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** "10:00 to 11:30 PDT" in the facility's zone. */
export function formatTimeRange(start: string, end: string, timeZone?: string | null): string {
  const zone = new Intl.DateTimeFormat(undefined, {
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  })
    .formatToParts(new Date(start))
    .find((p) => p.type === 'timeZoneName')?.value;
  return `${formatTime(start, timeZone)} to ${formatTime(end, timeZone)}${zone ? ` ${zone}` : ''}`;
}

/** "45 min", "2 h 5 min", "3 d". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d`;
}

/** The device's IANA time zone (for example America/New_York), or null when the platform does not say. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** `timeZone` when the platform knows it as an IANA zone, otherwise null (the device zone, named). */
export function knownTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    return null;
  }
}

/**
 * "your device's time zone (America/New_York)", or "your device's time zone" when the platform does
 * not say: the one wording for the device's clock on every staff screen (SPK-UX-010).
 */
export function deviceZonePhrase(): string {
  const zone = deviceTimeZone();
  return zone ? `your device's time zone (${zone})` : "your device's time zone";
}

/**
 * The hint naming the clock a `datetime-local` field is read in (SPK-SCHED-008), in one wording on
 * every staff screen (SPK-UX-010): "Facility time (America/Los_Angeles)." when the facility's zone
 * is known, otherwise "Your device's time zone (America/New_York).", so a time typed on a device in
 * another zone is never mistaken for facility time.
 */
export function inputZoneHint(timeZone: string | null | undefined): string {
  const zone = knownTimeZone(timeZone);
  if (zone) return `Facility time (${zone}).`;
  const phrase = deviceZonePhrase();
  return `${phrase[0]!.toUpperCase()}${phrase.slice(1)}.`;
}

/** A `datetime-local` input value (device zone) as an ISO instant, or null when empty or invalid. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
