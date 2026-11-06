/**
 * Page frame of the Compete screens (SPK-UX-010 redesign): eyebrow, condensed title with the
 * screen's own heading id (accessible names do not change), intro, fact chips and actions. Plus
 * the season progress the competition cards and the season home derive from the season's own dates
 * (`startsOn`, `endsOn`); nothing is invented when the dates say nothing.
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../ui/Icon';

export function CompeteHeader({
  eyebrow,
  title,
  titleId,
  titleClassName,
  intro,
  chips,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  titleId: string;
  titleClassName?: string;
  intro?: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="compete-head">
      <div className="compete-head-text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2 id={titleId} className={titleClassName}>
          {title}
        </h2>
        {chips ? <div className="chips">{chips}</div> : null}
        {intro ? <p>{intro}</p> : null}
      </div>
      {actions ? <div className="actions-row">{actions}</div> : null}
    </div>
  );
}

export function Chip({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return (
    <span className="chip">
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}

const DAY_MS = 86_400_000;

/** Parses a `YYYY-MM-DD` date as a UTC day (calendar dates only, no time zone involved). */
function dayOf(date: string): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : null;
}

export interface SeasonProgress {
  /** 0 to 100. */
  pct: number;
  /** "Week 3 of 10", "Starts in 5 days", "Finished". */
  label: string;
}

/**
 * Where today falls between a season's first and last day, from the season's own dates. `today`
 * is the viewer's calendar date (`YYYY-MM-DD`).
 */
export function seasonProgress(
  season: { startsOn: string; endsOn: string },
  today: string,
): SeasonProgress | null {
  const start = dayOf(season.startsOn);
  const end = dayOf(season.endsOn);
  const now = dayOf(today);
  if (start === null || end === null || now === null || end < start) return null;
  const weeks = Math.max(1, Math.ceil((end - start + 1) / 7));
  if (now < start) {
    const days = start - now;
    return { pct: 0, label: days === 1 ? 'Starts tomorrow' : `Starts in ${days} days` };
  }
  if (now > end) return { pct: 100, label: 'Finished' };
  const week = Math.min(weeks, Math.floor((now - start) / 7) + 1);
  return {
    pct: Math.round(((now - start + 1) / (end - start + 1)) * 100),
    label: `Week ${week} of ${weeks}`,
  };
}

/** The viewer's calendar date as `YYYY-MM-DD` (device zone; the season dates have none). */
export function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
