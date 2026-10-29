import type {
  AssistantEvidence,
  AssistantMissingEvidence,
  EvidenceFreshness,
  MissingEvidenceReason,
} from '@sportspark/contracts';

/**
 * SPK-AUTO-002: every response names its supporting records and their freshness, and missing
 * evidence stays visible. Pure helpers, unit-tested in evidence.spec.ts.
 *
 * Basis of a supporting record:
 *   `record`     the owning module's current state, read now; `asOf` is its last change;
 *   `evaluation` computed by the owning module at the read (readiness, the Today feed);
 *   `snapshot`   a stored or derived result as of an earlier instant (report figures).
 */
export type EvidenceBasis = 'record' | 'evaluation' | 'snapshot';

export interface EvidenceDraft {
  recordType: string;
  recordId: string;
  label?: string | null;
  asOf: Date | string | null;
  basis: EvidenceBasis;
}

export function freshnessOf(
  basis: EvidenceBasis,
  observedAt: Date,
  asOf: Date | null,
  maxAgeMinutes: number,
): { freshness: EvidenceFreshness; ageSeconds: number | null } {
  if (!asOf || Number.isNaN(asOf.getTime())) return { freshness: 'unknown', ageSeconds: null };
  const ageSeconds = Math.max(0, Math.floor((observedAt.getTime() - asOf.getTime()) / 1000));
  if (basis === 'record' || basis === 'evaluation') return { freshness: 'live', ageSeconds };
  return { freshness: ageSeconds <= maxAgeMinutes * 60 ? 'recent' : 'stale', ageSeconds };
}

/**
 * The same evidence read later (SPK-AUTO-002): a recommendation keeps the evidence read when it was
 * proposed, and a reviewer reads it up to its expiry. After its read it is a stored observation,
 * not a live one: it is `recent` while the instant its knowledge dates from (the read of a live
 * record or evaluation, the as-of instant of a stored result) lies within the evidence window and
 * `stale` beyond it, and its age is measured to `now`. At its own read it is unchanged.
 */
export function ageEvidence(
  item: AssistantEvidence,
  now: Date,
  maxAgeMinutes: number,
): AssistantEvidence {
  const observedAt = Date.parse(item.observedAt);
  if (item.asOf === null || item.freshness === 'unknown' || now.getTime() <= observedAt) {
    return item;
  }
  const asOf = Date.parse(item.asOf);
  const knownAt = item.freshness === 'live' ? observedAt : asOf;
  return {
    ...item,
    ageSeconds: Math.max(0, Math.floor((now.getTime() - asOf) / 1000)),
    freshness: now.getTime() - knownAt <= maxAgeMinutes * 60_000 ? 'recent' : 'stale',
  };
}

const SLUG = /^[a-z][a-z0-9_]{0,63}$/;

function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64);
  return SLUG.test(s) ? s : 'record';
}

export function evidenceItem(
  source: string,
  draft: EvidenceDraft,
  observedAt: Date,
  maxAgeMinutes: number,
  clientObservedAt: Date | null = null,
): AssistantEvidence {
  const asOf = draft.asOf === null ? null : new Date(draft.asOf);
  const { freshness, ageSeconds } = freshnessOf(draft.basis, observedAt, asOf, maxAgeMinutes);
  const changed =
    clientObservedAt && asOf && draft.basis === 'record'
      ? asOf.getTime() > clientObservedAt.getTime()
      : null;
  return {
    recordType: slug(draft.recordType),
    recordId: draft.recordId.slice(0, 200),
    source,
    label: draft.label ? draft.label.slice(0, 200) : null,
    observedAt: observedAt.toISOString(),
    asOf: asOf && !Number.isNaN(asOf.getTime()) ? asOf.toISOString() : null,
    ageSeconds,
    freshness,
    changedSinceClientObservation: changed,
  };
}

export function missingEvidence(
  recordType: string,
  recordId: string | null,
  source: string | null,
  reason: MissingEvidenceReason,
  description: string,
): AssistantMissingEvidence {
  return {
    recordType: slug(recordType),
    recordId: recordId ? recordId.slice(0, 200) : null,
    source,
    reason,
    description: description.slice(0, 500),
  };
}

/**
 * One entry per record and source: the first mention of a read is kept (a module may name the
 * same record again inside one answer), and only a strictly later read replaces it.
 */
export function mergeEvidence(items: readonly AssistantEvidence[]): AssistantEvidence[] {
  const byKey = new Map<string, AssistantEvidence>();
  for (const item of items) {
    const key = `${item.source}|${item.recordType}|${item.recordId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    if (Date.parse(item.observedAt) <= Date.parse(existing.observedAt)) continue;
    // A context observation (changedSinceClientObservation) is kept when a later read lacks one.
    byKey.set(
      key,
      item.changedSinceClientObservation === null
        ? { ...item, changedSinceClientObservation: existing.changedSinceClientObservation }
        : item,
    );
  }
  return [...byKey.values()];
}

export function mergeMissing(
  items: readonly AssistantMissingEvidence[],
): AssistantMissingEvidence[] {
  const byKey = new Map<string, AssistantMissingEvidence>();
  for (const item of items) {
    byKey.set(
      `${item.source ?? ''}|${item.recordType}|${item.recordId ?? ''}|${item.reason}`,
      item,
    );
  }
  return [...byKey.values()];
}

/** The description given for a record the caller may not see (or that does not exist). */
export function notAvailableDescription(recordType: string): string {
  return `The requested ${recordType.replace(/_/g, ' ')} is not available to you; nothing about it was used or disclosed.`;
}
