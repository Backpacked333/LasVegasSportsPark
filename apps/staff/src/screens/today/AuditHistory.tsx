/**
 * Audit history of one record (§4.14 privileged actions are audited; K-08) from
 * `GET /v1/audit-records?targetType&targetId`, newest first, page by page. Shown on the exception
 * (SCR-S-02), person (SCR-S-20), access review (SCR-S-22), duplicate candidate (SCR-S-23) and
 * support case (SCR-S-49) screens, only to a viewer whose role holds `core.view_audit` (from
 * `GET /v1/me/permissions`; the API still decides and an ACCESS_DENIED reads "not available").
 *
 * Reading the audit log is itself audited, so nothing is read until the viewer asks for it; the
 * panel says so. Each entry shows when, who (the API's actor label), the action, the revision
 * change, the reason and the operation; `details` are not shown (they can carry masked contact
 * values and other record content the owning screen already presents, §4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useId, useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { formatDateTime } from '../../ui/time';

type AuditRecord = Schema<'AuditRecord'>;

export const AUDIT_VIEW_ACTION = 'core.view_audit';
export const AUDIT_PAGE_SIZE = 20;

function revisionText(record: AuditRecord): string | null {
  if (record.beforeRevision === null && record.afterRevision === null) return null;
  return `revision ${record.beforeRevision ?? 'none'} to ${record.afterRevision ?? 'none'}`;
}

function AuditRecords({
  targetType,
  targetId,
  zone,
}: {
  targetType: string;
  targetId: string;
  zone: string | null;
}) {
  const pages = useApiPages({
    path: '/audit-records',
    request: { query: { targetType, targetId, limit: AUDIT_PAGE_SIZE } },
  });
  return (
    <>
      <QueryBoundary
        query={pages}
        label="the audit history"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No audited actions',
          description: 'No privileged action on this record has been audited yet.',
        }}
      >
        {(items) => (
          <ol className="list" aria-label="Audit history">
            {items.map((r) => {
              const revision = revisionText(r);
              return (
                <li key={r.id}>
                  <div className="row-text">
                    <span className="row-title">{r.action}</span>
                    <span className="caption">
                      {formatDateTime(r.occurredAt, zone)} · {r.actor.actorLabel}
                      {revision ? ` · ${revision}` : ''}
                      {r.operationId ? ` · operation ${r.operationId}` : ''}
                    </span>
                    {r.reason ? <span>Reason: {r.reason}</span> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="audit entries" />
    </>
  );
}

export function AuditHistory({
  targetType,
  targetId,
  zone = null,
}: {
  /** The audit record's target type, e.g. `support_case`, `person`. */
  targetType: string;
  targetId: string;
  /** The facility's time zone, when the record has one (SPK-SCHED-008). */
  zone?: string | null;
}) {
  const permissions = usePermissions();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  if (permissions.isPermitted(AUDIT_VIEW_ACTION) !== true) return null;
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h3 id={headingId}>Audit history</h3>
      <p className="caption">
        Privileged changes to this record, as the audit log holds them. Reading the audit log is
        itself recorded.
      </p>
      {open ? (
        <AuditRecords targetType={targetType} targetId={targetId} zone={zone} />
      ) : (
        <Button variant="secondary" aria-expanded={false} onClick={() => setOpen(true)}>
          Show audit history
        </Button>
      )}
    </section>
  );
}
