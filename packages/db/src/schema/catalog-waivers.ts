import type { GeneratedTimestamp, Json, Timestamp } from './core';

/**
 * Catalog waiver tables (migration 0220; SPK-REG-011, proposed amendment PA-01, DEC-095). The
 * acceptance itself is an `acknowledgments` row of a `waiver` policy version (`catalog.ts`).
 */
export interface OfferingRequiredWaiversTable {
  organization_id: string;
  offering_id: string;
  /** The waiver family (policy key), never a version. */
  policy_key: string;
  added_by: Json<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
}

export type WaiverOverrideStatus = 'missing' | 'lapsed';
export type WaiverActivityType = 'offering' | 'offering_session' | 'scheduling_event' | 'booking';
/** Append-only (forbid_mutation): one staff decision to let a person take part despite a block. */
export interface WaiverOverridesTable {
  id: string;
  organization_id: string;
  person_id: string;
  policy_key: string;
  policy_version_id: string | null;
  waiver_status: WaiverOverrideStatus;
  activity_type: WaiverActivityType;
  activity_id: string;
  reason: string;
  actor: Json<Record<string, unknown>>;
  actor_person_id: string;
  occurred_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface CatalogWaiversTables {
  offering_required_waivers: OfferingRequiredWaiversTable;
  waiver_overrides: WaiverOverridesTable;
}
