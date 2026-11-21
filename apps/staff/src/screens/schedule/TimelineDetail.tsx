/**
 * SCR-S-03 detail rail beside the resource timeline, as the redesign draws it (handoff S 1b;
 * SPK-SCHED-003, SPK-SCHED-005, SPK-SCHED-006, SPK-READY-001, SPK-UX-009):
 *
 * - A booked block: its kind line, title, facility-local time and spaces, then its readiness checks
 *   as rows (Referee, Rosters, Coach, Forms, Field, Paid…) composed from the reads Today uses
 *   (`useStartChecks`), with the fix of the first failed check as the primary action (Assign referee
 *   offers the ranked candidates in place; missing forms are named; a closed field opens its
 *   restriction; an unpaid booking opens it). Move (the keyboard path of a drag: new times, checked
 *   and published at once) and Message sit under it. A rental or party also says who booked it and
 *   links to the booking (INTERACTIONS 1b row 3: the booking drawer).
 * - A draft block (an unpublished event or a change in an open draft): Publish or Delete
 *   (INTERACTIONS 1b row 6). Publish publishes its draft (`POST /v1/schedule-drafts/{id}/publish`,
 *   every publication check; an unpublished event outside a draft is put in a one-change draft
 *   first); Delete discards a one-change draft, or saves the draft without that change.
 * - A closure: its reason, time, status and the way to its impact or release.
 * - Nothing selected: the day at a glance, from the data loaded; it never invents counts.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { asApiError, useIntentSend } from '../../api/useIntentSend';
import { namesOf, resourceNames } from '../../features/schedule-facilities/inventory';
import { CLOSURE_BADGE, EVENT_KIND_LABEL } from '../../features/schedule-facilities/labels';
import { useActionAllowed } from '../../features/schedule-facilities/permission';
import { sportLabel } from '../../features/schedule-facilities/sport';
import { formatRange, localTimeOf } from '../../features/schedule-facilities/time';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { SkeletonGroup, SkeletonLines } from '../../ui/Skeleton';
import { STATUS_GLYPHS, StatusBadge } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import { RefereeFix, type RefereeTarget } from '../today/RefereeFix';
import { isFailed, kindLine, useStartChecks, type StartCheck } from '../today/start-checks';
import { DirectChange, EventFacts, MessageAttendees } from './EventDetailExtras';
import { KIND_PATH, OUTSTANDING } from '../package-g/bookings/labels';
import { KIND_GROUPS, shortClock, type TimelineBlock } from './schedule-model';
import type { Selection } from './ResourceTimeline';
import { SCHEDULE_INVALIDATE } from './useScheduleMove';

type Resource = Schema<'Resource'>;
type Event = Schema<'Event'>;
type Closure = Schema<'Closure'>;
type ResourceStatus = Schema<'ResourceOperatingStatus'>;

const CLOSURE_SOURCE: Record<Closure['source'], string> = {
  manual: 'Closure',
  maintenance: 'Maintenance restriction',
  holiday: 'Holiday closure',
};

const TIP =
  "Tip: drag a block to another space or time. Every move is checked for conflicts before it's published.";

function timeLine(block: TimelineBlock, tz: string, spaces: string): string {
  const start = localTimeOf(block.start, tz);
  const end = localTimeOf(block.end, tz);
  return `${start}–${end}${spaces ? ` · ${spaces}` : ''}`;
}

function CheckRows({ checks }: { checks: readonly StartCheck[] }) {
  return (
    <ul className="tl-checks" aria-label="Readiness checks">
      {checks.map((c) => (
        <li key={c.key} data-tone={c.tone}>
          <span>{c.heading}</span>
          <b>
            <span aria-hidden="true">{STATUS_GLYPHS[c.tone]}</span> {c.value}
          </b>
        </li>
      ))}
    </ul>
  );
}

/** The fix of the first failed check, as the rail's primary action. */
function PrimaryFix({
  event,
  check,
  target,
  bookingId,
  missing,
  timeZone,
}: {
  event: Event;
  check: StartCheck | undefined;
  target: RefereeTarget | null;
  bookingId: string | null;
  missing: readonly string[];
  timeZone: string;
}) {
  const [open, setOpen] = useState(false);
  if (!check) {
    return (
      <Link
        className="button button-primary tl-primary"
        to={`/arrival?type=event&eventId=${event.id}`}
      >
        <Icon name="qr_code_scanner" size={18} />
        Open check-in
      </Link>
    );
  }
  if ((check.key === 'referee' || check.key === 'coach') && target) {
    return (
      <>
        <Button className="tl-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Assign {target.role.replaceAll('_', ' ')}
        </Button>
        {open ? (
          <div className="tl-fix" data-tone="danger">
            <b>Best matches</b>
            <RefereeFix target={target} timeZone={timeZone} />
          </div>
        ) : null}
      </>
    );
  }
  if (check.fix === 'waivers' || check.fix === 'forms') {
    return (
      <>
        <Button className="tl-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          See missing forms
        </Button>
        {open ? (
          <div className="tl-fix" data-tone="warning">
            <b>{check.label}</b>
            <span>
              {missing.length > 0
                ? `${missing.join(', ')}. Parents can sign at the desk tablet on arrival.`
                : 'The missing forms are listed at check-in.'}
            </span>
          </div>
        ) : null}
      </>
    );
  }
  if (check.fix === 'field') {
    return (
      <Link className="button button-primary tl-primary" to="/facilities/restrictions">
        Open restrictions
      </Link>
    );
  }
  if (check.fix === 'payment' && bookingId) {
    return (
      <Link
        className="button button-primary tl-primary"
        to={`${KIND_PATH[event.kind === 'party' ? 'party' : 'rental']}/${bookingId}`}
      >
        Take payment on the booking
      </Link>
    );
  }
  return (
    <Link
      className="button button-primary tl-primary"
      to={`/arrival?type=event&eventId=${event.id}`}
    >
      Open check-in
    </Link>
  );
}

function BookingFacts({ bookingId }: { bookingId: string }) {
  const booking = useApiQuery({ path: '/bookings/{id}', request: { path: { id: bookingId } } });
  const b = booking.data;
  if (!b) return null;
  return (
    <dl className="tl-facts tl-extras" aria-label="Booking">
      <dt>Booking</dt>
      <dd>
        {b.offeringName ?? 'Booking'} · {b.status.replaceAll('_', ' ')}
      </dd>
      {b.outstanding.length > 0 ? (
        <>
          <dt>Still to do</dt>
          <dd>{b.outstanding.map((o) => OUTSTANDING[o]).join(', ')}</dd>
        </>
      ) : null}
      {b.guestCount ? (
        <>
          <dt>Guests</dt>
          <dd>{b.guestCount}</dd>
        </>
      ) : null}
      <dt />
      <dd>
        <Link to={`${KIND_PATH[b.kind]}/${b.id}`}>Open the booking →</Link>
      </dd>
    </dl>
  );
}

function EventDetail({
  block,
  event,
  resources,
  operating,
  timezone,
  moveTip,
}: {
  block: TimelineBlock;
  event: Event;
  resources: readonly Resource[];
  operating: readonly ResourceStatus[] | undefined;
  timezone: string;
  moveTip: string | null;
}) {
  const [moving, setMoving] = useState(false);
  const result = useStartChecks(event, {
    resources: operating,
    sessions: undefined,
    uncoveredRoles: new Set(),
  });
  const spaces = namesOf(event.resourceIds, resourceNames([...resources]));
  const failed = result.checks.filter(isFailed);
  const referee = result.checks.find(
    (c) => (c.key === 'referee' || c.key === 'coach') && isFailed(c),
  );
  const target: RefereeTarget | null =
    referee && result.fixtureId && result.requirementId
      ? {
          targetType: 'fixture',
          targetId: result.fixtureId,
          kind: 'official',
          role: 'referee',
          requirementId: result.requirementId,
          title: event.title,
        }
      : null;
  const group = KIND_GROUPS.find((g) => g.id === block.group);
  return (
    <>
      <div className="tl-detail-head" data-kind={block.token}>
        <span className="tl-detail-kind">
          <span className="kind-swatch" aria-hidden="true" />
          {group?.label ?? EVENT_KIND_LABEL[event.kind]} · {kindLine(event)}
          {event.sport && event.kind !== 'party' ? ` · ${sportLabel(event.sport)}` : ''}
        </span>
        <h4 className="tl-detail-title">{event.title}</h4>
        <span className="caption">{timeLine(block, timezone, spaces)}</span>
      </div>
      {event.status === 'canceled' ? (
        <p className="tl-detail-alert tone-neutral">
          ✕ Canceled{event.cancelReason ? `: ${event.cancelReason}` : ''}
        </p>
      ) : null}
      {result.loading ? (
        <SkeletonGroup label="readiness checks">
          <SkeletonLines lines={3} />
        </SkeletonGroup>
      ) : result.checks.length > 0 ? (
        <CheckRows checks={[...failed, ...result.checks.filter((c) => !isFailed(c))]} />
      ) : null}
      {event.status === 'published' ? (
        <div className="tl-detail-actions tl-rail-actions">
          <PrimaryFix
            event={event}
            check={failed[0]}
            target={target}
            bookingId={result.bookingId}
            missing={result.missingWaivers.map((m) => m.name)}
            timeZone={timezone}
          />
          <div className="tl-rail-pair">
            <Button variant="secondary" aria-expanded={moving} onClick={() => setMoving((v) => !v)}>
              Move
            </Button>
            <MessageAttendees event={event} />
          </div>
        </div>
      ) : null}
      {moving ? (
        moveTip ? (
          <p className="caption" role="status">
            {moveTip}
          </p>
        ) : (
          <DirectChange
            key={`${event.id}:${event.revision}`}
            event={event}
            timezone={timezone}
            startOpen
          />
        )
      ) : null}
      {result.bookingId ? <BookingFacts bookingId={result.bookingId} /> : null}
      <EventFacts event={event} />
      <p className="caption tl-tip">{moveTip ?? TIP}</p>
    </>
  );
}

/** Publish or Delete a draft block (INTERACTIONS 1b row 6). */
function DraftDetail({
  block,
  resources,
  timezone,
  facilityId,
  onDone,
}: {
  block: TimelineBlock;
  resources: readonly Resource[];
  timezone: string;
  facilityId: string;
  onDone: () => void;
}) {
  const { online } = useApp();
  const toast = useToast();
  const mayDraft = useActionAllowed('scheduling.manage_drafts', facilityId);
  const mayPublish = useActionAllowed('scheduling.publish_schedule', facilityId);
  const { send } = useIntentSend(SCHEDULE_INVALIDATE);
  const [busy, setBusy] = useState<'publish' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = block.draft;
  const spaces = namesOf([...block.resourceIds], resourceNames([...resources]));
  const isGhost = block.type === 'draft-change';
  const others = draft ? draft.changeCount - 1 : 0;

  const publish = async () => {
    setBusy('publish');
    setError(null);
    try {
      let draftId = draft?.id;
      if (!draftId && block.event) {
        const created = await send(
          `publish-event:${block.event.id}`,
          'post',
          '/schedule-drafts',
          {
            body: {
              facilityId,
              name: `Publish: ${block.title}`.slice(0, 200),
              changes: [{ kind: 'create', targetEventId: block.event.id }],
            },
          },
          { refresh: false },
        );
        draftId = created.id;
      }
      if (!draftId) return;
      await send(`publish:${draftId}`, 'post', '/schedule-drafts/{id}/publish', {
        path: { id: draftId },
        body: {},
      });
      toast.show({ tone: 'success', message: `${block.title} is published.` });
      onDone();
    } catch (cause) {
      setError(asApiError(cause).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!draft) return;
    setBusy('delete');
    setError(null);
    try {
      if (draft.changeCount <= 1) {
        await send(`discard:${draft.id}`, 'post', '/schedule-drafts/{id}/discard', {
          path: { id: draft.id },
          body: { expectedRevision: draft.revision },
        });
      } else {
        const rest = draft.changes
          .filter((c) => c.sequence !== draft.sequence)
          .map((c) => ({
            kind: c.kind,
            ...(c.targetEventId ? { targetEventId: c.targetEventId } : {}),
            proposed: c.proposed,
            resourceIds: c.resourceIds,
          }));
        await send(`autosave:${draft.id}:${draft.sequence}`, 'patch', '/schedule-drafts/{id}', {
          path: { id: draft.id },
          body: { changes: rest, expectedRevision: draft.revision },
        });
      }
      toast.show({ tone: 'success', message: `${block.title} was taken out of the draft.` });
      onDone();
    } catch (cause) {
      setError(asApiError(cause).message);
    } finally {
      setBusy(null);
    }
  };
  const allowed = mayDraft && mayPublish;
  return (
    <>
      <div className="tl-detail-head" data-kind={block.token} data-draft>
        <span className="tl-detail-kind tone-pending">
          ◷ {isGhost ? 'Draft change' : 'Draft'} · {EVENT_KIND_LABEL[block.kind]}
        </span>
        <h4 className="tl-detail-title">{block.title}</h4>
        <span className="caption">{timeLine(block, timezone, spaces)}</span>
      </div>
      <p className="tl-detail-alert tone-pending">
        ◷ Not published: customers do not see this yet
        {isGhost && block.event
          ? `. Now ${localTimeOf(block.event.scheduledStart, timezone)}–${localTimeOf(block.event.scheduledEnd, timezone)}.`
          : '.'}
      </p>
      {draft ? (
        <p className="caption">
          In the draft “{draft.name}”
          {others > 0
            ? `, with ${others} other change${others === 1 ? '' : 's'}: Publish publishes them together.`
            : '.'}
        </p>
      ) : null}
      {allowed ? (
        <div className="tl-detail-actions tl-rail-actions">
          <Button
            className="tl-primary"
            busy={busy === 'publish'}
            disabled={!online || busy !== null}
            onClick={() => void publish()}
          >
            {isGhost ? 'Publish and notify' : 'Publish'}
          </Button>
          {draft ? (
            <Button
              variant="secondary"
              className="button-danger-outline"
              busy={busy === 'delete'}
              disabled={!online || busy !== null}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          ) : (
            <p className="caption">An unpublished event is removed where it was planned.</p>
          )}
          {!online ? <p className="caption">Publishing needs a connection.</p> : null}
        </div>
      ) : (
        <p className="caption">
          Publishing needs a scheduler or a manager who publishes the schedule.
        </p>
      )}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {draft ? (
        <Link className="tl-clear" to={`/schedule/drafts/${draft.id}`}>
          Open the draft →
        </Link>
      ) : null}
    </>
  );
}

function ClosureDetail({
  closure,
  resources,
  timezone,
}: {
  closure: Closure;
  resources: readonly Resource[];
  timezone: string;
}) {
  const badge = CLOSURE_BADGE[closure.status];
  const where =
    closure.resourceId === null
      ? 'Whole facility'
      : namesOf([closure.resourceId], resourceNames([...resources]));
  const unresolved = closure.resolution?.unresolvedEventIds.length ?? 0;
  return (
    <>
      <div className="tl-detail-head" data-closure>
        <span className="tl-detail-kind tone-warning">▲ {CLOSURE_SOURCE[closure.source]}</span>
        <h4 className="tl-detail-title">{closure.reason}</h4>
        <span className="caption">
          {formatRange(closure.interval.start, closure.interval.end, timezone)} · {where}
        </span>
      </div>
      {unresolved > 0 ? (
        <p className="tl-detail-alert tone-danger">
          ✕ {unresolved} affected event{unresolved === 1 ? '' : 's'} still need
          {unresolved === 1 ? 's' : ''} a resolution
        </p>
      ) : null}
      <dl className="tl-facts">
        <dt>Status</dt>
        <dd>
          <StatusBadge tone={badge.tone} label={badge.label} />
        </dd>
        <dt>Affected</dt>
        <dd>
          {closure.impact
            ? `${closure.impact.affectedEvents.length} event(s) in the interval`
            : 'Impact not evaluated yet'}
        </dd>
      </dl>
      <div className="tl-detail-actions tl-rail-actions">
        <Link className="button button-primary tl-primary" to={`/schedule/closures/${closure.id}`}>
          Review closure impact
        </Link>
        {closure.source === 'maintenance' ? (
          <Link className="button button-secondary" to="/facilities/restrictions">
            <Icon name="construction" size={17} />
            Release on Facilities
          </Link>
        ) : null}
      </div>
    </>
  );
}

function RangeSummary({
  blocks,
  closures,
  rangeLabel,
  truncated,
  timezone,
  moveTip,
}: {
  blocks: readonly TimelineBlock[];
  closures: readonly Closure[];
  rangeLabel: string;
  truncated: boolean;
  timezone: string;
  moveTip: string | null;
}) {
  const live = blocks.filter((b) => b.status !== 'canceled' && b.type !== 'draft-change');
  const drafts = blocks.filter((b) => b.status === 'draft').length;
  const active = closures.filter((c) => c.status === 'active');
  const pending = closures.filter((c) => c.status === 'pending').length;
  return (
    <>
      <div className="tl-detail-head">
        <span className="tl-detail-kind">
          <Icon name="calendar_month" size={16} /> {rangeLabel}
        </span>
        <h4 className="tl-detail-title">At a glance</h4>
        <span className="caption">
          Select a block on the timeline to see its checks{truncated ? '' : '.'}
          {truncated ? '; counts cover the events loaded so far.' : ''}
        </span>
      </div>
      <ul className="tl-checks" aria-label="The day">
        <li data-tone="neutral">
          <span>Activities</span>
          <b>{live.length}</b>
        </li>
        <li data-tone={drafts > 0 ? 'pending' : 'neutral'}>
          <span>Not published</span>
          <b>{drafts}</b>
        </li>
        <li data-tone={active.length > 0 ? 'warning' : 'neutral'}>
          <span>Closed spaces</span>
          <b>
            {active.length} active{pending > 0 ? `, ${pending} pending` : ''}
          </b>
        </li>
        {active.slice(0, 3).map((c) => (
          <li key={c.id} data-tone="warning">
            <span>{c.reason}</span>
            <b>
              <span aria-hidden="true">▲</span> back by{' '}
              {shortClock(Date.parse(c.interval.end), timezone)}
            </b>
          </li>
        ))}
      </ul>
      <p className="caption tl-tip">{moveTip ?? TIP}</p>
    </>
  );
}

export function TimelineDetail({
  selected,
  blocks,
  closures,
  resources,
  operating,
  timezone,
  facilityId,
  rangeLabel,
  truncated,
  moveTip,
  onClear,
}: {
  selected: Selection;
  blocks: readonly TimelineBlock[];
  closures: readonly Closure[];
  resources: readonly Resource[];
  operating: readonly ResourceStatus[] | undefined;
  timezone: string;
  facilityId: string;
  rangeLabel: string;
  truncated: boolean;
  /** Why dragging is off for this viewer (replaces the tip), or null. */
  moveTip: string | null;
  onClear: () => void;
}) {
  const block = selected?.type === 'block' ? blocks.find((b) => b.key === selected.key) : undefined;
  const closure =
    selected?.type === 'closure' ? closures.find((c) => c.id === selected.id) : undefined;
  const isDraft = block && (block.type !== 'event' || block.status === 'draft');
  return (
    <aside className="card card-flush tl-detail" aria-label="Selected on the timeline">
      {block && isDraft ? (
        <DraftDetail
          key={block.key}
          block={block}
          resources={resources}
          timezone={timezone}
          facilityId={facilityId}
          onDone={onClear}
        />
      ) : block?.event ? (
        <EventDetail
          key={block.key}
          block={block}
          event={block.event}
          resources={resources}
          operating={operating}
          timezone={timezone}
          moveTip={moveTip}
        />
      ) : closure ? (
        <ClosureDetail closure={closure} resources={resources} timezone={timezone} />
      ) : (
        <RangeSummary
          blocks={blocks}
          closures={closures}
          rangeLabel={rangeLabel}
          truncated={truncated}
          timezone={timezone}
          moveTip={moveTip}
        />
      )}
      {block || closure ? (
        <div className="card-foot">
          <button type="button" className="tl-clear" onClick={onClear}>
            Clear selection
          </button>
        </div>
      ) : null}
    </aside>
  );
}
