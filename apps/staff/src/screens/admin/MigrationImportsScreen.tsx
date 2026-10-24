/**
 * SCR-S-48 Migration imports (§5.3, §5.4, SPK-AT-024, DEC-014; SPK-UX-008, SPK-UX-009): import
 * batches with source, snapshot time, checksum, transformation version, status (machine state
 * names), row outcomes and open review exceptions (`GET /v1/import-batches`), and staging a new
 * snapshot from the extraction's staging document (`POST /v1/import-batches`, Idempotency-Key per
 * intent). Staging and re-importing never charge or notify; a batch whose checksum matches an
 * earlier one is marked as a re-import of the same snapshot. The staging document's rows are
 * personal data: they are sent as read and never shown, logged or kept by this page (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import {
  CommandError,
  InsightQueryBoundary,
  PendingNote,
  fieldErrorsOf,
} from '../../features/insight-admin/feedback';
import { SelectField, TextField } from '../../features/insight-admin/fields';
import {
  deviceTimeZone,
  formatInstant,
  localDateTimeToInstant,
  shortId,
} from '../../features/insight-admin/format';
import { BATCHES_KEY } from '../../features/insight-admin/migration';
import {
  parseStagingDocument,
  readFileText,
  type StagingDocument,
} from '../../features/insight-admin/staging';
import { BATCH_BADGES, DECISIONS } from '../../features/insight-admin/labels';
import { MigrationNav } from '../../features/insight-admin/nav';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type ImportBatch = Schema<'ImportBatch'>;

const SOURCE_SYSTEM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

interface StageDraft {
  sourceSystem: string;
  snapshotTakenAt: string;
  transformationVersion: string;
  checksum: string;
  rowCount: string;
}

const EMPTY: StageDraft = {
  sourceSystem: '',
  snapshotTakenAt: '',
  transformationVersion: '',
  checksum: '',
  rowCount: '',
};

function StageBatch() {
  const { online } = useApp();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<StageDraft>(EMPTY);
  const [stagingDoc, setStagingDoc] = useState<StagingDocument | null>(null);
  const [documentName, setDocumentName] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const stage = useApiCommand('post', '/import-batches', { invalidate: [BATCHES_KEY] });
  const set = (patch: Partial<StageDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setStagingDoc(null);
    setDocumentName(null);
    if (!file) return;
    const result = parseStagingDocument(await readFileText(file));
    if (typeof result === 'string') {
      setErrors((e) => ({ ...e, document: result }));
      return;
    }
    setErrors(({ document: _dropped, ...rest }) => rest);
    setStagingDoc(result);
    setDocumentName(file.name);
  };

  const build = () => {
    const next: Record<string, string> = {};
    if (!SOURCE_SYSTEM.test(draft.sourceSystem)) {
      next.sourceSystem = 'A lower-case identifier, for example legacy-registration.';
    }
    const snapshot = localDateTimeToInstant(draft.snapshotTakenAt);
    if (!snapshot) next.snapshotTakenAt = 'Enter when the snapshot was taken.';
    if (!draft.transformationVersion.trim()) {
      next.transformationVersion = 'Enter the transformation version.';
    }
    if (draft.checksum && !SHA256.test(draft.checksum.trim())) {
      next.checksum = 'A lower-case SHA-256 hex digest (64 characters).';
    }
    const rowCount = draft.rowCount ? Number(draft.rowCount) : null;
    if (draft.rowCount && (!Number.isInteger(rowCount) || (rowCount ?? -1) < 0)) {
      next.rowCount = 'Enter the total number of rows.';
    }
    if (!stagingDoc) next.document = errors.document ?? 'Choose the staging document.';
    setErrors(next);
    if (Object.keys(next).length > 0 || !stagingDoc || !snapshot) return null;
    return {
      sourceSystem: draft.sourceSystem,
      snapshotTakenAt: snapshot,
      transformationVersion: draft.transformationVersion.trim(),
      ...(draft.checksum ? { checksum: draft.checksum.trim() } : {}),
      ...(rowCount !== null ? { rowCount } : {}),
      controlTotals: stagingDoc.controlTotals,
      rows: stagingDoc.rows,
      csv: stagingDoc.csv,
      ...(stagingDoc.extraction ? { extraction: stagingDoc.extraction } : {}),
    };
  };
  const send = (body: NonNullable<ReturnType<typeof build>>) =>
    void stage
      .submit({ body })
      .then((batch) => navigate(`/admin/migration/batches/${batch.id}`))
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = build();
    if (body) send(body);
  };
  const apiFields = fieldErrorsOf(stage.error);
  return (
    <form className="ia-form" onSubmit={submit} aria-label="Stage a snapshot" noValidate>
      <h3>Stage a snapshot</h3>
      <p className="caption">
        Staging records the snapshot as received; nothing is created, charged or sent until the
        batch is validated, reviewed and applied.
      </p>
      <TextField
        label="Source system"
        required
        value={draft.sourceSystem}
        onChange={(sourceSystem) => set({ sourceSystem })}
        error={errors.sourceSystem ?? apiFields.sourceSystem}
      />
      <TextField
        label="Snapshot taken at"
        type="datetime-local"
        required
        value={draft.snapshotTakenAt}
        onChange={(snapshotTakenAt) => set({ snapshotTakenAt })}
        hint={`Your time zone (${deviceTimeZone()}).`}
        error={errors.snapshotTakenAt ?? apiFields.snapshotTakenAt}
      />
      <TextField
        label="Transformation version"
        required
        value={draft.transformationVersion}
        onChange={(transformationVersion) => set({ transformationVersion })}
        error={errors.transformationVersion ?? apiFields.transformationVersion}
      />
      <TextField
        label="Declared checksum"
        value={draft.checksum}
        onChange={(checksum) => set({ checksum })}
        hint="SHA-256 the extraction computed; verified when the batch is validated."
        error={errors.checksum ?? apiFields.checksum}
      />
      <TextField
        label="Declared row count"
        type="number"
        inputMode="numeric"
        value={draft.rowCount}
        onChange={(rowCount) => set({ rowCount })}
        hint="Total rows when the snapshot is staged in chunks."
        error={errors.rowCount ?? apiFields.rowCount}
      />
      <div className="ia-field">
        <label htmlFor="staging-document">Staging document (required)</label>
        <input
          id="staging-document"
          type="file"
          accept="application/json,.json"
          aria-describedby="staging-document-hint"
          aria-invalid={errors.document ? true : undefined}
          onChange={(event) => void onFile(event)}
        />
        <span id="staging-document-hint" className="caption">
          The staging-v1 JSON the extraction produced: rows or csv, controlTotals, extraction.
        </span>
        {errors.document ? <span className="error-text">{errors.document}</span> : null}
        {stagingDoc && documentName ? (
          <span role="status">
            {documentName}: {stagingDoc.rows.length} rows, {stagingDoc.csv.length} CSV document
            {stagingDoc.csv.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
      <div>
        <Button type="submit" busy={stage.isProcessing} disabled={!online}>
          Stage snapshot
        </Button>
      </div>
      {!online ? <p className="caption">Staging needs a connection.</p> : null}
      <CommandError
        error={stage.error}
        onRetry={() => {
          const body = build();
          if (body) send(body);
        }}
      />
    </form>
  );
}

function BatchRow({ batch }: { batch: ImportBatch }) {
  const badge = BATCH_BADGES[batch.status];
  const counts = batch.outcomeCounts;
  return (
    <li aria-labelledby={`batch-${batch.id}`}>
      <div className="row-text">
        <Link
          className="row-title"
          id={`batch-${batch.id}`}
          to={`/admin/migration/batches/${batch.id}`}
        >
          {batch.sourceSystem} snapshot {formatInstant(batch.snapshotTakenAt)}
        </Link>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span className="caption">
          Batch {shortId(batch.id)} · received {formatInstant(batch.receivedAt)} · transformation{' '}
          {batch.transformationVersion} · {batch.rowCount} rows
        </span>
        <span className="caption ia-mono">
          Checksum {batch.checksum ?? batch.declaredChecksum ?? 'not sealed yet'}
        </span>
        <span className="caption">
          {counts
            ? `Outcomes: ${counts.created} created, ${counts.matched} matched, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.exception} exceptions · `
            : ''}
          {batch.exceptions.open} open for review
        </span>
        {batch.sameChecksumBatchIds.length > 0 ? (
          <span>
            <StatusBadge tone="info" label="Re-import of the same snapshot" /> Matches{' '}
            {batch.sameChecksumBatchIds.map(shortId).join(', ')}; records already imported are
            matched, nothing is charged or sent again.
          </span>
        ) : null}
      </div>
    </li>
  );
}

function BatchesPage({
  status,
  cursor,
  isLast,
  onMore,
}: {
  status: string;
  cursor: string | null;
  isLast: boolean;
  onMore: (cursor: string) => void;
}) {
  const batches = useApiQuery({
    path: '/import-batches',
    request: {
      query: {
        limit: 25,
        ...(cursor ? { cursor } : {}),
        ...(status ? { status: status as Schema<'ImportBatchStatus'> } : {}),
      },
    },
  });
  return (
    <InsightQueryBoundary
      query={batches}
      label="import batches"
      isEmpty={(data) => data.items.length === 0 && cursor === null}
      empty={{
        title: 'No import batches',
        description: 'Stage a snapshot from the source system to start an import.',
      }}
      unavailableOffline={['staging, validating, applying or aborting batches']}
    >
      {(data) => (
        <>
          <ul className="list" aria-label="Import batches">
            {data.items.map((batch) => (
              <BatchRow key={batch.id} batch={batch} />
            ))}
          </ul>
          {isLast && data.nextCursor ? (
            <Button variant="secondary" onClick={() => onMore(data.nextCursor as string)}>
              Show more batches
            </Button>
          ) : null}
        </>
      )}
    </InsightQueryBoundary>
  );
}

export function MigrationImportsScreen() {
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  return (
    <section aria-labelledby="migration-title" className="ia-screen">
      <h2 id="migration-title">Migration imports and reconciliation</h2>
      <MigrationNav />
      <PendingNote decisions={DECISIONS.migrationScope.ids} owner={DECISIONS.migrationScope.owner}>
        Which record categories are migrated from which sources, and which system writes each during
        transition. The staging format is the proposed neutral staging-v1 contract.
      </PendingNote>
      <section className="ia-section" aria-labelledby="batches-title">
        <h3 id="batches-title">Import batches</h3>
        <SelectField
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setCursors([null]);
          }}
          placeholder="All statuses"
          options={Object.keys(BATCH_BADGES).map((s) => ({ value: s, label: s }))}
        />
        {cursors.map((cursor, index) => (
          <BatchesPage
            key={`${status}:${cursor ?? 'first'}`}
            status={status}
            cursor={cursor}
            isLast={index === cursors.length - 1}
            onMore={(next) => setCursors((list) => [...list, next])}
          />
        ))}
      </section>
      <StageBatch />
    </section>
  );
}
