/**
 * Shared pieces of the Phase 8 staff screens (staff redesign "specified, not yet drawn"): the
 * night header band of the phone screens (S 2d, S 3g, S 4d, S 5c) and the purple "Proposed" tag
 * for anything that waits on a product or API decision (handoff "Open decisions", §6.7).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from '../../ui/Icon';
import './crew.css';

export function CrewHero({
  kicker,
  title,
  titleId,
  back,
  aside,
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  titleId: string;
  back?: { to: string; label: string };
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="crew-hero">
      {back ? (
        <Link className="crew-back" to={back.to}>
          <Icon name="arrow_back" size={20} />
          {back.label}
        </Link>
      ) : null}
      <div className="crew-hero-top">
        <div>
          {kicker ? <p className="crew-kicker">{kicker}</p> : null}
          <h2 id={titleId}>{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </header>
  );
}

/** "◷ Proposed": waits on an open decision; `id` lets a disabled control describe itself by it. */
export function ProposedTag({ id, label = 'Proposed' }: { id?: string; label?: string }) {
  return (
    <span className="crew-proposed" id={id}>
      <span aria-hidden="true">◷</span> {label}
    </span>
  );
}

/** "In 1 h 15 min", "Now · 12 min in", "Ended": the countdown pill of a start. */
export function countdownText(startIso: string, endIso: string, now: Date): string {
  const t = now.getTime();
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (t >= end) return 'Ended';
  if (t >= start) return `Now · ${Math.max(0, Math.floor((t - start) / 60_000))} min in`;
  const minutes = Math.ceil((start - t) / 60_000);
  if (minutes < 60) return `In ${minutes} min`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `In ${h} h${m > 0 ? ` ${m} min` : ''}`;
  }
  const days = Math.round(minutes / (24 * 60));
  return `In ${days} day${days === 1 ? '' : 's'}`;
}

/** "10:30" in the facility's zone (SPK-SCHED-008). */
export function clockOf(iso: string, timeZone?: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** "Sat, Nov 21" in the facility's zone. */
export function dayLabelOf(iso: string | Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(typeof iso === 'string' ? new Date(iso) : iso);
}

/** The facility-local calendar date `YYYY-MM-DD` of an instant. */
export function localDayOf(at: string | Date, timeZone?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(typeof at === 'string' ? new Date(at) : at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
