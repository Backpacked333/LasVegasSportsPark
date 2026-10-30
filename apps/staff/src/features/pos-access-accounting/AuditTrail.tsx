/**
 * The audit history of one access hardware record (SCR-S-56 "audit"; §3.16 Access hardware, §4.14,
 * K-08): `GET /v1/audit-records?targetType=&targetId=`, newest first, paged with the API's cursor.
 * Reading the audit is itself audited by the API (every read writes a core.view_audit record), so
 * nothing is read until the viewer asks: "Show audit history" reads the first page as it is now,
 * "Load more" the next one, and a loaded list is never re-read on its own (no re-read on window
 * focus, reconnect or remount). Offered unless the permission read says core.view_audit is not
 * held (Proposed: general manager and system administration); the API's ACCESS_DENIED is shown as
 * not available. Times are the facility's (SPK-SCHED-008); the API's recorded details stay behind
 * a disclosure.
 */
import { pagedQueryKey, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { formatInstant, shortRef } from '../registration-finance/format';
import { CORE_ACTIONS, useOffer } from './permission';

type AuditRecord = Schema<'AuditRecord'>;

const PAGE_SIZE = 25;

function auditRequest(targetType: string, targetId: string) {
  return { query: { targetType, targetId, limit: PAGE_SIZE } };
}

function revisionText(record: AuditRecord): string | null {
  if (record.beforeRevision === null && record.afterRevision === null) return null;
  if (record.beforeRevision === null) return `revision ${record.afterRevision}`;
  return `revision ${record.beforeRevision} to ${record.afterRevision ?? 'none'}`;
}

function detailText(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function AuditRow({ record, zone }: { record: AuditRecord; zone: string | null }) {
  const details = Object.entries(record.details);
  const revision = revisionText(record);
  return (
    <li>
      <div className="row-text">
        <span className="row-title">{record.action}</span>
        <span className="caption">
          {formatInstant(record.occurredAt, zone)} by {record.actor.actorLabel || record.actor.kind}
          {revision ? ` · ${revision}` : ''}
        </span>
        {record.reason ? <span className="caption">Reason: {record.reason}</span> : null}
        {record.correlationId ? (
          <span className="caption">Correlation {record.correlationId}</span>
        ) : null}
        {details.length > 0 ? (
          <details>
            <summary>Recorded details</summary>
            <dl>
              {details.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{detailText(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function AuditList({
  targetType,
  targetId,
  subject,
  zone,
}: {
  targetType: string;
  targetId: string;
  subject: string;
  zone: string | null;
}) {
  const pages = useApiPages({
    path: '/audit-records',
    request: auditRequest(targetType, targetId),
    // Never stale: each re-read would be another audited read nobody asked for (§4.14).
    staleTime: Infinity,
  });
  return (
    <>
      <QueryBoundary
        query={pages}
        label={`the audit history of ${subject}`}
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No audit records',
          description: `No audited change of ${subject} is recorded.`,
        }}
      >
        {(items) => (
          <ul className="list" aria-label={`Audit history of ${subject}`}>
            {items.map((record) => (
              <AuditRow key={record.id} record={record} zone={zone} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="audit records" />
    </>
  );
}

export function AuditTrail({
  targetType,
  targetId,
  subject,
  zone,
}: {
  /** The API's audit target type, e.g. `access_device`. */
  targetType: string;
  targetId: string;
  /** What the history is of, e.g. "Main gate turnstile" or "policy 0192f1a0". */
  subject: string;
  zone: string | null;
}) {
  const offer = useOffer();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  if (!offer.allowed(CORE_ACTIONS.viewAudit)) return null;
  const toggle = () => {
    // Opening asks for the history as it is now: forget an earlier read of the same record.
    if (!open) {
      void queryClient.resetQueries({
        queryKey: pagedQueryKey('/audit-records', auditRequest(targetType, targetId)),
        exact: true,
      });
    }
    setOpen((v) => !v);
  };
  return (
    <div>
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} audit history of ${subject}`}
        onClick={toggle}
      >
        {open ? 'Hide audit history' : 'Show audit history'}
      </Button>
      {open ? (
        <>
          <p className="caption">
            Reading the audit is itself audited (§4.14). Record {shortRef(targetId)}.
          </p>
          <AuditList targetType={targetType} targetId={targetId} subject={subject} zone={zone} />
        </>
      ) : null}
    </div>
  );
}
