/**
 * "Needs action" (S 1a right rail, S 1d top of the phone page; INTERACTIONS 1a rows 5 to 7):
 * the Today feed's open issues, folded and ordered by start time, each resolved in place:
 *
 * - a missing referee or coach shows who declined and the ranked candidates with Assign / Ask
 *   (`RefereeFix`); an offer unanswered for 15 minutes rises to the top and turns red;
 * - missing waivers of a class starting soon (from the strip's checks) offer "Flag at arrival"
 *   (this device: the arrival desk asks for the waiver at check-in) and "Send reminder", which
 *   waits on DEC-012 and is shown as proposed;
 * - money and other exceptions keep their next permitted action, Open exception and, where the
 *   API lists it, Acknowledge with the expected revision (§4.9);
 * - Snooze hides an issue for 30 minutes, except a blocking one in the last 15 minutes before its
 *   start. A resolved issue shows ✓ and leaves after 2 s.
 *
 * Sources the viewer may not read are named under the list (§4.10), never hidden or inferred.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { apiQueryKey } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { usePersonName } from '../../api/person-names';
import { useApiCommand } from '../../api/useApiCommand';
import { useApi, useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandFeedback';
import { StatusBadge, type HandoffTone } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import { facilityLabel } from '../../layout/FacilitySwitcher';
import { NextActionLink } from './NextActionLink';
import {
  RefereeFix,
  assignmentHistory,
  isEscalated,
  useTargetAssignments,
  type RefereeTarget,
} from './RefereeFix';
import { domainActions, permittedVerbs } from './exception-actions';
import { useTodayLocal } from './today-local';
import {
  canSnooze,
  orderIssues,
  shortName,
  shortTime,
  type IssueCard,
  type ScheduledEvent,
} from './today-model';

/** Time an issue shows its ✓ before it leaves the list. */
export const RESOLVED_LINGER_MS = 2_000;

export const TODAY_KEY = ['api', '/today'] as const;
export const EXCEPTIONS_KEY = ['api', '/exceptions'] as const;
export const EXCEPTION_KEY = ['api', '/exceptions/{id}'] as const;

type TodayItem = Schema<'TodayItem'>;

/** Exception id of a Today item from the `exception` source, else null. */
export function exceptionIdOf(item: TodayItem): string | null {
  if (item.source !== 'exception') return null;
  const fromDetails = item.details['exceptionId'];
  if (typeof fromDetails === 'string') return fromDetails;
  return item.id.startsWith('exception:') ? item.id.slice('exception:'.length) : null;
}

export interface WaiverIssue {
  id: string;
  event: ScheduledEvent;
  names: string[];
}

export interface IssueContext {
  timeZone: string;
  events: ReadonlyMap<string, ScheduledEvent>;
  spaceNames: ReadonlyMap<string, string>;
  facilityNames: ReadonlyMap<string, string>;
}

function AcknowledgeAction({ item, exceptionId }: { item: TodayItem; exceptionId: string }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const acknowledge = useApiCommand('post', '/exceptions/{id}/acknowledge', {
    invalidate: [TODAY_KEY, EXCEPTIONS_KEY, EXCEPTION_KEY],
  });
  const reload = () => {
    acknowledge.reset();
    void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
  };
  const fromDetails = item.details['revision'];
  const revision = item.revision ?? (typeof fromDetails === 'number' ? fromDetails : null);
  const submit = () =>
    void acknowledge
      .submit({
        path: { id: exceptionId },
        body: revision !== null ? { expectedRevision: revision } : {},
      })
      .catch(() => undefined);
  return (
    <>
      <Button
        variant="secondary"
        className="button-sm"
        busy={acknowledge.isProcessing}
        disabled={!online}
        aria-label={`Acknowledge: ${item.title}`}
        onClick={submit}
      >
        Acknowledge
      </Button>
      <CommandError error={acknowledge.error} onRetry={submit} onReload={reload} />
    </>
  );
}

function spaceOf(
  event: ScheduledEvent | undefined,
  names: ReadonlyMap<string, string>,
): string | null {
  if (!event) return null;
  return event.resourceIds.map((id) => names.get(id)).filter(Boolean)[0] ?? null;
}

/** The referee/coach target of a staffing item. */
function staffingTarget(card: IssueCard, event: ScheduledEvent | undefined): RefereeTarget | null {
  const item = card.item;
  if (!item?.affected) return null;
  const d = item.details;
  const targetType = item.affected.type as RefereeTarget['targetType'];
  if (!['fixture', 'event', 'session'].includes(targetType)) return null;
  const role = typeof d['role'] === 'string' ? (d['role'] as string) : 'referee';
  return {
    targetType,
    targetId: item.affected.id,
    kind: (typeof d['kind'] === 'string'
      ? d['kind']
      : role === 'coach'
        ? 'coach'
        : 'official') as RefereeTarget['kind'],
    role,
    slot: typeof d['slot'] === 'number' ? (d['slot'] as number) : undefined,
    assignmentId: typeof d['assignmentId'] === 'string' ? (d['assignmentId'] as string) : null,
    requirementId: typeof d['requirementId'] === 'string' ? (d['requirementId'] as string) : null,
    title: event?.title ?? item.title,
  };
}

function roleWord(role: string): string {
  return role.replaceAll('_', ' ');
}

function Tags({
  card,
  context,
  escalated,
}: {
  card: IssueCard;
  context: IssueContext;
  escalated: boolean;
}) {
  const event = card.eventId ? context.events.get(card.eventId) : undefined;
  const space = spaceOf(event, context.spaceNames);
  const time = card.startAt ? shortTime(card.startAt, context.timeZone, true) : null;
  let first: { tone: HandoffTone; label: string };
  if (escalated) first = { tone: 'error', label: 'No answer' };
  else if (card.kind === 'money') first = { tone: 'info', label: 'Money' };
  else if (card.blocking) first = { tone: 'error', label: 'Blocks start' };
  else if (time) first = { tone: 'warning', label: `Before ${time}` };
  else if (card.kind === 'restriction') first = { tone: 'warning', label: 'Restricted' };
  else
    first = {
      tone: card.severity === 'info' ? 'info' : 'warning',
      label: card.severity === 'critical' ? 'Critical' : 'Needs action',
    };
  const where = [space, card.blocking || escalated ? time : null].filter(Boolean).join(' · ');
  return (
    <span className="issue-tags">
      <StatusBadge tone={first.tone} label={first.label} size="sm" />
      {where ? <StatusBadge tone="neutral" label={where} size="sm" /> : null}
    </span>
  );
}

function StaffingCard({
  card,
  context,
  onResolved,
  onUndone,
  phone,
}: {
  card: IssueCard;
  context: IssueContext;
  onResolved: (assignedName: string) => void;
  onUndone: () => void;
  phone: boolean;
}) {
  const event = card.eventId ? context.events.get(card.eventId) : undefined;
  const target = staffingTarget(card, event);
  const assignments = useTargetAssignments(
    target ?? { targetType: 'event', targetId: '', kind: 'official', role: 'referee', title: '' },
  );
  if (!target) return <GenericBody card={card} context={context} />;
  const { declined } = assignmentHistory(assignments.data?.items ?? [], target.role);
  return (
    <>
      <span className="issue-title" id={`issue-title-${card.id}`}>
        No {roleWord(target.role)} for {target.title}
      </span>
      <span className="issue-text">
        {declined ? (
          <DeclinedLine assignment={declined} timeZone={context.timeZone} />
        ) : (
          'Best matches below.'
        )}
      </span>
      <RefereeFix
        target={target}
        timeZone={context.timeZone}
        onAssigned={onResolved}
        onUndone={onUndone}
        limit={phone ? 1 : 2}
        compact={phone}
      />
    </>
  );
}

/** "R. Patel declined at 7:58 AM. Best matches below." (the name read from the people read). */
function DeclinedLine({
  assignment,
  timeZone,
}: {
  assignment: Schema<'StaffAssignment'>;
  timeZone: string;
}) {
  const name = useDeclinedName(assignment.personId);
  return (
    <>
      {name ? `${shortName(name)} declined` : 'Declined'} at{' '}
      {shortTime(assignment.declinedAt!, timeZone)}. Best matches below.
    </>
  );
}

function GenericBody({ card, context }: { card: IssueCard; context: IssueContext }) {
  const item = card.item;
  if (!item) return null;
  const exceptionId = exceptionIdOf(item);
  const verbs = permittedVerbs(item.nextActions);
  const next = domainActions(item.nextActions);
  let title = card.title;
  let text: string | null = null;
  if (card.kind === 'restriction') {
    const space = item.affected ? context.spaceNames.get(item.affected.id) : undefined;
    const reason = item.title.replace(/^.*in effect:\s*/, '');
    const until = item.details['interval'] as { end?: string } | undefined;
    title = `${space ?? 'A space'} ${item.details['kind'] === 'limited' ? 'restricted' : 'closed'}: ${reason}`;
    text = until?.end
      ? `Back by ${shortTime(until.end, context.timeZone)}. Bookings on it need moving or cancelling.`
      : null;
  } else if (card.kind === 'readiness') {
    text = card.messages.join(' ');
  } else if (item.facilityId) {
    text = `${facilityLabel(item.facilityId, context.facilityNames)}${item.ageMinutes !== null ? ` · open ${item.ageMinutes} min` : ''}`;
  }
  const restrictionId =
    typeof item.details['restrictionId'] === 'string'
      ? (item.details['restrictionId'] as string)
      : null;
  const fixtureId = item.affected?.type === 'fixture' ? item.affected.id : null;
  return (
    <>
      <span className="issue-title" id={`issue-title-${card.id}`}>
        {title}
      </span>
      {text ? <span className="issue-text">{text}</span> : null}
      <span className="issue-actions">
        {next.map((a, i) => (
          <span key={`${a.action}-${a.href ?? i}`} className="issue-link">
            <NextActionLink action={a} />
          </span>
        ))}
        {card.kind === 'restriction' && restrictionId ? (
          <Link
            className="button button-secondary button-sm"
            to={`/facilities/restrictions/${restrictionId}`}
          >
            Open restriction
          </Link>
        ) : null}
        {card.kind === 'readiness' && fixtureId && next.length === 0 ? (
          <Link className="button button-secondary button-sm" to={`/leagues/fixtures/${fixtureId}`}>
            Open game
          </Link>
        ) : null}
        {exceptionId ? (
          <Link
            className="button button-secondary button-sm"
            to={`/today/exceptions/${exceptionId}`}
            aria-label={`Open exception: ${item.title}`}
          >
            Open exception
          </Link>
        ) : null}
        {exceptionId && verbs.has('acknowledge') ? (
          <AcknowledgeAction item={item} exceptionId={exceptionId} />
        ) : null}
      </span>
    </>
  );
}

function WaiverCard({ issue, onFlag }: { issue: WaiverIssue; onFlag: () => void }) {
  const n = issue.names.length;
  return (
    <>
      <span className="issue-title" id={`issue-title-${issue.id}`}>
        {n} {n === 1 ? 'waiver' : 'waivers'} missing for {issue.event.title}
      </span>
      <span className="issue-text">
        {issue.names.join(', ')}. Parents can sign at the desk tablet on arrival.
      </span>
      <span className="issue-actions">
        <Button variant="secondary" className="button-sm" onClick={onFlag}>
          Flag at arrival
        </Button>
        <Button
          variant="secondary"
          className="button-sm"
          disabled
          aria-describedby={`dec-012-${issue.id}`}
        >
          Send reminder
          <span className="proposed-tag" id={`dec-012-${issue.id}`}>
            <span aria-hidden="true">◷</span> DEC-012
          </span>
        </Button>
      </span>
    </>
  );
}

const EDGE: Record<string, string> = {
  error: 'danger',
  warning: 'warning',
  info: 'info',
  neutral: 'neutral',
};

function IssueShell({
  id,
  edge,
  resolvedLabel,
  children,
  snooze,
}: {
  id: string;
  edge: string;
  resolvedLabel: string | null;
  children: React.ReactNode;
  snooze: React.ReactNode;
}) {
  return (
    <li
      className="issue-card"
      data-edge={edge}
      data-resolved={resolvedLabel ? true : undefined}
      aria-labelledby={`issue-title-${id}`}
      data-testid={`issue-${id}`}
    >
      {resolvedLabel ? (
        <span className="issue-resolved" role="status">
          <span aria-hidden="true">✓</span> {resolvedLabel}
        </span>
      ) : null}
      {children}
      {snooze}
    </li>
  );
}

function SnoozeButton({
  card,
  now,
  onSnooze,
}: {
  card: IssueCard | null;
  now: Date;
  onSnooze: () => void;
}) {
  if (card && !canSnooze(card, now)) {
    return <span className="issue-snooze caption">Starts within 15 min: can't be snoozed</span>;
  }
  return (
    <button type="button" className="issue-snooze link-button" onClick={onSnooze}>
      Snooze 30 min
    </button>
  );
}

function StaffingIssue({
  card,
  context,
  now,
  phone,
}: {
  card: IssueCard;
  context: IssueContext;
  now: Date;
  phone: boolean;
}) {
  const local = useTodayLocal();
  const toast = useToast();
  const [assigned, setAssigned] = useState<string | null>(null);
  const event = card.eventId ? context.events.get(card.eventId) : undefined;
  const target = staffingTarget(card, event);
  const assignments = useTargetAssignments(
    target ?? { targetType: 'event', targetId: '', kind: 'official', role: 'referee', title: '' },
  );
  const { offered } = assignmentHistory(assignments.data?.items ?? [], target?.role ?? 'referee');
  const escalated = isEscalated(offered, now);

  useEffect(() => {
    if (!assigned) return;
    const id = setTimeout(() => local.resolve(card.id), RESOLVED_LINGER_MS);
    return () => clearTimeout(id);
  }, [assigned, card.id, local]);

  return (
    <IssueShell
      id={card.id}
      edge={escalated || card.blocking ? 'danger' : 'warning'}
      resolvedLabel={assigned ? `Assigned ${assigned}` : null}
      snooze={
        assigned ? null : (
          <SnoozeButton
            card={card}
            now={now}
            onSnooze={() => {
              local.snooze(card.id, now);
              toast.show({ message: 'Snoozed for 30 min', onUndo: () => local.unsnooze(card.id) });
            }}
          />
        )
      }
    >
      <Tags card={card} context={context} escalated={escalated} />
      <StaffingCard
        card={card}
        context={context}
        onResolved={(name) => setAssigned(name)}
        onUndone={() => {
          setAssigned(null);
          local.unresolve(card.id);
        }}
        phone={phone}
      />
    </IssueShell>
  );
}

export function NeedsAction({
  cards,
  waiverIssues,
  context,
  now,
  sources,
  phone = false,
}: {
  cards: IssueCard[];
  waiverIssues: WaiverIssue[];
  context: IssueContext;
  now: Date;
  sources: Schema<'TodaySource'>[];
  phone?: boolean;
}) {
  const local = useTodayLocal();
  const toast = useToast();
  const api = useApi();
  // The offers of each staffing issue's target (the same reads its card makes): an offer
  // unanswered for 15 minutes moves the issue to the top (INTERACTIONS 1a row 6).
  const staffing = cards
    .filter((c) => c.kind === 'staffing')
    .map((c) => ({
      card: c,
      target: staffingTarget(c, c.eventId ? context.events.get(c.eventId) : undefined),
    }))
    .filter((x): x is { card: IssueCard; target: RefereeTarget } => x.target !== null);
  const offers = useQueries({
    queries: staffing.map(({ target }) => {
      const request = {
        query: { targetType: target.targetType, targetId: target.targetId, limit: 20 },
      };
      return {
        queryKey: apiQueryKey('/assignments', request),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api.request('get', '/assignments', { ...request, signal }),
      };
    }),
  });
  const escalatedIds = new Set(
    staffing
      .filter(({ target }, i) => {
        const data = offers[i]?.data?.data;
        return data ? isEscalated(assignmentHistory(data.items, target.role).offered, now) : false;
      })
      .map(({ card }) => card.id),
  );
  const visible = orderIssues(
    cards.filter((c) => !local.resolved.has(c.id) && !local.isSnoozed(c.id, now)),
    escalatedIds,
  );
  const waivers = waiverIssues.filter(
    (w) => !local.isFlagged(w.id) && !local.isSnoozed(w.id, now) && !local.resolved.has(w.id),
  );
  const total = visible.length + waivers.length;
  // Waiver issues sit by their start among the timed issues.
  type Row = { kind: 'card'; card: IssueCard } | { kind: 'waiver'; issue: WaiverIssue };
  const rows: Row[] = visible.map((card) => ({ kind: 'card' as const, card }));
  for (const issue of waivers) {
    const at = rows.findIndex(
      (r) =>
        r.kind === 'card' &&
        !r.card.blocking &&
        (!r.card.startAt || r.card.startAt > issue.event.scheduledStart),
    );
    rows.splice(at === -1 ? rows.length : at, 0, { kind: 'waiver', issue });
  }
  const limited = sources.filter((s) => s.status !== 'ok');

  return (
    <section className="card card-flush needs-action" aria-labelledby="needs-action-title">
      <div className="card-head">
        <h3 id="needs-action-title">Needs action</h3>
        {phone ? null : <span className="caption">Sorted by start time</span>}
      </div>
      {total === 0 ? (
        <div className="card-body">
          <p className="needs-action-empty">
            <span aria-hidden="true">✓</span> Nothing needs action right now.
          </p>
        </div>
      ) : (
        <ul className="issue-list" aria-label="Needs action">
          {rows.map((row) => {
            if (row.kind === 'waiver') {
              const issue = row.issue;
              return (
                <IssueShell
                  key={issue.id}
                  id={issue.id}
                  edge="warning"
                  resolvedLabel={null}
                  snooze={
                    <SnoozeButton
                      card={null}
                      now={now}
                      onSnooze={() => {
                        local.snooze(issue.id, now);
                        toast.show({
                          message: 'Snoozed for 30 min',
                          onUndo: () => local.unsnooze(issue.id),
                        });
                      }}
                    />
                  }
                >
                  <span className="issue-tags">
                    <StatusBadge
                      tone="warning"
                      label={`Before ${shortTime(issue.event.scheduledStart, context.timeZone, true)}`}
                      size="sm"
                    />
                    {spaceOf(issue.event, context.spaceNames) ? (
                      <StatusBadge
                        tone="neutral"
                        label={spaceOf(issue.event, context.spaceNames)!}
                        size="sm"
                      />
                    ) : null}
                  </span>
                  <WaiverCard
                    issue={issue}
                    onFlag={() => {
                      local.flag(issue.id, issue.event.scheduledEnd);
                      toast.show({
                        tone: 'success',
                        message: `Flagged: the arrival desk asks for ${issue.names.length === 1 ? 'the waiver' : 'the waivers'} at check-in`,
                        onUndo: () => local.unflag(issue.id),
                      });
                    }}
                  />
                </IssueShell>
              );
            }
            const card = row.card;
            if (card.kind === 'staffing') {
              return (
                <StaffingIssue
                  key={card.id}
                  card={card}
                  context={context}
                  now={now}
                  phone={phone}
                />
              );
            }
            return (
              <IssueShell
                key={card.id}
                id={card.id}
                edge={card.kind === 'money' ? 'info' : EDGE[card.blocking ? 'error' : 'warning']!}
                resolvedLabel={null}
                snooze={
                  <SnoozeButton
                    card={card}
                    now={now}
                    onSnooze={() => {
                      local.snooze(card.id, now);
                      toast.show({
                        message: 'Snoozed for 30 min',
                        onUndo: () => local.unsnooze(card.id),
                      });
                    }}
                  />
                }
              >
                <Tags card={card} context={context} escalated={false} />
                <GenericBody card={card} context={context} />
              </IssueShell>
            );
          })}
        </ul>
      )}
      {limited.length > 0 ? (
        <div className="card-foot sources-note">
          <p className="caption">
            Not included:{' '}
            {limited
              .map(
                (s) =>
                  `${s.source.replaceAll('_', ' ')} (${s.facilityId ? facilityLabel(s.facilityId, context.facilityNames) : 'all facilities'}: ${s.status === 'unavailable' ? 'unavailable right now' : 'not available to you'})`,
              )
              .join('; ')}
            .
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** The name of whoever declined (`GET /v1/people/{id}` through the minimal name read). */
function useDeclinedName(personId: string): string | null {
  const name = usePersonName(personId);
  return name.data ? `${name.data.givenName} ${name.data.familyName}` : null;
}
