import { describe, expect, it } from 'vitest';
import { escapeText, fold, formatUtc, renderIcs } from './ics';

/** Code points RFC 5545 TEXT does not admit (C0 except tab, DEL, C1) plus the Unicode line breaks. */
function controlsOf(text: string): number[] {
  return [...text]
    .map((char) => char.codePointAt(0) ?? 0)
    .filter(
      (code) =>
        (code < 0x20 && code !== 0x09) ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029,
    );
}

/** Line splitting as lenient parsers do it (Python `str.splitlines` breaks on all of these). */
const LENIENT_BREAKS = new Set(
  [0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029].map((c) =>
    String.fromCodePoint(c),
  ),
);
function lenientLines(text: string): string[] {
  const lines = [''];
  for (const char of text) {
    if (LENIENT_BREAKS.has(char)) lines.push('');
    else lines[lines.length - 1] += char;
  }
  return lines.filter((line) => line !== '');
}

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

  it('SPK-COMMS-008 / RFC 5545 §3.3.11 (R2-TENANCY-INPUT-04): a bare CR, NUL or other control character in stored text never starts a content line', () => {
    // every line break convention becomes a literal \n; tab stays; other controls are dropped
    expect(escapeText('a\rb')).toBe('a\\nb');
    expect(escapeText('a\r\nb\nc')).toBe('a\\nb\\nc');
    expect(escapeText('a\u0085b\u2028c\u2029d')).toBe('a\\nb\\nc\\nd');
    expect(escapeText('a\u0000b\u0007c\u000bd\u001be\u007ff\u009bg\th')).toBe('abcdefg\th');

    const injected = 'Lions\rEND:VEVENT\rBEGIN:VEVENT\rSUMMARY:Game canceled v Tigers';
    const ics = renderIcs({
      productId: '-//Sportspark//Test//EN',
      name: 'Family\rX-INJECTED:1',
      now,
      events: [
        {
          uid: '0199c0f0-0000-7000-8000-000000000003',
          summary: injected,
          start: new Date('2026-11-07T18:00:00Z'),
          end: new Date('2026-11-07T19:00:00Z'),
          status: 'CONFIRMED',
          sequence: 1,
          location: 'Pitch 1\u0000\nURL:https://example.test',
          description: 'game\u2028BEGIN:VALARM\u000c\u001eTRIGGER:-PT5M',
          lastModified: now,
        },
      ],
    });
    // the only line breaks are the CRLF content-line separators (and folds)
    expect(ics).not.toMatch(/\r(?!\n)/);
    expect(ics).not.toMatch(/(?<!\r)\n/);
    expect(controlsOf(ics.replaceAll('\r\n', ''))).toEqual([]);
    // a lenient parser that breaks lines on any convention still sees one event and no injected line
    const lenient = lenientLines(ics.replaceAll('\r\n ', ''));
    expect(lenient.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lenient.filter((l) => l === 'END:VEVENT')).toHaveLength(1);
    expect(lenient.some((l) => /^(URL|X-INJECTED|BEGIN:VALARM|TRIGGER)/.test(l))).toBe(false);
    expect(lenient).toContain(
      'SUMMARY:Lions\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:Game canceled v Tigers',
    );
    expect(lenient).toContain('LOCATION:Pitch 1\\nURL:https://example.test');
    expect(lenient).toContain('DESCRIPTION:game\\nBEGIN:VALARMTRIGGER:-PT5M');
    expect(lenient).toContain('X-WR-CALNAME:Family\\nX-INJECTED:1');
  });

  it('formats UTC date-times with zero padding', () => {
    expect(formatUtc(new Date('2026-01-05T03:04:05Z'))).toBe('20260105T030405Z');
  });
});
