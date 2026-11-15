/**
 * The frame of every page that needs no sign-in (SPK-SCHED-010, proposed amendment PA-06): the
 * organization's name, the page's title, when the answer shown was last updated, and the states a
 * visitor can meet: loading, "not available" (the one answer of a view that does not exist, is not
 * public or was turned off), too many reads, and showing the last answer received while the
 * connection is down. Nothing here reads the session: these routes are outside the session guard.
 */
import type { ReactNode } from 'react';
import { Glass } from '../../ui/glass/Glass';
import type { PublicViewState } from './usePublicView';
import './public.css';

/** A time of day in the facility's zone, e.g. "7:00 PM". */
export function formatPublicTime(iso: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** A day and time in the facility's zone, e.g. "Mon, Nov 16, 7:00 PM". */
export function formatPublicDayTime(iso: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** A calendar date (YYYY-MM-DD) in words, e.g. "Saturday, November 21, 2026". */
export function formatPublicDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function LastUpdated({
  computedAt,
  timezone,
  stale,
}: {
  computedAt: string;
  timezone: string | null;
  stale: boolean;
}) {
  return (
    <p className="public-updated" role="status" data-stale={stale ? 'true' : 'false'}>
      Last updated {formatPublicDayTime(computedAt, timezone)}
      {stale ? '. No connection: showing the last schedule received.' : ''}
    </p>
  );
}

export function PublicFrame<T extends { computedAt: string }>({
  view,
  organizationName,
  title,
  subtitle,
  timezone = null,
  nav,
  variant = 'page',
  children,
}: {
  view: PublicViewState<T>;
  organizationName: (data: T) => string;
  title: (data: T) => string;
  subtitle?: (data: T) => string | null;
  timezone?: ((data: T) => string | null) | null;
  nav?: ReactNode;
  /** `lobby` is the wall display: larger type, no navigation. */
  variant?: 'page' | 'lobby';
  children: (data: T) => ReactNode;
}) {
  const data = view.data;
  if (data === undefined) {
    return (
      <main className="public-page" data-variant={variant}>
        <div className="public-state" role="status">
          {view.loading ? (
            <p>Loading…</p>
          ) : view.notAvailable ? (
            <>
              <h1>Not available</h1>
              <p>This page is not public, or its link is no longer in use.</p>
            </>
          ) : view.rateLimited ? (
            <>
              <h1>Please wait a moment</h1>
              <p>Too many requests from this network. This page tries again by itself.</p>
            </>
          ) : (
            <>
              <h1>Could not be loaded</h1>
              <p>This page tries again by itself.</p>
            </>
          )}
        </div>
      </main>
    );
  }
  const zone = timezone ? timezone(data) : null;
  const sub = subtitle ? subtitle(data) : null;
  return (
    <main className="public-page" data-variant={variant}>
      {/* The one glass body of a public page: the header floats on the backdrop; the tables under
          it are solid, because they are read from a distance (ADR-001). */}
      <Glass
        as="header"
        radius={variant === 'lobby' ? 32 : 24}
        squircle
        material="frost"
        className="public-header"
        contentClassName="public-header-inner"
      >
        <div className="public-header-text">
          <p className="public-organization">{organizationName(data)}</p>
          <h1>{title(data)}</h1>
          {sub ? <p className="public-subtitle">{sub}</p> : null}
        </div>
        <LastUpdated computedAt={data.computedAt} timezone={zone} stale={view.stale} />
      </Glass>
      {nav}
      {children(data)}
    </main>
  );
}
