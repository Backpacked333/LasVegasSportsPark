/**
 * The field board (S 1a, S 1d): every space of the facility on the dark night surface, with what
 * is on it now (and how far through), or when it is free until and what is next, a day-long mini
 * timeline with a now-line, closures hatched, a red ring on the slot that needs a person, and the
 * space's status in words (✓ In use, ✓ Ready, ✕ Ref needed, ▲ Restricted). Clicking a block (or the
 * row's "next") opens the session drawer. Reads: the facility's operating status and the day's
 * events (SPK-UX-006 field status); restrictions are written out with their reason, colour is
 * never the only signal (SPK-UX-009).
 *
 * Not built here: dragging a block to move it (INTERACTIONS 1a row 4); moves belong to the
 * schedule screens (S 1b / S 3e, BUILD_PLAN Phase 6).
 */
import { Link } from 'react-router';
import { GlassCard } from '../../ui/glass/GlassCard';
import { SkeletonGroup, Skeleton } from '../../ui/Skeleton';
import { STATUS_GLYPHS, type StatusTone } from '../../ui/StatusBadge';
import {
  axisLabel,
  shortTime,
  span,
  spaceNow,
  type ResourceStatus,
  type ScheduledEvent,
} from './today-model';

const KIND_WORDS: Record<ResourceStatus['kind'], string> = {
  pitch: 'Pitch',
  subdivision: 'Half field',
  room: 'Room',
  other: 'Indoor',
};

export interface BoardProps {
  resources: readonly ResourceStatus[] | undefined;
  events: readonly ScheduledEvent[];
  axis: { start: number; end: number; hours: number[] };
  now: Date;
  timeZone: string;
  /** Events whose start needs a person (an uncovered referee or coach). */
  needsPerson: ReadonlySet<string>;
  onOpen: (event: ScheduledEvent) => void;
  loading: boolean;
  /** Phone (S 1d): only spaces with something to say, no timeline. */
  compact?: boolean;
  error?: { code: string } | null;
  onRetry?: () => void;
}

function rowStatus(
  resource: ResourceStatus,
  now: ReturnType<typeof spaceNow>,
  needsPerson: ReadonlySet<string>,
): { tone: StatusTone; label: string } {
  const closed = resource.restrictions.find((r) => r.kind === 'closed');
  if (closed || resource.status === 'restricted') return { tone: 'warning', label: 'Restricted' };
  const next = now.current ?? now.next;
  if (next && needsPerson.has(next.id)) return { tone: 'danger', label: 'Ref needed' };
  if (now.current) return { tone: 'success', label: 'In use' };
  return { tone: 'success', label: 'Ready' };
}

export function FieldBoard({
  resources,
  events,
  axis,
  now,
  timeZone,
  needsPerson,
  onOpen,
  loading,
  compact = false,
  error,
  onRetry,
}: BoardProps) {
  const nowLeft = span(new Date(axis.start).toISOString(), now.toISOString(), axis);
  const nowPct = nowLeft ? nowLeft.width : null;
  const rows = (resources ?? []).map((resource) => {
    const children = (resources ?? [])
      .filter((r) => r.parentResourceId === resource.resourceId)
      .map((r) => r.resourceId);
    const state = spaceNow(resource, events, now, children);
    return { resource, state, status: rowStatus(resource, state, needsPerson) };
  });
  const shown = compact
    ? rows.filter((r) => r.state.current || r.status.tone !== 'success').slice(0, 4)
    : rows;

  return (
    <GlassCard tone="night" className="card-flush field-board" aria-labelledby="field-board-title">
      <div className="card-head">
        <span className="field-board-title">
          <h3 id="field-board-title">Field board</h3>
          <span className="live-chip" aria-hidden="true">
            <span className="live-dot" />
            Live
          </span>
        </span>
        {compact ? null : (
          <span className="board-legend" aria-hidden="true">
            <span>
              <i data-legend="now" />
              Now
            </span>
            <span>
              <i data-legend="booked" />
              Booked
            </span>
            <span>
              <i data-legend="closed" />
              Closed
            </span>
          </span>
        )}
      </div>
      {loading ? (
        <SkeletonGroup label="the field board" className="board-loading">
          {[0, 1, 2, 3].map((i) => (
            <div className="board-row" key={i}>
              <Skeleton width={70} height={16} />
              <Skeleton width="60%" />
            </div>
          ))}
        </SkeletonGroup>
      ) : error ? (
        <p className="board-error">
          The field board could not be loaded (code {error.code}).{' '}
          {onRetry ? (
            <button type="button" className="link-button" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </p>
      ) : rows.length === 0 ? (
        <p className="board-error">No fields or spaces are recorded for this facility.</p>
      ) : (
        <>
          {compact ? null : (
            <div className="board-head" aria-hidden="true">
              <span>Space</span>
              <span>Now</span>
              <span className="board-axis">
                {axis.hours.map((h, i) => (
                  <span key={h}>{axisLabel(h, timeZone, i === axis.hours.length - 1)}</span>
                ))}
              </span>
              <span>Status</span>
            </div>
          )}
          <ul className="board" aria-label="Field board" data-compact={compact || undefined}>
            {shown.map(({ resource, state, status }) => {
              const closed =
                resource.restrictions.find((r) => r.kind === 'closed') ?? resource.restrictions[0];
              return (
                <li
                  key={resource.resourceId}
                  data-restricted={closed ? true : undefined}
                  data-alert={status.tone === 'danger' || undefined}
                  data-testid={`board-${resource.resourceId}`}
                >
                  <span className="board-space">
                    <span className="board-space-name">{resource.name}</span>
                    {compact ? null : (
                      <span className="board-space-kind">{KIND_WORDS[resource.kind]}</span>
                    )}
                  </span>
                  <span className="board-now">
                    {closed ? (
                      <>
                        <span className="board-closed">
                          {closed.kind === 'closed' ? 'Closed' : 'Restricted'}: {closed.reason}
                        </span>
                        <span className="board-next">
                          Back by <b>{shortTime(closed.interval.end, timeZone)}</b>
                        </span>
                      </>
                    ) : state.current ? (
                      <>
                        <span className="board-now-title">
                          {state.current.title}
                          {compact && state.minutesLeft !== null
                            ? ` · ${state.minutesLeft} min left`
                            : ''}
                        </span>
                        <span className="board-progress">
                          <span
                            className="board-bar"
                            role="progressbar"
                            aria-label={`${state.current.title} progress`}
                            aria-valuenow={state.progress ?? 0}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          >
                            <span style={{ width: `${state.progress ?? 0}%` }} />
                          </span>
                          {compact ? null : (
                            <span className="board-left">{state.minutesLeft} min left</span>
                          )}
                        </span>
                      </>
                    ) : state.next ? (
                      <>
                        <span className="board-free">
                          Free until {shortTime(state.next.scheduledStart, timeZone, true)}
                          {compact ? ` · next ${state.next.title}` : ''}
                        </span>
                        {compact ? null : (
                          <span className="board-next">
                            Next{' '}
                            <button
                              type="button"
                              className="board-next-link"
                              onClick={() => onOpen(state.next!)}
                            >
                              {state.next.title}
                            </button>
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="board-free">Free for the rest of the day</span>
                    )}
                  </span>
                  {compact ? null : (
                    <span className="board-line" aria-hidden="true">
                      {resource.restrictions.map((r) => {
                        const pos = span(r.interval.start, r.interval.end, axis);
                        return pos ? (
                          <i
                            key={r.restrictionId}
                            className="board-block"
                            data-closed
                            style={{ left: `${pos.left}%`, width: `${pos.width}%` }}
                          />
                        ) : null;
                      })}
                      {state.day.map((e) => {
                        const pos = span(e.scheduledStart, e.scheduledEnd, axis);
                        if (!pos) return null;
                        const live = e === state.current;
                        return (
                          <i
                            key={e.id}
                            className="board-block"
                            data-now={live || undefined}
                            data-ring={needsPerson.has(e.id) || undefined}
                            style={{ left: `${pos.left}%`, width: `${pos.width}%` }}
                            onClick={() => onOpen(e)}
                          />
                        );
                      })}
                      {nowPct !== null ? (
                        <i className="board-nowline" style={{ left: `${nowPct}%` }} />
                      ) : null}
                    </span>
                  )}
                  <span className="board-status" data-tone={status.tone}>
                    <span aria-hidden="true">{STATUS_GLYPHS[status.tone]}</span> {status.label}
                  </span>
                </li>
              );
            })}
          </ul>
          {compact ? (
            <Link className="board-more" to="/schedule">
              Open schedule →
            </Link>
          ) : null}
        </>
      )}
    </GlassCard>
  );
}
