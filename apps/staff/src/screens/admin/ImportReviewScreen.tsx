/**
 * SCR-S-48 Import review queue (§5.4 "ambiguous relationships and balances enter review queues";
 * §5.5; SPK-UX-008 recovery required: each exception names its review owner). Lists import
 * exceptions across batches (`GET /v1/import-exceptions`) filtered by status, kind and owning role,
 * and records accept, reject or defer with a reason and the expected revision
 * (`POST /v1/import-exceptions/{id}/decide`, Idempotency-Key per intent). The API decides who may
 * decide each queue; ACCESS_DENIED is shown with its message.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { InsightQueryBoundary } from '../../features/insight-admin/feedback';
import { SelectField } from '../../features/insight-admin/fields';
import {
  EXCEPTION_KIND_LABELS,
  EXCEPTION_STATUS_BADGES,
  STAFF_ROLES,
  roleLabel,
} from '../../features/insight-admin/labels';
import { ExceptionCard } from '../../features/insight-admin/migration';
import { MigrationNav } from '../../features/insight-admin/nav';
import { Button } from '../../ui/Button';

function ExceptionsPage({
  filters,
  cursor,
  isLast,
  onMore,
}: {
  filters: { status: string; kind: string; owner: string };
  cursor: string | null;
  isLast: boolean;
  onMore: (cursor: string) => void;
}) {
  const exceptions = useApiQuery({
    path: '/import-exceptions',
    request: {
      query: {
        limit: 50,
        ...(cursor ? { cursor } : {}),
        ...(filters.status
          ? { status: filters.status as Schema<'ImportException'>['status'] }
          : {}),
        ...(filters.kind ? { kind: filters.kind as Schema<'ImportExceptionKind'> } : {}),
        ...(filters.owner
          ? { reviewOwnerRole: filters.owner as Schema<'ImportException'>['reviewOwnerRole'] }
          : {}),
      },
    },
  });
  return (
    <InsightQueryBoundary
      query={exceptions}
      label="the review queue"
      isEmpty={(data) => data.items.length === 0 && cursor === null}
      empty={{
        title: 'Nothing to review',
        description: 'No import exception matches these filters.',
      }}
      unavailableOffline={['recording review decisions']}
    >
      {(data) => (
        <>
          <ul className="list" aria-label="Import exceptions">
            {data.items.map((exception) => (
              <ExceptionCard key={exception.id} exception={exception} />
            ))}
          </ul>
          {isLast && data.nextCursor ? (
            <Button variant="secondary" onClick={() => onMore(data.nextCursor as string)}>
              Show more exceptions
            </Button>
          ) : null}
        </>
      )}
    </InsightQueryBoundary>
  );
}

export function ImportReviewScreen() {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [owner, setOwner] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const reset = () => setCursors([null]);
  return (
    <section aria-labelledby="review-title" className="ia-screen">
      <h2 id="review-title">Import review queue</h2>
      <MigrationNav />
      <div className="ia-filters">
        <SelectField
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            reset();
          }}
          placeholder="All statuses"
          options={Object.keys(EXCEPTION_STATUS_BADGES).map((s) => ({ value: s, label: s }))}
        />
        <SelectField
          label="Kind"
          value={kind}
          onChange={(v) => {
            setKind(v);
            reset();
          }}
          placeholder="All kinds"
          options={Object.entries(EXCEPTION_KIND_LABELS).map(([value, label]) => ({
            value,
            label,
          }))}
        />
        <SelectField
          label="Review owner"
          value={owner}
          onChange={(v) => {
            setOwner(v);
            reset();
          }}
          placeholder="Every owner"
          options={STAFF_ROLES.map((role) => ({ value: role, label: roleLabel(role) }))}
        />
      </div>
      {cursors.map((cursor, index) => (
        <ExceptionsPage
          key={`${status}:${kind}:${owner}:${cursor ?? 'first'}`}
          filters={{ status, kind, owner }}
          cursor={cursor}
          isLast={index === cursors.length - 1}
          onMore={(next) => setCursors((list) => [...list, next])}
        />
      ))}
    </section>
  );
}
