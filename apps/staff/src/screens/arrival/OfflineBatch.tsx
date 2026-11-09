/**
 * SCR-S-31 synchronised batches (§4.15, SPK-AT-018, SPK-UX-008; ENT-01 `GET /v1/offline-sync/{id}`).
 *
 * The API keeps every synchronised batch with its per-item outcome. This device remembers the ids
 * of the batches it sent (ids and counts only); a batch's stored outcome is read again here: the
 * snapshot reference and age at receipt, the maximum roster age in force, whether it was stale,
 * the counts and each item's outcome, reason and flags. Desk readers and support may also open a
 * batch another device sent by its reference (validated as an id before any request); anyone the
 * API does not let read it sees "not available", never whether it exists (§4.10). Times are in
 * the batch facility's zone (SPK-SCHED-008).
 *
 * ENT-06 (`GET /v1/offline-sync?facilityId=`): desk readers of the operating facility also see
 * every device's batches received there, newest first, optionally only those with something for
 * review (a conflict, a rejected item or a stale roster), each opening its stored outcome. The
 * section is shown only where `entry.read_offline_batch` is held at that facility.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { useFacilityZone, useOperatingFacility } from '../../features/operations/context';
import { CheckboxField, TextField } from '../../features/operations/fields';
import { formatInstant, shortRef } from '../../features/operations/format';
import type { SyncedBatch } from '../../features/operations/offline/queue';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';

type OfflineSyncBatch = Schema<'OfflineSyncBatch'>;
type OfflineSyncBatchSummary = Schema<'OfflineSyncBatchSummary'>;
type OutcomeValue = Schema<'OfflineItemOutcome'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOME: Record<OutcomeValue, { tone: StatusTone; label: string }> = {
  accepted: { tone: 'success', label: 'Synchronised' },
  accepted_with_conflict: { tone: 'warning', label: 'Recorded with a conflict: kept for review' },
  duplicate: { tone: 'neutral', label: 'Already recorded (not applied twice)' },
  rejected: { tone: 'danger', label: 'Rejected' },
};

const KIND_LABEL: Record<OfflineSyncBatch['items'][number]['kind'], string> = {
  attendance: 'Attendance',
  arrival: 'Facility arrival',
  departure: 'Departure',
  release: 'Supervised release',
};

export function SyncedBatches({ batches }: { batches: readonly SyncedBatch[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="ops-section" aria-labelledby="batches-title">
      <h3 id="batches-title">Synchronised batches</h3>
      {batches.length === 0 ? (
        <p className="caption">No batch has been synchronised from this device yet.</p>
      ) : (
        <ul className="list" aria-label="Synchronised batches">
          {batches.map((b) => (
            <SyncedBatchRow
              key={b.id}
              batch={b}
              open={open === b.id}
              onToggle={() => setOpen(open === b.id ? null : b.id)}
            />
          ))}
        </ul>
      )}
      <BatchLookup />
    </section>
  );
}

function SyncedBatchRow({
  batch: b,
  open,
  onToggle,
}: {
  batch: SyncedBatch;
  open: boolean;
  onToggle: () => void;
}) {
  const zone = useFacilityZone(b.facilityId);
  const name = `Batch ${shortRef(b.id)}, received ${formatInstant(b.receivedAt, zone)}`;
  return (
    <li aria-label={name}>
      <div className="row-text">
        <span className="row-title">{name}</span>
        <span className="caption">
          {b.items} item{b.items === 1 ? '' : 's'}: {b.accepted} synchronised,{' '}
          {b.conflicts + b.rejected} for review
          {b.duplicates > 0 ? `, ${b.duplicates} already recorded` : ''}
          {b.stale > 0 ? `, ${b.stale} against an old roster` : ''}
        </span>
      </div>
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} outcomes of ${name}`}
        onClick={onToggle}
      >
        {open ? 'Hide outcomes' : 'Show outcomes'}
      </Button>
      {open ? <OfflineBatchView batchId={b.id} /> : null}
    </li>
  );
}

/** ENT-06: every device's batches received at the operating facility (desk readers). */
export function FacilityBatches() {
  const facility = useOperatingFacility();
  const permissions = usePermissions();
  const [reviewOnly, setReviewOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const facilityId = facility.facilityId;
  const allowed =
    facilityId !== null && permissions.isPermitted('entry.read_offline_batch', facilityId) === true;
  const pages = useApiPages({
    path: '/offline-sync',
    request: {
      query: {
        facilityId: facilityId ?? '',
        limit: 25,
        ...(reviewOnly ? { needsReview: 'true' as const } : {}),
      },
    },
    enabled: allowed,
  });
  if (!allowed) return null;
  return (
    <section className="ops-section" aria-labelledby="facility-batches-title">
      <h3 id="facility-batches-title">Batches received at this facility</h3>
      <p className="caption">Every device&apos;s synchronised batches, newest first.</p>
      <CheckboxField
        label="Only batches with something for review"
        checked={reviewOnly}
        onChange={(checked) => {
          setReviewOnly(checked);
          setOpen(null);
        }}
        hint="A conflict, a rejected item or a roster older than the maximum age."
      />
      <QueryBoundary
        query={pages}
        label="batches"
        isEmpty={(items) => items.length === 0}
        empty={
          reviewOnly
            ? {
                title: 'Nothing for review',
                description: 'No batch here has a conflict, a rejected item or a stale roster.',
              }
            : {
                title: 'No batches yet',
                description: 'No device has synchronised a batch at this facility.',
              }
        }
      >
        {(items) => (
          <ul className="list" aria-label="Batches received at this facility">
            {items.map((b) => (
              <FacilityBatchRow
                key={b.id}
                batch={b}
                open={open === b.id}
                onToggle={() => setOpen(open === b.id ? null : b.id)}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="batches" />
    </section>
  );
}

function FacilityBatchRow({
  batch: b,
  open,
  onToggle,
}: {
  batch: OfflineSyncBatchSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const zone = useFacilityZone(b.facilityId);
  const review = b.counts.acceptedWithConflict + b.counts.rejected;
  const name = `Batch ${shortRef(b.id)} from ${b.deviceId}, received ${formatInstant(b.receivedAt, zone)}`;
  return (
    <li aria-label={name}>
      <div className="row-text">
        <span className="row-title">{name}</span>
        <span className="caption">
          {b.counts.items} item{b.counts.items === 1 ? '' : 's'}: {b.counts.accepted} synchronised,{' '}
          {review} for review
          {b.counts.duplicate > 0 ? `, ${b.counts.duplicate} already recorded` : ''}
          {b.stale ? ', roster older than the maximum age' : ''} · sent by{' '}
          {b.submittedBy.actorLabel}
        </span>
        {b.needsReview ? <StatusBadge tone="warning" label="For review" /> : null}
      </div>
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} outcomes of ${name}`}
        onClick={onToggle}
      >
        {open ? 'Hide outcomes' : 'Show outcomes'}
      </Button>
      {open ? <OfflineBatchView batchId={b.id} /> : null}
    </li>
  );
}

function BatchLookup() {
  const [reference, setReference] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const open = () => {
    const value = reference.trim();
    if (!UUID.test(value)) {
      setInvalid(true);
      setBatchId(null);
      return;
    }
    setInvalid(false);
    setBatchId(value.toLowerCase());
  };
  return (
    <div className="ops-section">
      <form
        className="ops-form"
        aria-label="Open a synchronised batch"
        onSubmit={(event) => {
          event.preventDefault();
          open();
        }}
      >
        <TextField
          label="Batch reference"
          value={reference}
          onChange={(v) => {
            setReference(v);
            if (invalid) setInvalid(false);
          }}
          hint="The full batch reference, for example from a follow-up in the Today workspace."
          error={invalid ? 'Enter the full batch reference.' : undefined}
        />
        <div className="ops-actions">
          <Button type="submit" variant="secondary" disabled={!reference.trim()}>
            Open batch
          </Button>
        </div>
      </form>
      {batchId ? <OfflineBatchView batchId={batchId} /> : null}
    </div>
  );
}

export function OfflineBatchView({ batchId }: { batchId: string }) {
  const batch = useApiQuery({
    path: '/offline-sync/{id}',
    request: { path: { id: batchId } },
  });
  return (
    <div className="ops-section" data-testid="offline-batch">
      <QueryBoundary
        query={batch}
        label="the batch"
        empty={{ title: '', description: '' }}
        agePrefix="Read"
      >
        {(b) => <BatchDetail batch={b} />}
      </QueryBoundary>
    </div>
  );
}

function BatchDetail({ batch: b }: { batch: OfflineSyncBatch }) {
  const zone = useFacilityZone(b.facilityId);
  const review = b.counts.acceptedWithConflict + b.counts.rejected;
  return (
    <>
      <StatusBadge
        tone={review > 0 || b.stale ? 'warning' : 'success'}
        label={
          review > 0
            ? `${b.counts.accepted} synchronised, ${review} for review`
            : `Synchronised ${b.counts.accepted}`
        }
      />
      <dl>
        <dt>Received</dt>
        <dd>{formatInstant(b.receivedAt, zone)}</dd>
        <dt>Roster snapshot</dt>
        <dd>
          Taken {formatInstant(b.snapshot.takenAt, zone)}, {Math.round(b.snapshotAgeSeconds / 60)}{' '}
          minutes old at receipt (maximum {b.maxRosterAgeMinutes} minutes)
          {b.stale ? (
            <>
              {' '}
              <StatusBadge tone="warning" label="Older than the maximum roster age: flagged" />
            </>
          ) : null}
        </dd>
        <dt>Device</dt>
        <dd>
          <code>{b.deviceId.slice(0, 18)}</code>
        </dd>
      </dl>
      {b.counts.duplicate > 0 ? (
        <p className="caption">{b.counts.duplicate} already recorded before: not applied twice.</p>
      ) : null}
      {b.exceptionIds.length > 0 ? (
        <p className="caption">
          {b.exceptionIds.length} follow-up{b.exceptionIds.length === 1 ? ' is' : 's are'} raised in
          the Today workspace for review.
        </p>
      ) : null}
      <ul className="ops-history" aria-label="Item outcomes">
        {b.items.map((i) => (
          <li key={i.clientObservationId}>
            {KIND_LABEL[i.kind]} <code>{shortRef(i.clientObservationId)}</code>:{' '}
            <StatusBadge tone={OUTCOME[i.outcome].tone} label={OUTCOME[i.outcome].label} />
            {i.reason ? <span> {i.reason}</span> : null}
            {i.flags.length > 0 ? (
              <span className="caption"> (flags: {i.flags.join(', ')})</span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
