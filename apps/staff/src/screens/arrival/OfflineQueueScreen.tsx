/**
 * SCR-S-31 Offline queue and synchronisation review (§4.15, SPK-AT-018, DEC-032, DEC-033,
 * POL-020, §5.11). Shows every observation queued on this device with the §4.15 fields
 * (identifier, actor, event, observed time, roster snapshot and its age; the received time is set
 * by the API), synchronises once (`POST /v1/offline-sync`), and keeps conflicting or rejected
 * observations for review with the API's reason. Offline is the normal state of this screen.
 *
 * The stored outcome of a synchronised batch is read again with `GET /v1/offline-sync/{id}`
 * (ENT-01): this device remembers the ids of the batches it sent, and desk readers may open any
 * batch by its reference (OfflineBatch.tsx). There is no list of every device's batches.
 *
 * Not available from the API: device approval and a server-issued, encrypted roster snapshot
 * (entry module known gaps; DEC-023, DEC-032, DEC-033 pending). The snapshot reference stays the
 * device's own label for the read it queued against. Its time, and every observed time queued
 * against it, is on the service's clock when the read's `Date` header is readable (same origin, or
 * the API exposes it): the device clock moved by the offset seen at that read
 * (`offline/clock.ts`). Otherwise both are the device clock. The API refuses a snapshot dated more
 * than its clock-skew tolerance after its own clock (`snapshot_in_future`); a requeued item keeps
 * the times it was queued with, so the hint says when queuing it again can succeed.
 *
 * A batch the API refuses outright (a 4xx such as VALIDATION_FAILED or ACCESS_DENIED: nothing in
 * it was recorded) is not retried under the same key for ever: its items move to "Kept for
 * review" with the API's code and message, where they can be queued again under a new batch or
 * discarded, and the other batches are still sent. Only a batch whose outcome is unknown (no
 * answer, a 5xx, the same key still running) stops the run and keeps its key for the retry.
 */
import { formatAge } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { ARRIVAL_TABS, AreaTabs, type AreaTab } from '../../features/operations/AreaTabs';
import { nameOf, usePersonNames } from '../../features/operations/context';
import { CommandError } from '../../features/operations/feedback';
import { formatClock, formatInstant, shortRef } from '../../features/operations/format';
import { OBSERVED_STATE, VISITOR_CATEGORY_LABEL } from '../../features/operations/labels';
import { useOfflineQueue } from '../../features/operations/offline/OfflineQueueProvider';
import type { OfflineItem, QueuedItem } from '../../features/operations/offline/queue';
import { useApp, useNow } from '../../providers/AppProviders';
import { Kpi, KpiRow, PageHeader } from '../../ui/Page';
import './arrival.css';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { OfflineBatchView, SyncedBatches } from './OfflineBatch';

function personOf(item: OfflineItem): string {
  return item.kind === 'release' ? item.childPersonId : item.personId;
}

function eventLabel(item: OfflineItem): string {
  switch (item.kind) {
    case 'attendance':
      return `Attendance: ${OBSERVED_STATE[item.observedState].label}`;
    case 'arrival':
      return `Facility arrival (${VISITOR_CATEGORY_LABEL[item.visitorCategory]})`;
    case 'departure':
      return 'Departure';
    case 'release':
      return 'Supervised release';
  }
}

/** Also the workspace's queue review (SCR-W-10), with the workspace's screen links. */
export function OfflineQueueScreen({
  tabs = ARRIVAL_TABS,
  tabsLabel = 'Arrival and attendance screens',
}: {
  tabs?: readonly AreaTab[];
  tabsLabel?: string;
}) {
  const queue = useOfflineQueue();
  const { online, services } = useApp();
  const now = useNow(15_000);
  const { mine, others, state } = queue;
  const ids = useMemo(
    () => [
      ...mine.map((q) => personOf(q.item)),
      ...state.review.map((r) => personOf(r.queued.item)),
    ],
    [mine, state.review],
  );
  const names = usePersonNames(online ? ids : []);
  const label = (id: string) => (online ? nameOf(names, id) : 'Name not stored on this device');
  const maxAge = services.config.offlineRosterMaxAgeMs ?? null;
  const last = state.lastSync;

  return (
    <section aria-labelledby="offline-title" className="ops-screen">
      <PageHeader
        eyebrow={online ? 'This device · connected' : 'This device · offline'}
        title="Offline queue"
        titleId="offline-title"
        intro="Arrivals and attendance observed without a connection wait here, on this device only, until they are synchronised once."
      />
      <AreaTabs label={tabsLabel} tabs={tabs} />
      <KpiRow label="Offline queue at a glance">
        <Kpi
          icon={mine.length > 0 ? 'sync' : 'cloud_done'}
          tone={mine.length > 0 ? 'warning' : 'success'}
          label="Waiting to sync"
          value={mine.length}
          sub="not yet recorded"
        />
        <Kpi
          icon="rule"
          tone={state.review.length > 0 ? 'danger' : 'neutral'}
          label="For review"
          value={state.review.length}
        />
        <Kpi
          icon="history"
          tone="info"
          label="Last synchronised"
          value={last ? formatClock(last.at) : '–'}
          sub={last ? `${last.synchronised} synchronised` : 'not yet from this device'}
        />
      </KpiRow>
      <div className="ops-section">
        <h3>This device</h3>
        <p>
          Device reference: <code>{state.deviceId.slice(0, 18)}</code>
        </p>
        <StateView
          variant="pending-decision"
          subject="Device approval and encrypted roster download"
          decisions={['DEC-032']}
          owner="Operations; Technical lead/operator"
        />
        <p className="caption">
          Only identifiers, states and times are kept on this device; names are not stored.
          {maxAge === null
            ? ' The maximum roster age is not configured (DEC-033): the service flags observations against an old roster for review.'
            : ` Maximum roster age: ${Math.round(maxAge / 60_000)} minutes.`}
        </p>
        {!online ? (
          <StatusBadge
            tone="warning"
            label="Offline: observations stay queued until the connection returns"
          />
        ) : null}
      </div>

      <section className="ops-section" aria-labelledby="queued-title">
        <h3 id="queued-title">Queued observations</h3>
        {mine.length === 0 ? (
          <StateView
            variant="empty"
            title="Nothing queued"
            description="Arrivals and attendance recorded while offline appear here until they are synchronised."
          />
        ) : (
          <>
            <QueueTable items={mine} label={label} now={now} maxAge={maxAge} />
            <div className="ops-actions">
              <Button busy={queue.syncing} disabled={!online} onClick={() => void queue.sync()}>
                Synchronise {mine.length} now
              </Button>
              {!online ? (
                <span className="caption">Needs a connection; runs once on reconnection.</span>
              ) : null}
            </div>
          </>
        )}
        {others.length > 0 ? (
          <p className="caption">
            {others.length} observation{others.length === 1 ? '' : 's'} queued by another account on
            this device. They are synchronised when that account signs in here, so the recorded
            actor is the person who observed.
          </p>
        ) : null}
        {queue.syncing ? <StatusBadge tone="pending" label="Synchronising" /> : null}
        {queue.syncError ? (
          // A lost answer is read again by synchronising: the batch goes under a new key with its
          // client batch id, and the API answers the stored batch (`batchSender`).
          <CommandError
            error={queue.syncError}
            onRetry={() => void queue.sync()}
            onReload={() => void queue.sync()}
          />
        ) : null}
        {last ? (
          <p data-testid="sync-summary">
            <StatusBadge
              tone={last.conflicts + last.rejected > 0 ? 'warning' : 'success'}
              label={`Synchronised at ${formatInstant(last.at)}`}
            />{' '}
            {last.synchronised} synchronised, {last.conflicts + last.rejected + (last.refused ?? 0)}{' '}
            for review
            {last.duplicates > 0 ? `, ${last.duplicates} already recorded (not applied twice)` : ''}
            {last.stale > 0 ? `, ${last.stale} against an old roster (flagged)` : ''}.
          </p>
        ) : null}
      </section>

      <section className="ops-section" aria-labelledby="review-title">
        <h3 id="review-title">Kept for review</h3>
        {state.review.length === 0 ? (
          <StateView
            variant="empty"
            title="Nothing to review"
            description="Conflicting or rejected observations from a synchronisation are kept here with the reason."
          />
        ) : (
          <ul className="list" aria-label="Observations kept for review">
            {state.review.map((r) => (
              <li key={r.queued.item.clientObservationId}>
                <div className="row-text">
                  <span className="row-title">
                    {label(personOf(r.queued.item))}: {eventLabel(r.queued.item)}
                  </span>
                  {r.outcome === 'accepted_with_conflict' ? (
                    <StatusBadge tone="warning" label="Recorded with a conflict: kept for review" />
                  ) : r.outcome === 'refused' ? (
                    <StatusBadge
                      tone="danger"
                      label={`Not recorded: the service refused the batch${r.reason ? `: ${r.reason}` : ''}`}
                    />
                  ) : (
                    <StatusBadge
                      tone="danger"
                      label={`Rejected${r.reason ? `: ${r.reason}` : ''}`}
                    />
                  )}
                  <span className="caption">
                    Observed {formatInstant(r.queued.item.observedAt)}
                    {r.queued.context ? ` · ${r.queued.context}` : ''} · batch {shortRef(r.batchId)}
                    {r.outcome === 'refused'
                      ? `. Error code: ${r.code ?? 'not stated'}. Nothing of this batch was recorded; queue it again once the cause is fixed, or discard it.`
                      : '. The conflict is raised in the Today workspace for review.'}
                  </span>
                  {r.outcome === 'refused' && r.flags.includes('snapshot_in_future') ? (
                    <span className="caption" data-testid="snapshot-in-future-hint">
                      The roster time stored with it ({formatInstant(r.queued.snapshot.takenAt)}) is
                      later than the service&apos;s clock: this device&apos;s clock was ahead when
                      it was queued. The stored times are sent unchanged, so correcting the clock
                      now does not fix them. Queue it again only after{' '}
                      {formatInstant(r.queued.snapshot.takenAt)} by the service&apos;s time (the
                      service allows a few minutes&apos; difference), or discard it and record the
                      observation again while online.
                    </span>
                  ) : null}
                </div>
                {r.outcome === 'refused' ? (
                  <Button
                    variant="secondary"
                    disabled={!online}
                    aria-label={`Queue again: ${eventLabel(r.queued.item)}`}
                    onClick={() => queue.requeue(r.queued.item.clientObservationId)}
                  >
                    Queue again
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  aria-label={`${r.outcome === 'refused' ? 'Discard (not recorded)' : 'Dismiss from this device'}: ${eventLabel(r.queued.item)}`}
                  onClick={() => queue.dismissReview(r.queued.item.clientObservationId)}
                >
                  {r.outcome === 'refused' ? 'Discard (not recorded)' : 'Dismiss from this device'}
                </Button>
                {r.serverBatchId ? (
                  <ReviewBatch batchId={r.serverBatchId} label={eventLabel(r.queued.item)} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <SyncedBatches batches={state.synced ?? []} />
    </section>
  );
}

/** The stored outcome of the batch a kept item came back in (ENT-01). */
function ReviewBatch({ batchId, label }: { batchId: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} the batch outcome: ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide the batch outcome' : 'Show the batch outcome'}
      </Button>
      {open ? <OfflineBatchView batchId={batchId} /> : null}
    </>
  );
}

function QueueTable({
  items,
  label,
  now,
  maxAge,
}: {
  items: QueuedItem[];
  label: (id: string) => string;
  now: Date;
  maxAge: number | null;
}) {
  return (
    <div className="ops-table-wrap">
      <table className="ops-table">
        <caption className="caption">
          Not yet recorded: each is sent once with its own identifier.
        </caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Event</th>
            <th scope="col">Observed</th>
            <th scope="col">Roster snapshot</th>
            <th scope="col">Identifier</th>
          </tr>
        </thead>
        <tbody>
          {items.map((q) => {
            const age = now.getTime() - new Date(q.snapshot.takenAt).getTime();
            const old = maxAge !== null && age > maxAge;
            return (
              <tr key={q.item.clientObservationId}>
                <td>{label(personOf(q.item))}</td>
                <td>
                  {eventLabel(q.item)}
                  {q.context ? <span className="caption"> · {q.context}</span> : null}
                </td>
                <td>{formatInstant(q.item.observedAt)}</td>
                <td>
                  Taken {formatAge(new Date(q.snapshot.takenAt), now)}
                  {old ? (
                    <>
                      {' '}
                      <StatusBadge tone="warning" label="Older than the maximum roster age" />
                    </>
                  ) : null}
                </td>
                <td>
                  <code>{shortRef(q.item.clientObservationId)}</code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
