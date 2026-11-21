/**
 * Pure figures of the manager's week (staff S 4e; SPK-REPORT-001 metric definitions, SPK-REPORT-004
 * "sales, not recognized revenue", SPK-PAY-011): periods in the facility's local dates, the
 * previous period of equal length to compare with, sales grouped into the chart's three series,
 * and the plain-words reason under each number.
 */
import type { Schema } from '@sportspark/api-client';

type ReportResponse = Schema<'ReportResponse'>;

export type Range = 'week' | 'month' | 'season';

export interface Period {
  from: string;
  to: string;
  /** Chart buckets: days for a week, weeks for a month or a season. */
  buckets: Array<{ from: string; to: string; label: string; short: string }>;
}

const DAY = 86_400_000;

function parse(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return iso(parse(date) + days * DAY);
}

/** Monday of the local date's week. */
export function mondayOf(date: string): string {
  const weekday = new Date(parse(date)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** "Nov 16–22" or "Nov 30–Dec 6". */
export function rangeLabel(from: string, to: string): string {
  const a = MONTH_DAY.format(new Date(parse(from)));
  const b = MONTH_DAY.format(new Date(parse(to)));
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth ? `${a}–${b.split(' ')[1]}` : `${a}–${b}`;
}

/** The period containing `today` (local date) and its chart buckets. */
export function periodOf(range: Range, today: string): Period {
  if (range === 'week') {
    const from = mondayOf(today);
    const buckets = Array.from({ length: 7 }, (_, i) => {
      const day = addDays(from, i);
      return {
        from: day,
        to: day,
        label: WEEKDAY.format(new Date(parse(day))),
        short: WEEKDAY.format(new Date(parse(day))),
      };
    });
    return { from, to: addDays(from, 6), buckets };
  }
  const weeks = range === 'month' ? 5 : 13;
  const lastMonday = mondayOf(today);
  const from = addDays(lastMonday, -(weeks - 1) * 7);
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const start = addDays(from, i * 7);
    return {
      from: start,
      to: addDays(start, 6),
      label: `Week of ${MONTH_DAY.format(new Date(parse(start)))}`,
      short: MONTH_DAY.format(new Date(parse(start))),
    };
  });
  return { from, to: addDays(lastMonday, 6), buckets };
}

/** The period just before, of the same length. */
export function previousOf(period: Pick<Period, 'from' | 'to'>): { from: string; to: string } {
  const days = Math.round((parse(period.to) - parse(period.from)) / DAY) + 1;
  return { from: addDays(period.from, -days), to: addDays(period.from, -1) };
}

export type Series = 'programs' | 'rentals' | 'desk';

export const SERIES: ReadonlyArray<{ key: Series; label: string }> = [
  { key: 'programs', label: 'Programs' },
  { key: 'rentals', label: 'Rentals' },
  { key: 'desk', label: 'Desk sales' },
];

const RENTAL_LINES = new Set(['rental', 'party']);

/** The chart series of one sales line (registration offering kind, or point of sale). */
export function seriesOf(source: string, productLine: string): Series {
  if (source.startsWith('point_of_sale')) return 'desk';
  return RENTAL_LINES.has(productLine) ? 'rentals' : 'programs';
}

export interface SalesTotals {
  total: number;
  bySeries: Record<Series, number>;
  byLine: Map<string, number>;
  currency: string | null;
}

/** Sales of a period in one currency (MET-109 values; never mixed across currencies, G5). */
export function salesOf(report: ReportResponse | undefined): SalesTotals {
  const out: SalesTotals = {
    total: 0,
    bySeries: { programs: 0, rentals: 0, desk: 0 },
    byLine: new Map(),
    currency: null,
  };
  for (const v of report?.values ?? []) {
    if (v.metric !== 'MET-109' || v.value === null) continue;
    if (out.currency && v.currency && v.currency !== out.currency) continue;
    out.currency = out.currency ?? v.currency;
    const source = v.dimensions['source'] ?? 'registration';
    const line = v.dimensions['productLine'] ?? 'other';
    out.total += v.value;
    out.bySeries[seriesOf(source, line)] += v.value;
    const key = source.startsWith('point_of_sale') ? 'desk' : line;
    out.byLine.set(key, (out.byLine.get(key) ?? 0) + v.value);
  }
  return out;
}

const LINE_WORDS: Record<string, string> = {
  term: 'class sign-ups',
  camp: 'camp sign-ups',
  league: 'league fees',
  rental: 'rentals',
  party: 'parties',
  membership: 'memberships',
  package: 'class packs',
  desk: 'desk sales',
};

export function lineWords(line: string): string {
  return LINE_WORDS[line] ?? line.replace(/_/g, ' ');
}

/** "camp sign-ups": the line whose sales moved most, in the direction of the total. */
export function salesReason(now: SalesTotals, before: SalesTotals): string | null {
  const lines = new Set([...now.byLine.keys(), ...before.byLine.keys()]);
  const rising = now.total >= before.total;
  let best: { line: string; delta: number } | null = null;
  for (const line of lines) {
    const delta = (now.byLine.get(line) ?? 0) - (before.byLine.get(line) ?? 0);
    if ((rising && delta <= 0) || (!rising && delta >= 0)) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { line, delta };
  }
  return best ? lineWords(best.line) : null;
}

/** A value of a report by metric (and optional dimension match); null when unavailable. */
export function metric(
  report: ReportResponse | undefined,
  key: string,
  dims: Record<string, string> = {},
): number | null {
  const found = report?.values.find(
    (v) =>
      v.metric === key &&
      Object.entries(dims).every(([k, val]) => v.dimensions[k] === val) &&
      (Object.keys(dims).length > 0 || Object.keys(v.dimensions).length === 0),
  );
  return found?.value ?? null;
}

/** No-shows: observed absences over attended plus absent (null when nothing was captured). */
export function noShowRate(report: ReportResponse | undefined): number | null {
  const attended = report?.values.find(
    (v) => v.metric === 'MET-007' && v.label === 'Attended',
  )?.value;
  const absent = report?.values.find(
    (v) => v.metric === 'MET-007' && v.label === 'Observed absent',
  )?.value;
  if (attended === null || attended === undefined || absent === null || absent === undefined) {
    return null;
  }
  const seen = attended + absent;
  return seen > 0 ? absent / seen : null;
}

/** The activity with the most absences (the reason under no-shows). */
export function mostAbsent(report: ReportResponse | undefined): string | null {
  let best: { title: string; absent: number } | null = null;
  for (const row of report?.rows ?? []) {
    const absent = typeof row['absent'] === 'number' ? row['absent'] : 0;
    const title = typeof row['title'] === 'string' ? row['title'] : null;
    if (title && absent > 0 && (!best || absent > best.absent)) best = { title, absent };
  }
  return best ? best.title.replace(/\s*#\d+$/, '') : null;
}

/** "Field 4 closed 16 h" from the utilization rows' closure hours. */
export function closureReason(report: ReportResponse | undefined): string | null {
  let best: { name: string; hours: number } | null = null;
  for (const row of report?.rows ?? []) {
    const hours = typeof row['closureUnitHours'] === 'number' ? row['closureUnitHours'] : 0;
    const name = typeof row['resource'] === 'string' ? row['resource'] : null;
    if (name && hours > 0 && row['parentResourceId'] === null && (!best || hours > best.hours)) {
      best = { name, hours };
    }
  }
  if (!best) return null;
  const days = Math.round(best.hours / 8);
  return `${best.name} closed ${days >= 1 ? `${days} ${days === 1 ? 'day' : 'days'}` : `${Math.round(best.hours)} h`}`;
}

/** "$18,420" from minor units. */
export function moneyText(minor: number, currency: string | null): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
    maximumFractionDigits: 0,
  }).format(minor / 100);
}

/** A change for the caption: { glyph, text, tone }. */
export function change(
  now: number | null,
  before: number | null,
  unit: 'percent_change' | 'points',
  higherIsBetter = true,
): { glyph: string; text: string; tone: 'success' | 'danger' | 'neutral' } | null {
  if (now === null || before === null) return null;
  const delta =
    unit === 'points'
      ? (now - before) * 100
      : before === 0
        ? null
        : ((now - before) / before) * 100;
  if (delta === null) return null;
  if (Math.abs(delta) < (unit === 'points' ? 0.5 : 1)) {
    return { glyph: '●', text: 'Flat', tone: 'neutral' };
  }
  const up = delta > 0;
  const good = up === higherIsBetter;
  const amount =
    unit === 'points' ? `${Math.abs(delta).toFixed(1)} pts` : `${Math.round(Math.abs(delta))}%`;
  return { glyph: up ? '▲' : '▼', text: amount, tone: good ? 'success' : 'danger' };
}
