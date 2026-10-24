/**
 * SCR-S-48 External mappings (§5.3 "preserve external identifiers and extraction provenance";
 * §5.4 repeatable imports; SPK-AT-024 stable identities). Looks up which internal record an
 * external identifier of a source system is linked to (`GET /v1/external-mappings`), by source,
 * record category, external id or internal id. Names and emails are never keys, so the lookup is
 * by identifiers only and shows no personal data. A mapping the viewer may not see is answered
 * NOT_FOUND by the API and shown as not available.
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { InsightQueryBoundary } from '../../features/insight-admin/feedback';
import { SelectField, TextField } from '../../features/insight-admin/fields';
import { formatInstant, shortId, UUID_PATTERN } from '../../features/insight-admin/format';
import { ENTITY_TYPE_LABELS, ENTITY_TYPES } from '../../features/insight-admin/labels';
import { MigrationNav } from '../../features/insight-admin/nav';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

interface Lookup {
  sourceSystem: string;
  entityType: string;
  externalId: string;
  internalId: string;
}

const EMPTY: Lookup = { sourceSystem: '', entityType: '', externalId: '', internalId: '' };

function Results({ lookup }: { lookup: Lookup }) {
  const mappings = useApiQuery({
    path: '/external-mappings',
    request: {
      query: {
        limit: 100,
        ...(lookup.sourceSystem ? { sourceSystem: lookup.sourceSystem } : {}),
        ...(lookup.entityType
          ? { entityType: lookup.entityType as Schema<'ImportEntityType'> }
          : {}),
        ...(lookup.externalId ? { externalId: lookup.externalId } : {}),
        ...(lookup.internalId ? { internalId: lookup.internalId } : {}),
      },
    },
  });
  return (
    <InsightQueryBoundary
      query={mappings}
      label="external mappings"
      isEmpty={(data) => data.items.length === 0}
      empty={{
        title: 'No mapping found',
        description: 'No external identifier matches this lookup.',
      }}
    >
      {(data) => (
        <div
          className="ia-table-wrap"
          role="region"
          aria-label="External mappings table"
          tabIndex={0}
        >
          <table className="ia-table">
            <caption>External identifiers and their internal records</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Records</th>
                <th scope="col">External id</th>
                <th scope="col">Status</th>
                <th scope="col">Internal record</th>
                <th scope="col">First and last batch</th>
                <th scope="col">Linked</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id}>
                  <td>{m.sourceSystem}</td>
                  <td>{ENTITY_TYPE_LABELS[m.entityType]}</td>
                  <td>{m.externalId}</td>
                  <td>
                    <StatusBadge
                      tone={m.status === 'linked' ? 'success' : 'pending'}
                      label={m.status}
                    />
                  </td>
                  <td title={m.internalId ?? undefined}>
                    {m.internalId ? shortId(m.internalId) : 'none yet'}
                  </td>
                  <td>
                    {shortId(m.firstSeenBatchId)} / {shortId(m.lastSeenBatchId)}
                  </td>
                  <td>{formatInstant(m.linkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </InsightQueryBoundary>
  );
}

export function ExternalMappingsScreen() {
  const [draft, setDraft] = useState<Lookup>(EMPTY);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Lookup>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.sourceSystem && !draft.entityType && !draft.externalId && !draft.internalId) {
      setError('Enter at least one identifier or filter.');
      return;
    }
    if (draft.internalId && !UUID_PATTERN.test(draft.internalId.trim())) {
      setError('The internal id is a record id.');
      return;
    }
    setError(null);
    setLookup({
      sourceSystem: draft.sourceSystem.trim(),
      entityType: draft.entityType,
      externalId: draft.externalId.trim(),
      internalId: draft.internalId.trim(),
    });
  };
  return (
    <section aria-labelledby="mappings-title" className="ia-screen">
      <h2 id="mappings-title">External mappings</h2>
      <MigrationNav />
      <form className="ia-form" onSubmit={submit} aria-label="Look up external mappings" noValidate>
        <TextField
          label="Source system"
          value={draft.sourceSystem}
          onChange={(sourceSystem) => set({ sourceSystem })}
        />
        <SelectField
          label="Records"
          value={draft.entityType}
          onChange={(entityType) => set({ entityType })}
          placeholder="Any record category"
          options={ENTITY_TYPES.map((t) => ({ value: t, label: ENTITY_TYPE_LABELS[t] }))}
        />
        <TextField
          label="External id"
          value={draft.externalId}
          onChange={(externalId) => set({ externalId })}
          hint="The source system's own identifier; names and emails are never keys."
        />
        <TextField
          label="Internal id"
          value={draft.internalId}
          onChange={(internalId) => set({ internalId })}
          error={error}
        />
        <div>
          <Button type="submit">Look up</Button>
        </div>
      </form>
      {lookup ? <Results key={JSON.stringify(lookup)} lookup={lookup} /> : null}
    </section>
  );
}
