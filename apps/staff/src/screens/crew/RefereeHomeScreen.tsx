/**
 * Referee home (staff redesign Phase 8 item 5; SPK-STAFF-002/003/006, SPK-UX-007). The referee's
 * phone home (Home · Games · Pay · Issues · More):
 *
 * - Requests (`GET /v1/me/assignments`, offered official assignments): Accept (`POST
 *   /v1/assignments/{id}/accept` with the revision) takes effect at once, so the slot is covered
 *   and the manager's "no referee" issue clears on Today's next read; Undo for 5 s withdraws it
 *   again (`POST /v1/assignments/{id}/withdraw`). "Can't" asks for a one-tap reason and declines
 *   (`POST /v1/assignments/{id}/decline`): workforce raises the uncovered slot to the league
 *   manager, who offers it to the next candidate. Offering it to the next match by itself is a
 *   Pending decision (like open decision 4), and no reply-by time exists in the API (Proposed).
 * - Confirmed games: accepted assignments ahead, with the fee once one is submitted (rates are
 *   DEC-011, pending; "Submitted", "Approved", "Exported", never "Paid").
 * - Availability: the referee's own windows for the next week (`GET/POST /v1/availability`,
 *   workforce.manage_own_availability).
 * - Pay: the fee records' totals (`GET /v1/fee-submissions?personId=<self>`), opening Hours and fees.
 * Offline everything reads from cache and the commands are disabled with their reason (§4.15:
 * answers to offers are never queued).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { formatMoney } from '../../features/operations/format';
import { localToInstant } from '../../features/registration-finance/format';
import { FEE_STATUS } from '../../features/operations/labels';
import { useApp, useNow } from '../../providers/AppProviders';
import { BottomSheet } from '../../ui/BottomSheet';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { StatusBadge } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import { clockOf, countdownText, CrewHero, dayLabelOf, localDayOf, ProposedTag } from './crew-ui';
import './crew.css';

type WorkspaceAssignment = Schema<'WorkspaceAssignment'>;

const ASSIGNMENTS_KEY = ['api', '/me/assignments'] as const;

/** The one-tap reasons for "Can't" (sent as the decline's reason, never shown to families). */
export const DECLINE_REASONS = [
  'Not available then',
  'Too far to travel',
  'I know a team (conflict)',
  'Injured or unwell',
  'Other',
] as const;

function placeOf(item: WorkspaceAssignment): string {
  return item.activity.facility?.name ?? '';
}

function Request({ item }: { item: WorkspaceAssignment }) {
  const { online } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const now = useNow(60_000);
  const reasonId = useId();
  const sheetTitle = useId();
  const [asking, setAsking] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const accept = useApiCommand('post', '/assignments/{id}/accept', {
    invalidate: [ASSIGNMENTS_KEY],
  });
  const decline = useApiCommand('post', '/assignments/{id}/decline', {
    invalidate: [ASSIGNMENTS_KEY],
  });
  const withdraw = useApiCommand('post', '/assignments/{id}/withdraw', {
    invalidate: [ASSIGNMENTS_KEY],
  });
  const zone = item.activity.facility?.timezone ?? null;
  const canAccept = item.availableActions.includes('accept');
  const canDecline = item.availableActions.includes('decline');

  const onAccept = () => {
    if (!online) return;
    setAccepted(true);
    void accept
      .submit({
        path: { id: item.assignment.id },
        body: { expectedRevision: item.assignment.revision },
      })
      .then((res) => {
        // The "no referee" issue on Today reads coverage again.
        void queryClient.invalidateQueries({ queryKey: ['api', '/today'] });
        toast.show({
          tone: 'success',
          message: `Accepted: ${item.activity.title}`,
          onUndo: () => {
            void withdraw
              .submit({
                path: { id: item.assignment.id },
                body: {
                  reason: 'Accepted by mistake (undone)',
                  expectedRevision: res.assignment.revision,
                },
              })
              .catch(() =>
                toast.show({
                  tone: 'error',
                  message: 'Undo did not go through. Open the game to withdraw.',
                }),
              );
          },
        });
      })
      .catch(() => {
        setAccepted(false);
        toast.show({ tone: 'error', message: 'The game was not accepted. Try again.' });
      });
  };
  const onDecline = (reason: string) => {
    setAsking(false);
    void decline
      .submit({
        path: { id: item.assignment.id },
        body: { reason, expectedRevision: item.assignment.revision },
      })
      .then(() =>
        toast.show({
          message: 'Declined. Your league manager is told and asks the next referee.',
        }),
      )
      .catch(() =>
        toast.show({ tone: 'error', message: 'The request was not declined. Try again.' }),
      );
  };

  return (
    <li className="crew-card" data-edge={accepted ? 'success' : 'warning'}>
      <div className="crew-card-head">
        <StatusBadge
          tone={accepted ? 'success' : 'pending'}
          label={accepted ? 'Accepted' : 'Request'}
          size="sm"
        />
        <span className="crew-meta">
          {countdownText(item.activity.scheduledStart, item.activity.scheduledEnd, now)}
        </span>
      </div>
      <h3>{item.activity.title}</h3>
      <p className="crew-meta">
        {dayLabelOf(item.activity.scheduledStart, zone)} ·{' '}
        {clockOf(item.activity.scheduledStart, zone)}–{clockOf(item.activity.scheduledEnd, zone)}
        {placeOf(item) ? ` · ${placeOf(item)}` : ''}
      </p>
      <p className="crew-meta">
        {item.assignment.offeredAt
          ? `Offered ${dayLabelOf(item.assignment.offeredAt, zone)} ${clockOf(item.assignment.offeredAt, zone)}`
          : 'Offered'}{' '}
        · Reply by <ProposedTag label="not set yet" />
      </p>
      {accepted ? null : (
        <div className="crew-actions">
          <Button
            variant="secondary"
            onClick={() => setAsking(true)}
            disabled={!online || !canDecline || decline.isProcessing}
            aria-describedby={online ? undefined : reasonId}
          >
            Can&apos;t
          </Button>
          <Button
            onClick={onAccept}
            busy={accept.isProcessing}
            disabled={!online || !canAccept}
            aria-describedby={online ? undefined : reasonId}
          >
            Accept
          </Button>
        </div>
      )}
      {online ? null : (
        <p className="crew-meta" id={reasonId}>
          Answering needs a connection.
        </p>
      )}
      <BottomSheet
        open={asking}
        onClose={() => setAsking(false)}
        titleId={sheetTitle}
        title="Why can't you take it?"
        locked={decline.isProcessing}
      >
        <div className="issue-chips" role="group" aria-label="Reason">
          {DECLINE_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              className="issue-chip"
              onClick={() => onDecline(reason)}
            >
              {reason}
            </button>
          ))}
        </div>
        <p className="crew-note">
          <ProposedTag label="Pending decision" /> Passing a declined game to the next referee by
          itself is not decided; your league manager offers it.
        </p>
      </BottomSheet>
    </li>
  );
}

function Confirmed({ items }: { items: WorkspaceAssignment[] }) {
  return (
    <section className="crew-card" aria-labelledby="ref-confirmed-title">
      <h3 id="ref-confirmed-title">Confirmed games</h3>
      {items.length === 0 ? (
        <p className="crew-empty">No confirmed games ahead.</p>
      ) : (
        <ul className="crew-list">
          {items.map((item) => {
            const zone = item.activity.facility?.timezone ?? null;
            const fee = item.fee;
            return (
              <li key={item.assignment.id}>
                <div className="crew-row">
                  <span className="crew-time">{clockOf(item.activity.scheduledStart, zone)}</span>
                  <div className="crew-row-text">
                    <Link
                      className="crew-row-title"
                      to={`/workspace/assignments/${item.assignment.id}`}
                    >
                      {item.activity.title}
                    </Link>
                    <span className="crew-meta">
                      {dayLabelOf(item.activity.scheduledStart, zone)}
                      {placeOf(item) ? ` · ${placeOf(item)}` : ''} ·{' '}
                      {fee
                        ? `${formatMoney(fee.approvedAmountMinor ?? fee.submittedAmountMinor, fee.currency)} · ${FEE_STATUS[fee.status].label}`
                        : 'Fee after the game'}
                    </span>
                  </div>
                  <StatusBadge tone="success" label="Confirmed" size="sm" />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const DAY = 86_400_000;

function Availability({ personId, timeZone }: { personId: string; timeZone: string | null }) {
  const { online } = useApp();
  const toast = useToast();
  const now = useNow(60 * 60_000);
  const sheetTitle = useId();
  const [adding, setAdding] = useState(false);
  const [day, setDay] = useState(0);
  const [from, setFrom] = useState(9);
  const [to, setTo] = useState(13);
  const range = useMemo(() => {
    const start = Math.floor(now.getTime() / DAY) * DAY;
    return { from: new Date(start).toISOString(), to: new Date(start + 8 * DAY).toISOString() };
  }, [now]);
  const windows = useApiQuery({
    path: '/availability',
    request: { query: { personId, from: range.from, to: range.to } },
  });
  const add = useApiCommand('post', '/availability', { invalidate: [['api', '/availability']] });
  const base = Math.floor(now.getTime() / DAY) * DAY;
  /** The day chip's date and the chosen hours, read in the facility's zone (SPK-SCHED-008). */
  const submit = () => {
    const date = localDayOf(new Date(base + day * DAY), timeZone);
    const at = (h: number) => localToInstant(`${date}T${String(h).padStart(2, '0')}:00`, timeZone);
    const start = at(from);
    const end = at(to);
    if (!start || !end) return;
    void add
      .submit({ body: { interval: { start, end }, kind: 'available' } })
      .then(() => {
        setAdding(false);
        toast.show({ tone: 'success', message: 'Availability added' });
      })
      .catch(() =>
        toast.show({ tone: 'error', message: 'Availability was not added. Try again.' }),
      );
  };
  const items = (windows.data ?? []).filter((w) => w.status === 'active');
  return (
    <section className="crew-card" aria-labelledby="ref-availability-title">
      <div className="crew-card-head">
        <h3 id="ref-availability-title">Availability</h3>
        <Button
          variant="secondary"
          className="button-sm"
          onClick={() => setAdding(true)}
          disabled={!online}
        >
          Add
        </Button>
      </div>
      {windows.data === undefined ? (
        <Skeleton height={44} radius={12} />
      ) : items.length === 0 ? (
        <p className="crew-empty">
          No times set for the next week. Managers offer games when you are free.
        </p>
      ) : (
        <ul className="crew-list">
          {items.map((w) => (
            <li key={w.id}>
              <div className="crew-row">
                <StatusBadge
                  tone={w.kind === 'available' ? 'success' : 'neutral'}
                  label={w.kind === 'available' ? 'Free' : 'Away'}
                  size="sm"
                />
                <span className="crew-row-text">
                  <span className="crew-row-title">
                    {dayLabelOf(w.interval.start, timeZone)} · {clockOf(w.interval.start, timeZone)}
                    –{clockOf(w.interval.end, timeZone)}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <BottomSheet
        open={adding}
        onClose={() => setAdding(false)}
        titleId={sheetTitle}
        title="When are you free?"
        locked={add.isProcessing}
        footer={
          <Button onClick={submit} busy={add.isProcessing} disabled={!online || to <= from}>
            Add availability
          </Button>
        }
      >
        <div className="crew-days" role="group" aria-label="Day">
          {Array.from({ length: 7 }, (_, i) => {
            const at = new Date(base + i * DAY);
            return (
              <button
                key={i}
                type="button"
                className="crew-day"
                aria-pressed={day === i}
                onClick={() => setDay(i)}
              >
                <small>
                  {i === 0
                    ? 'Today'
                    : new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(at)}
                </small>
                <b>{at.getDate()}</b>
              </button>
            );
          })}
        </div>
        <div className="crew-actions">
          <label className="crew-meta">
            From{' '}
            <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
              {Array.from({ length: 15 }, (_, i) => i + 7).map((h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </label>
          <label className="crew-meta">
            To{' '}
            <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
              {Array.from({ length: 15 }, (_, i) => i + 8).map((h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </label>
        </div>
      </BottomSheet>
    </section>
  );
}

function Pay({ personId }: { personId: string }) {
  const fees = useApiQuery({
    path: '/fee-submissions',
    request: { query: { personId, limit: 200, order: 'desc' } },
  });
  const items = fees.data?.items ?? [];
  const currency = items[0]?.currency ?? 'USD';
  const sum = (statuses: readonly string[]) =>
    items
      .filter((f) => statuses.includes(f.status))
      .reduce((s, f) => s + (f.approvedAmountMinor ?? f.submittedAmountMinor), 0);
  return (
    <section className="crew-card" aria-labelledby="ref-pay-title">
      <div className="crew-card-head">
        <h3 id="ref-pay-title">Pay</h3>
        <Link className="button button-secondary button-sm" to="/workspace/fees">
          Hours and fees
        </Link>
      </div>
      {fees.data === undefined ? (
        <Skeleton height={44} radius={12} />
      ) : (
        <div className="crew-stats">
          <div className="crew-pay">
            <span className="crew-meta">Submitted</span>
            <strong>{formatMoney(sum(['submitted']), currency)}</strong>
          </div>
          <div className="crew-pay">
            <span className="crew-meta">Approved</span>
            <strong>{formatMoney(sum(['approved', 'adjusted']), currency)}</strong>
          </div>
          <div className="crew-pay">
            <span className="crew-meta">Exported</span>
            <strong>{formatMoney(sum(['exported']), currency)}</strong>
          </div>
        </div>
      )}
      <p className="crew-meta">Fee rates are set by the facility (pending decision DEC-011).</p>
    </section>
  );
}

export function RefereeHomeScreen() {
  const now = useNow(60_000);
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const assignments = useApiQuery({ path: '/me/assignments' });
  const t = now.getTime();
  const officiating = (assignments.data?.items ?? []).filter(
    (i) => i.assignment.kind === 'official',
  );
  const requests = officiating
    .filter((i) => i.assignment.status === 'offered')
    .sort((a, b) => a.activity.scheduledStart.localeCompare(b.activity.scheduledStart));
  const confirmed = officiating
    .filter(
      (i) => i.assignment.status === 'accepted' && new Date(i.activity.scheduledEnd).getTime() > t,
    )
    .sort((a, b) => a.activity.scheduledStart.localeCompare(b.activity.scheduledStart));
  const personId = me.data?.principal.personId ?? null;
  const zone = officiating[0]?.activity.facility?.timezone ?? null;
  return (
    <section aria-labelledby="referee-home-title" className="crew ops-screen">
      <CrewHero
        titleId="referee-home-title"
        kicker={`${dayLabelOf(now, zone)}${requests.length > 0 ? ` · ${requests.length} ${requests.length === 1 ? 'request' : 'requests'}` : ''}`}
        title="Referee"
      />
      <QueryBoundary
        query={assignments}
        label="your games"
        loading={
          <SkeletonGroup label="your games" className="crew">
            <Skeleton height={170} radius={20} />
            <Skeleton height={140} radius={20} />
          </SkeletonGroup>
        }
        empty={{ title: '', description: '' }}
        unavailableOffline={['accepting or declining games', 'adding availability']}
      >
        {() => (
          <>
            {requests.length > 0 ? (
              <>
                <h3 className="crew-section-title">Requests</h3>
                <ul className="crew-stack" aria-label="Requests">
                  {requests.map((item) => (
                    <Request key={item.assignment.id} item={item} />
                  ))}
                </ul>
              </>
            ) : null}
            <Confirmed items={confirmed} />
            {personId ? <Availability personId={personId} timeZone={zone} /> : null}
            {personId ? <Pay personId={personId} /> : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
