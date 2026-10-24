import { describe, expect, it } from 'vitest';
import { escapeText, fold, formatUtc, renderIcs } from './ics';

describe('iCalendar rendering (SPK-COMMS-008 stable event identities)', () => {
  const now = new Date('2026-10-23T12:00:00Z');

  it('renders one VEVENT per entry with the event id as UID, UTC instants, status and sequence', () => {
    const ics = renderIcs({
      productId: '-//Sportspark//Test//EN',
      name: 'My activities',
      now,
      events: [
        {
          uid: '0199c0f0-0000-7000-8000-000000000001',
          summary: 'U10 game; Lions, Tigers',
          start: new Date('2026-11-07T18:00:00Z'),
          end: new Date('2026-11-07T19:00:00Z'),
          status: 'CONFIRMED',
          sequence: 2,
          location: 'Pitch 1 north half',
          description: 'game (America/Los_Angeles)',
          lastModified: new Date('2026-10-22T08:00:00Z'),
        },
        {
          uid: '0199c0f0-0000-7000-8000-000000000002',
          summary: 'Canceled practice',
          start: new Date('2026-11-08T18:00:00Z'),
          end: new Date('2026-11-08T19:00:00Z'),
          status: 'CANCELLED',
          sequence: 0,
          lastModified: now,
        },
      ],
    });
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('UID:0199c0f0-0000-7000-8000-000000000001');
    expect(lines).toContain('DTSTART:20261107T180000Z');
    expect(lines).toContain('DTEND:20261107T190000Z');
    expect(lines).toContain('SUMMARY:U10 game\\; Lions\\, Tigers');
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines).toContain('SEQUENCE:2');
    expect(lines).toContain('LOCATION:Pitch 1 north half');
    expect(lines).toContain('STATUS:CANCELLED');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain(`DTSTAMP:${formatUtc(now)}`);
  });

  it('escapes text per RFC 5545 and folds lines at 75 octets', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    const long = `SUMMARY:${'x'.repeat(200)}`;
    const folded = fold(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const [i, part] of parts.entries()) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
      if (i > 0) expect(part.startsWith(' ')).toBe(true);
    }
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(long);
    // multi-byte characters are never split
    const accented = `SUMMARY:${'é'.repeat(60)}`;
    const foldedAccented = fold(accented).split('\r\n');
    expect(foldedAccented.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(accented);
  });

  it('formats UTC date-times with zero padding', () => {
    expect(formatUtc(new Date('2026-01-05T03:04:05Z'))).toBe('20260105T030405Z');
  });
});
