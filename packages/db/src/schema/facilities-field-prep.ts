import type { Generated } from 'kysely';
import type { GeneratedTimestamp, Json, NullableTimestamp } from './core';
import type { DateOnly } from './identity';

/**
 * Facilities module: the field crew's daily pitch preparation (migration 0975, SPK-FAC-001,
 * SPK-UX-006, SPK-READY-001 field readiness). One record per pitch and facility-local day.
 */
export type FieldPreparationItem = 'lines' | 'goals_anchored' | 'nets' | 'corner_flags';
export type FieldPreparationStatus = 'in_progress' | 'ready';

export interface FieldPreparationsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  resource_id: string;
  local_date: DateOnly;
  checked_items: Generated<FieldPreparationItem[]>;
  status: Generated<FieldPreparationStatus>;
  ready_at: NullableTimestamp;
  ready_by: Json<Record<string, unknown>> | null;
  ready_by_person_id: string | null;
  updated_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FacilitiesFieldPrepTables {
  field_preparations: FieldPreparationsTable;
}
