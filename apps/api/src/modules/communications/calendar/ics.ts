/**
 * Minimal, dependency-free iCalendar (RFC 5545) rendering for private feeds (SPK-COMMS-008).
 * Event identities are stable (`uid` = the scheduling event id) and `sequence` increases with every
 * change so subscribed calendars update or remove the right entry.
 */
export interface IcsEvent {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  status: 'CONFIRMED' | 'CANCELLED';
  sequence: number;
  location?: string | null;
  description?: string | null;
  lastModified: Date;
}

export interface IcsCalendar {
  productId: string;
  name: string;
  now: Date;
  events: IcsEvent[];
}

const CRLF = '\r\n';

export function renderIcs(calendar: IcsCalendar): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(calendar.productId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
  ];
  for (const event of calendar.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${formatUtc(calendar.now)}`,
      `DTSTART:${formatUtc(event.start)}`,
      `DTEND:${formatUtc(event.end)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      `STATUS:${event.status}`,
      `SEQUENCE:${Math.max(0, Math.trunc(event.sequence))}`,
      `LAST-MODIFIED:${formatUtc(event.lastModified)}`,
    );
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join(CRLF) + CRLF;
}

/** RFC 5545 §3.3.5: backslash, semicolon and comma are escaped; newlines become literal \n. */
export function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll(/\r?\n/g, '\\n');
}

/** UTC date-time form `YYYYMMDDTHHMMSSZ`. */
export function formatUtc(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** RFC 5545 §3.1: content lines are folded at 75 octets with CRLF + one space. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    const limit = parts.length === 0 ? 75 : 74;
    if (currentBytes + size > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) parts.push(current);
  return parts.map((p, i) => (i === 0 ? p : ` ${p}`)).join(CRLF);
}
