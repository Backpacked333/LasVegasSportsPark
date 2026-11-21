/**
 * The sessions of a new registration as an iCalendar file (redesign handoff 1g "Add to phone",
 * INTERACTIONS "1e–1g" row 8: local, `.ics`). Pure: the events are the API's sessions, written in
 * UTC so every calendar shows them on its own clock; the name of the activity and its place only
 * (no child's name leaves the app this way, §4.14).
 */
import type { Schema } from '@sportspark/api-client';

type OfferingSession = Schema<'OfferingSession'>;

/** "20261205T170000Z". */
function stamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
}

/** Text values escaped as RFC 5545 asks (backslash, semicolon, comma, newline). */
function text(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/;/gu, '\\;')
    .replace(/,/gu, '\\,')
    .replace(/\n/gu, '\\n');
}

export function sessionsIcs(input: {
  title: string;
  location: string | null;
  sessions: readonly Pick<OfferingSession, 'id' | 'scheduledStart' | 'scheduledEnd' | 'status'>[];
  /** When the file is made (the injected clock). */
  now: Date;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sportspark//Parent app//EN',
    'CALSCALE:GREGORIAN',
  ];
  for (const session of input.sessions) {
    if (session.status === 'canceled') continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${session.id}@sportspark`,
      `DTSTAMP:${stamp(input.now.toISOString())}`,
      `DTSTART:${stamp(session.scheduledStart)}`,
      `DTEND:${stamp(session.scheduledEnd)}`,
      `SUMMARY:${text(input.title)}`,
      ...(input.location ? [`LOCATION:${text(input.location)}`] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
