/**
 * Audited privileged actions (SCR-S-46 "audited privileged actions", §4.14; K-08): records from
 * `GET /v1/audit-records`, newest first, paged with the API's cursor (§4.5, `useApiPages`), shown
 * by occurrence instant, action, target, actor, revisions, reason, correlation and operation, with
 * the details the API recorded behind a disclosure. Reading the audit is itself audited by the API
 * (every `GET /v1/audit-records` writes a core.view_audit record), so the audit is read only on an
 * explicit action: opening a trail, "Show records", "Load more" or "Try again". A loaded list is
 * never stale on its own (no re-read on window focus, reconnect or remount; it shows its age), so
 * no read happens that nobody asked for. ACCESS_DENIED (core.view_audit is for the
 * general manager and system administration, Proposed) is shown as not available to the viewer
 * with the API's message. Filters live in page state, never in the address (§4.14).
 */
import { pagedQueryKey, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { InsightQueryBoundary } from './feedback';
import { formatInstant, formatScalar, shortId } from './format';
import { roleLabel } from './labels';
import { personText, useDisplayNames } from './names';

export type AuditRecord = Schema<'AuditRecord'>;

/** The filters of `GET /v1/audit-records` (ListAuditRecordsQuery), without paging. */
export interface AuditFilters {
  targetType?: string;
  targetId?: string;
  actorPersonId?: string;
  action?: string;
  operationId?: string;
  correlationId?: string;
  from?: string;
  to?: string;
}

const PAGE_SIZE = 25;

function auditRequest(filters: AuditFilters) {
  return { query: { limit: PAGE_SIZE, ...filters } };
}

function useAuditPages(filters: AuditFilters) {
  return useApiPages({
    path: '/audit-records',
    request: auditRequest(filters),
    // Never stale: TanStack re-reads stale queries on window focus, reconnect and remount, and each
    // re-read would be another audited read nobody asked for.
    staleTime: Infinity,
  });
}

/**
 * Forget what was read for these filters, so the next list mounted for them (or the one showing
 * them now) reads the first page again: one deliberate audited read per explicit request.
 */
export function useFreshAuditRead(): (filters: AuditFilters) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (filters: AuditFilters) =>
      void queryClient.resetQueries({
        queryKey: pagedQueryKey('/audit-records', auditRequest(filters)),
        exact: true,
      }),
    [queryClient],
  );
}

function revisionText(record: AuditRecord): string | null {
  if (record.beforeRevision === null && record.afterRevision === null) return null;
  if (record.beforeRevision === null) return `revision ${record.afterRevision}`;
  return `revision ${record.beforeRevision} → ${record.afterRevision ?? 'none'}`;
}

export function AuditRecordRow({ record, actorName }: { record: AuditRecord; actorName: string }) {
  const details = Object.entries(record.details);
  const revision = revisionText(record);
  return (
    <li aria-labelledby={`audit-${record.id}`}>
      <div className="row-text">
        <span className="row-title" id={`audit-${record.id}`}>
          {record.action} · {record.targetType}{' '}
          <span title={record.targetId}>{shortId(record.targetId)}</span>
        </span>
        <span className="caption">
          {formatInstant(record.occurredAt)} · by {actorName}
          {record.actor.staffRoles.length > 0
            ? ` (${record.actor.staffRoles.map(roleLabel).join(', ')})`
            : ` (${record.actor.kind})`}
          {revision ? ` · ${revision}` : ''}
        </span>
        {record.reason ? <span className="caption">Reason: {record.reason}</span> : null}
        {record.correlationId || record.operationId ? (
          <span className="caption">
            {record.correlationId ? `Correlation ${record.correlationId}` : ''}
            {record.correlationId && record.operationId ? ' · ' : ''}
            {record.operationId ? `operation ${shortId(record.operationId)}` : ''}
          </span>
        ) : null}
        {details.length > 0 ? (
          <details className="ia-definition">
            <summary>Recorded details</summary>
            <dl className="ia-dl">
              {details.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{formatScalar(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </div>
    </li>
  );
}

/** One page list of audit records for the given filters (used by the browser and the trails). */
export function AuditRecordList({
  filters,
  label,
  emptyText,
}: {
  filters: AuditFilters;
  label: string;
  emptyText: string;
}) {
  const pages = useAuditPages(filters);
  const names = useDisplayNames((pages.data ?? []).map((r) => r.actor.personId));
  return (
    <>
      <InsightQueryBoundary
        query={pages}
        label={label.toLowerCase()}
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No audit records', description: emptyText }}
        deniedDescription="Reading the audit of privileged actions needs its own permission."
      >
        {(items) => (
          <ul className="list" aria-label={label}>
            {items.map((record) => (
              <AuditRecordRow
                key={record.id}
                record={record}
                actorName={
                  record.actor.personId
                    ? personText(names, record.actor.personId)
                    : record.actor.actorLabel || record.actor.kind
                }
              />
            ))}
          </ul>
        )}
      </InsightQueryBoundary>
      <LoadMore pages={pages} label="audit records" />
    </>
  );
}

/**
 * The audit history of one record (a staff membership, a capability switch), read only when the
 * viewer asks for it because the read is itself audited (§4.14).
 */
export function AuditTrail({
  targetType,
  targetId,
  subject,
}: {
  targetType: string;
  targetId: string;
  /** What the history is of, e.g. "membership 0192f1a0" or "Rentals". */
  subject: string;
}) {
  const [open, setOpen] = useState(false);
  const fresh = useFreshAuditRead();
  return (
    <div className="ia-section">
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} audit history of ${subject}`}
        onClick={() => {
          // Opening asks for the history as it is now; hiding keeps nothing re-reading.
          if (!open) fresh({ targetType, targetId });
          setOpen((v) => !v);
        }}
      >
        {open ? 'Hide audit history' : 'Show audit history'}
      </Button>
      {open ? (
        <AuditRecordList
          filters={{ targetType, targetId }}
          label={`Audit history of ${subject}`}
          emptyText="No audited change of this record is recorded."
        />
      ) : null}
    </div>
  );
}
