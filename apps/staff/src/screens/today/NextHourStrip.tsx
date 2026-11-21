/**
 * "Starting in the next 60 minutes" (S 1a readiness strip; on a phone, S 1d, the list under the
 * issues): every start in the next hour with its checks (`useStartChecks`). A card with a failed
 * check gets a red top edge; a failed check is a button that opens its fix in the session drawer
 * (assign a referee, the missing forms, the field); a passed one is plain text. Clicking the card
 * opens the drawer (S 3a), and the open card keeps a green outline.
 *
 * Each card reports its checks up (`onChecks`) so the page can count "4 ready" and raise the
 * waivers issue in "Needs action" without reading anything twice.
 */
import type { Schema } from '@sportspark/api-client';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { STATUS_GLYPHS } from '../../ui/StatusBadge';
import {
  hasBlocking,
  isFailed,
  kindLine,
  useStartChecks,
  type FixKind,
  type StartChecks,
} from './start-checks';
import { kindTokenOf } from '../../features/schedule-facilities/sport';
import { shortTime, type ResourceStatus, type ScheduledEvent } from './today-model';

export interface StripContext {
  timeZone: string;
  resources: readonly ResourceStatus[] | undefined;
  sessions: readonly Schema<'FacilitySession'>[] | undefined;
  spaceNames: ReadonlyMap<string, string>;
  /** Roles uncovered per event id, from the Today feed (coverage and uncovered exceptions). */
  uncovered: ReadonlyMap<string, ReadonlySet<string>>;
}

const NONE: ReadonlySet<string> = new Set();

function StripCard({
  event,
  context,
  open,
  onOpen,
  onChecks,
}: {
  event: ScheduledEvent;
  context: StripContext;
  open: boolean;
  onOpen: (event: ScheduledEvent, fix?: FixKind) => void;
  onChecks: (eventId: string, checks: StartChecks) => void;
}) {
  const result = useStartChecks(event, {
    resources: context.resources,
    sessions: context.sessions,
    uncoveredRoles: context.uncovered.get(event.id) ?? NONE,
  });
  const signature = JSON.stringify([result.checks, result.missingWaivers, result.loading]);
  const report = useRef(onChecks);
  report.current = onChecks;
  useEffect(() => {
    report.current(event.id, result);
    // The signature carries every reported value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, signature]);

  const space = event.resourceIds.map((id) => context.spaceNames.get(id)).filter(Boolean)[0];
  const blocked = hasBlocking(result.checks);
  const titleId = `start-${event.id}`;
  return (
    <li
      className="start-card"
      data-blocked={blocked || undefined}
      data-open={open || undefined}
      data-testid={`start-${event.id}`}
    >
      <button
        type="button"
        className="start-card-open"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-checks`}
        onClick={() => onOpen(event)}
      />
      <span className="start-head">
        <span className="start-time">
          {shortTime(event.scheduledStart, context.timeZone, true)}
        </span>
        {space ? <span className="start-space">{space}</span> : null}
      </span>
      <span className="start-title" id={titleId}>
        {event.title}
      </span>
      <span className="start-kind" data-kind={kindTokenOf(event)}>
        <span className="kind-swatch" aria-hidden="true" />
        {kindLine(event)}
      </span>
      <ul
        className="start-checks"
        id={`${titleId}-checks`}
        aria-label={`Checks for ${event.title}`}
      >
        {result.loading ? (
          <li>
            <SkeletonGroup label={`checks for ${event.title}`}>
              <Skeleton width="80%" />
            </SkeletonGroup>
          </li>
        ) : result.checks.length === 0 ? (
          <li className="start-check" data-tone="neutral">
            <span aria-hidden="true">{STATUS_GLYPHS.neutral}</span> No checks needed
          </li>
        ) : (
          result.checks.map((check) => (
            <li key={check.key} className="start-check" data-tone={check.tone}>
              {isFailed(check) && check.fix ? (
                <button
                  type="button"
                  className="start-check-fix"
                  onClick={() => onOpen(event, check.fix)}
                  aria-label={`${check.label}: fix`}
                >
                  <span aria-hidden="true">{STATUS_GLYPHS[check.tone]}</span> {check.label}
                </button>
              ) : (
                <>
                  <span aria-hidden="true">{STATUS_GLYPHS[check.tone]}</span> {check.label}
                </>
              )}
            </li>
          ))
        )}
      </ul>
    </li>
  );
}

export function NextHourStrip({
  starts,
  context,
  readyCount,
  openEventId,
  onOpen,
  onChecks,
  loading,
}: {
  starts: ScheduledEvent[];
  context: StripContext;
  readyCount: number;
  openEventId: string | null;
  onOpen: (event: ScheduledEvent, fix?: FixKind) => void;
  onChecks: (eventId: string, checks: StartChecks) => void;
  loading: boolean;
}) {
  return (
    <section className="card card-flush next-hour" aria-labelledby="next-hour-title">
      <div className="card-head">
        <h3 id="next-hour-title">
          Starting in the next 60 minutes{' '}
          {loading ? null : (
            <span className="next-hour-count">
              {starts.length} {starts.length === 1 ? 'start' : 'starts'} · {readyCount} ready
            </span>
          )}
        </h3>
        <Link to="/schedule" className="next-hour-link">
          Full day →
        </Link>
      </div>
      {loading ? (
        <SkeletonGroup label="the next hour" className="start-strip start-strip-loading">
          {[0, 1, 2, 3, 4].map((i) => (
            <div className="start-card" key={i}>
              <Skeleton width="40%" height={16} />
              <Skeleton width="80%" />
              <Skeleton width="60%" />
            </div>
          ))}
        </SkeletonGroup>
      ) : starts.length === 0 ? (
        <p className="next-hour-empty">Nothing starts in the next hour.</p>
      ) : (
        <ul
          className="start-strip"
          aria-label="Starts in the next hour"
          style={{
            gridTemplateColumns: `repeat(${Math.min(Math.max(starts.length, 1), 5)}, minmax(0, 1fr))`,
          }}
        >
          {starts.map((event) => (
            <StripCard
              key={event.id}
              event={event}
              context={context}
              open={openEventId === event.id}
              onOpen={onOpen}
              onChecks={onChecks}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
