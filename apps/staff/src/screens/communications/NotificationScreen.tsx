/**
 * One notice: SCR-S-39 step 2 (audience preview and confirmation) while it is composed, then
 * SCR-S-40 delivery status (SPK-COMMS-003 to SPK-COMMS-006, SPK-AT-017, SPK-UX-006, DEC-020,
 * DEC-041).
 *
 * Preview (`GET /v1/notifications/{id}/recipients`): names, basis and a count resolved from
 * current permissions; never contact details (SPK-COMMS-006). Confirming the send
 * (`POST /v1/notifications/{id}/send` with the expected revision) resolves recipients again; any
 * excluded at that recheck are reported by count, not by contact. STALE_REVISION re-previews.
 *
 * Delivery (`GET /v1/notifications/{id}/deliveries`): per recipient and channel the exact states
 * queued, provider accepted, delivered where confirmed, failed, unknown, read, acknowledged
 * (SPK-COMMS-004), with counts per state. A push is never shown as guaranteed delivery. Retrying a
 * failed delivery is not offered by the API; failed urgent notices reach the Today workspace.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, COMMUNICATIONS_TABS } from '../../features/operations/AreaTabs';
import { nameOf, usePersonNames } from '../../features/operations/context';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import { formatInstant, humanize } from '../../features/operations/format';
import {
  CHANNEL_LABEL,
  DELIVERY_STATES,
  DELIVERY_STATUS,
  NOTIFICATION_STATUS,
  RECIPIENT_BASIS,
  RECIPIENT_STATUS,
  SUPPRESSION_REASON,
} from '../../features/operations/labels';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Notification = Schema<'Notification'>;
type Deliveries = Schema<'NotificationDeliveries'>;

export function NotificationScreen() {
  const { notificationId = '' } = useParams();
  return (
    <section aria-labelledby="notification-title">
      <h2 id="notification-title">Message</h2>
      <AreaTabs label="Communications screens" tabs={COMMUNICATIONS_TABS} />
      <NotificationView notificationId={notificationId} backPath="/communications" />
    </section>
  );
}

export function NotificationView({
  notificationId,
  backPath,
}: {
  notificationId: string;
  backPath: string;
}) {
  const notification = useApiQuery({
    path: '/notifications/{id}',
    request: { path: { id: notificationId } },
  });
  return (
    <>
      <p>
        <Link to={backPath}>All messages</Link>
      </p>
      <QueryBoundary
        query={notification}
        label="the message"
        empty={{ title: '', description: '' }}
        unavailableOffline={['previewing and sending messages']}
      >
        {(n) => (
          <>
            <NotificationSummary notification={n} />
            {n.status === 'composed' ? (
              <PreviewAndSend notification={n} />
            ) : (
              <DeliveryStatus notification={n} />
            )}
          </>
        )}
      </QueryBoundary>
    </>
  );
}

function NotificationSummary({ notification: n }: { notification: Notification }) {
  const badge = NOTIFICATION_STATUS[n.status];
  return (
    <div className="ops-section">
      <h3>{n.title}</h3>
      <div className="ops-actions">
        <StatusBadge tone={badge.tone} label={badge.label} />
        <StatusBadge
          tone="info"
          label={
            n.category === 'operational' ? 'Essential operational notice' : 'Promotional message'
          }
        />
        {n.protected ? (
          <StatusBadge
            tone="neutral"
            label="Participant-private: recipients re-checked before delivery"
          />
        ) : null}
      </div>
      <p className="caption">
        {humanize(n.kind)}
        {n.scheduledFor ? ` · Delivered no earlier than ${formatInstant(n.scheduledFor)}` : ''}
        {n.queuedAt ? ` · Queued ${formatInstant(n.queuedAt)}` : ''}
        {n.dispatchedAt ? ` · Dispatched ${formatInstant(n.dispatchedAt)}` : ''}
      </p>
      <p>{n.body}</p>
      {n.detailsBefore || n.detailsAfter ? (
        <dl>
          <dt>Before</dt>
          <dd>{summaryOf(n.detailsBefore)}</dd>
          <dt>After</dt>
          <dd>{summaryOf(n.detailsAfter)}</dd>
        </dl>
      ) : null}
      {n.status === 'suppressed' && n.suppressionReason ? (
        <p>Suppressed: {SUPPRESSION_REASON[n.suppressionReason]}.</p>
      ) : null}
      {n.supersededByNotificationId ? (
        <p>
          Replaced by a{' '}
          <Link to={`/communications/notifications/${n.supersededByNotificationId}`}>
            newer notice
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}

function summaryOf(details: Notification['detailsBefore']): string {
  if (!details) return 'None';
  const summary = (details as { summary?: unknown }).summary;
  if (typeof summary === 'string') return summary;
  return Object.entries(details)
    .map(
      ([k, v]) =>
        `${humanize(k)}: ${typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v)}`,
    )
    .join('; ');
}

function PreviewAndSend({ notification: n }: { notification: Notification }) {
  const queryClient = useQueryClient();
  const preview = useApiQuery({
    path: '/notifications/{id}/recipients',
    request: { path: { id: n.id } },
  });
  const send = useApiCommand('post', '/notifications/{id}/send', {
    invalidate: [
      ['api', '/notifications/{id}'],
      ['api', '/notifications'],
    ],
  });
  const rePreview = () => {
    send.reset();
    void queryClient.invalidateQueries({ queryKey: ['api', '/notifications/{id}'] });
    void queryClient.invalidateQueries({ queryKey: ['api', '/notifications/{id}/recipients'] });
  };
  const confirm = () =>
    void send
      .submit({ path: { id: n.id }, body: { expectedRevision: n.revision } })
      .catch(() => undefined);
  return (
    <section className="ops-section" aria-labelledby="preview-title">
      <h3 id="preview-title">Recipients</h3>
      <QueryBoundary
        query={preview}
        label="recipients"
        agePrefix="Resolved"
        isEmpty={(data) => data.count === 0}
        empty={{
          title: 'This audience resolves to nobody',
          description:
            'Nobody currently holds permission to receive messages for this audience (for example no guardian with receive-messages permission, or no staff in the role at this facility). Change the audience and compose again.',
        }}
        unavailableOffline={['sending']}
      >
        {(data) => (
          <>
            <p data-testid="recipient-count">
              {data.count} recipient{data.count === 1 ? '' : 's'}, resolved from current permissions
              at {formatInstant(data.resolvedAt)}. Contact details are never shown.
            </p>
            <ul className="list" aria-label="Recipients">
              {data.recipients.map((r) => (
                <li key={r.personId}>
                  <span>{r.displayName}</span>
                  <span className="caption">
                    {RECIPIENT_BASIS[r.basis]}
                    {r.basisDetail ? ` (${humanize(r.basisDetail)})` : ''}
                  </span>
                </li>
              ))}
            </ul>
            <div className="ops-actions">
              <Button busy={send.isProcessing} onClick={confirm}>
                Confirm and send to {data.count}
              </Button>
              <Button variant="secondary" onClick={rePreview}>
                Preview again
              </Button>
            </div>
          </>
        )}
      </QueryBoundary>
      {send.error ? (
        <CommandError
          error={send.error}
          onRetry={confirm}
          onReload={rePreview}
          subject="This message"
        />
      ) : null}
    </section>
  );
}

function DeliveryStatus({ notification: n }: { notification: Notification }) {
  const deliveries = useApiQuery({
    path: '/notifications/{id}/deliveries',
    request: { path: { id: n.id } },
  });
  return (
    <section className="ops-section" aria-labelledby="delivery-title">
      <h3 id="delivery-title">Delivery status</h3>
      {n.status === 'queued' ? (
        <CommandSuccess label="Queued">
          <span className="caption">
            Recipients were resolved again at send; delivery is tracked below.
          </span>
        </CommandSuccess>
      ) : null}
      <QueryBoundary
        query={deliveries}
        label="delivery status"
        isEmpty={(data) => data.recipients.length === 0}
        empty={{
          title: 'Nothing queued',
          description:
            'No recipient was resolved for this message, so nothing was queued for delivery.',
        }}
      >
        {(data) => <DeliveryDetail data={data} />}
      </QueryBoundary>
      <div className="ops-actions">
        <Button variant="secondary" onClick={() => void deliveries.refetch()}>
          Refresh delivery status
        </Button>
      </div>
    </section>
  );
}

function DeliveryDetail({ data }: { data: Deliveries }) {
  const names = usePersonNames(
    useMemo(() => data.recipients.map((r) => r.personId), [data.recipients]),
  );
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const a of data.attempts) c.set(a.status, (c.get(a.status) ?? 0) + 1);
    return c;
  }, [data.attempts]);
  const revoked = data.recipients.filter((r) => r.status === 'revoked').length;
  const failed = data.attempts.filter((a) => a.status === 'failed').length;
  const unknown = data.attempts.filter((a) => a.status === 'unknown').length;
  return (
    <>
      <ul className="ops-counts" aria-label="Deliveries by state">
        {DELIVERY_STATES.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => (
          <li key={s}>
            <StatusBadge
              tone={DELIVERY_STATUS[s].tone}
              label={`${DELIVERY_STATUS[s].label}: ${counts.get(s)}`}
            />
          </li>
        ))}
      </ul>
      {revoked > 0 ? (
        <p data-testid="recheck-excluded">
          {revoked} recipient{revoked === 1 ? ' was' : 's were'} excluded at the recheck before
          delivery (access changed).
        </p>
      ) : null}
      {unknown > 0 ? (
        <StateView
          variant="pending-decision"
          subject="When an unknown delivery outcome is escalated"
          decisions={['DEC-041']}
          owner="Technical lead/operator"
        />
      ) : null}
      {failed > 0 ? (
        <StateView
          variant="unavailable"
          title="Retrying a failed delivery is not available yet"
          description="The service does not offer a retry for a single delivery. Failed essential notices are raised in the Today workspace."
        />
      ) : null}
      <p className="caption">
        A push notification is not proof of delivery: only confirmed deliveries say so.
      </p>
      <ul className="list" aria-label="Recipients and deliveries">
        {data.recipients.map((r) => {
          const attempts = data.attempts.filter((a) => a.recipientId === r.id);
          const status = RECIPIENT_STATUS[r.status];
          const name = nameOf(names, r.personId);
          return (
            <li key={r.id} aria-label={name}>
              <div className="row-text">
                <span className="row-title">{name}</span>
                <StatusBadge tone={status.tone} label={status.label} />
                {r.revocationReason ? <span className="caption">{r.revocationReason}</span> : null}
                {attempts.length === 0 ? (
                  <span className="caption">No delivery attempt.</span>
                ) : (
                  <ul className="ops-history" aria-label={`Deliveries to ${name}`}>
                    {attempts.map((a) => (
                      <li key={a.id}>
                        {CHANNEL_LABEL[a.channel]}:{' '}
                        <StatusBadge
                          tone={DELIVERY_STATUS[a.status].tone}
                          label={DELIVERY_STATUS[a.status].label}
                        />{' '}
                        <span className="caption">
                          queued {formatInstant(a.queuedAt)}
                          {a.acceptedAt ? `, accepted ${formatInstant(a.acceptedAt)}` : ''}
                          {a.deliveredAt ? `, delivered ${formatInstant(a.deliveredAt)}` : ''}
                          {a.readAt ? `, read ${formatInstant(a.readAt)}` : ''}
                          {a.acknowledgedAt
                            ? `, acknowledged ${formatInstant(a.acknowledgedAt)}`
                            : ''}
                          {a.failedAt ? `, failed ${formatInstant(a.failedAt)}` : ''}
                          {a.failureCode ? ` (${humanize(a.failureCode.toLowerCase())})` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
