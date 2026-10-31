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

/** A line break of any convention: CRLF, a bare CR or LF, NEL, LINE and PARAGRAPH SEPARATOR. */
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/g;

/**
 * RFC 5545 §3.3.11 TEXT: backslash, semicolon and comma are escaped and every line break becomes a
 * literal `\n`: CRLF, a bare CR or LF, and the Unicode breaks NEL, LINE SEPARATOR and PARAGRAPH
 * SEPARATOR. TEXT admits no other control character (C0 except tab, DEL, C1), so those are
 * dropped. Stored strings (a captain's team name in a fixture title, for example) therefore never
 * end a content line or start a new one in another family's feed (R2-TENANCY-INPUT-04).
 */
export function escapeText(value: string): string {
  return withoutControls(
    value
      .replaceAll('\\', '\\\\')
      .replaceAll(';', '\\;')
      .replaceAll(',', '\\,')
      .replaceAll(LINE_BREAK, '\\n'),
  );
}

/** Drops C0 controls other than tab, DEL and C1 controls (RFC 5545 §3.1 CONTROL, §3.3.11). */
function withoutControls(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) continue;
    out += char;
  }
  return out;
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
