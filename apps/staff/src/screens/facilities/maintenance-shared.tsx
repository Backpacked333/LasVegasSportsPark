/**
 * Shared pieces of the facilities screens (SCR-S-41, SCR-S-42): names for assets and spaces, the
 * viewer's own person id (for "Assign to me"; the API has no staff directory to choose another
 * owner from), and the evidence reference editor (SPK-FAC-002 "supporting evidence" is stored by
 * reference; file upload waits on a storage provider, §5.2).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { Button } from '../../ui/Button';

type Evidence = Schema<'EvidenceReference'>;
export type EvidenceDraft = { kind: Evidence['kind']; reference: string; label: string };

export const TASKS_KEY = ['api', '/maintenance-tasks'] as const;
export const TASK_KEY = ['api', '/maintenance-tasks/{id}'] as const;
export const RESTRICTIONS_KEY = ['api', '/maintenance-restrictions'] as const;
export const RESTRICTION_KEY = ['api', '/maintenance-restrictions/{id}'] as const;
export const ASSETS_KEY = ['api', '/assets'] as const;
export const OPERATING_STATUS_KEY = ['api', '/facilities/{id}/operating-status'] as const;

export function useFacilityNames(facilityId: string) {
  const resources = useApiQuery({ path: '/resources', request: { query: { facilityId } } });
  const assets = useApiQuery({
    path: '/assets',
    request: { query: { facilityId, includeRetired: true } },
  });
  const resourceNames = new Map((resources.data ?? []).map((r) => [r.id, r.name]));
  const assetNames = new Map((assets.data ?? []).map((a) => [a.id, a.name]));
  return { resources, assets, resourceNames, assetNames };
}

export function useMyPersonId(): string | null {
  const me = useApiQuery({ path: '/me' });
  return me.data?.principal.personId ?? null;
}

export function whereLabel(
  task: { assetId: string | null; resourceId: string | null },
  assetNames: ReadonlyMap<string, string>,
  resourceNames: ReadonlyMap<string, string>,
): string {
  const parts = [
    task.assetId ? (assetNames.get(task.assetId) ?? 'an asset') : null,
    task.resourceId ? (resourceNames.get(task.resourceId) ?? 'a space') : null,
  ].filter(Boolean);
  return parts.join(' in ') || 'not recorded';
}

export function evidenceInput(drafts: readonly EvidenceDraft[]): Evidence[] {
  return drafts
    .filter((d) => d.reference.trim())
    .map((d) => ({
      kind: d.kind,
      reference: d.reference.trim(),
      ...(d.label.trim() ? { label: d.label.trim() } : {}),
    }));
}

export function EvidenceEditor({
  value,
  onChange,
  idPrefix,
}: {
  value: EvidenceDraft[];
  onChange: (next: EvidenceDraft[]) => void;
  idPrefix: string;
}) {
  const update = (i: number, patch: Partial<EvidenceDraft>) =>
    onChange(value.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <fieldset>
      <legend>Supporting evidence (references)</legend>
      <p className="caption">
        Add a link, a storage reference or a note. Uploading files is not available yet: a storage
        provider has not been selected.
      </p>
      {value.map((d, i) => (
        <span className="field-row" key={i}>
          <label htmlFor={`${idPrefix}-kind-${i}`}>Kind</label>
          <select
            id={`${idPrefix}-kind-${i}`}
            value={d.kind}
            onChange={(e) => update(i, { kind: e.target.value as Evidence['kind'] })}
          >
            <option value="photo">photo</option>
            <option value="document">document</option>
            <option value="link">link</option>
            <option value="note">note</option>
          </select>
          <label htmlFor={`${idPrefix}-ref-${i}`}>Reference</label>
          <input
            id={`${idPrefix}-ref-${i}`}
            value={d.reference}
            maxLength={2000}
            onChange={(e) => update(i, { reference: e.target.value })}
          />
          <label htmlFor={`${idPrefix}-label-${i}`}>Label</label>
          <input
            id={`${idPrefix}-label-${i}`}
            value={d.label}
            maxLength={200}
            onChange={(e) => update(i, { label: e.target.value })}
          />
          <Button
            variant="secondary"
            aria-label={`Remove evidence ${i + 1}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </span>
      ))}
      <Button
        variant="secondary"
        onClick={() => onChange([...value, { kind: 'photo', reference: '', label: '' }])}
      >
        Add evidence reference
      </Button>
    </fieldset>
  );
}
