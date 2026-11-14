import type { Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  MinorUnits,
  NullableTimestamp,
} from './core';

/**
 * Catalog tables of the proposed amendments PA-03 (SPK-PAY-014: price tiers and add-ons,
 * migrations 0215 and 0216) and PA-07 (SPK-REG-012: uniforms, migration 0217). Each is behind
 * its organization capability (`price_tiers_addons`, `uniforms`; DEC-016).
 */

export type PriceTierAttendance = 'all_sessions' | 'chosen_sessions';
/** 0215: immutable pricing content of a price rule (no update, no delete). */
export interface PriceRuleTiersTable {
  id: string;
  organization_id: string;
  price_rule_id: string;
  offering_id: string;
  code: string;
  name: string;
  sequence: number;
  attendance: PriceTierAttendance;
  min_sessions: number | null;
  max_sessions: number | null;
  price_minor: MinorUnits;
  member_price_minor: number | null;
  available_until: NullableTimestamp;
  created_at: GeneratedTimestamp;
}

export type AddonSelection = 'per_registration' | 'per_session';
export type OfferingExtraStatus = 'active' | 'retired';
/** 0216: price, selection and capacity are immutable; only name, description and status move. */
export interface OfferingAddonsTable {
  id: string;
  organization_id: string;
  offering_id: string;
  code: string;
  name: string;
  description: string | null;
  price_minor: MinorUnits;
  currency: string;
  charge_lines: GeneratedJson<unknown[]>;
  selection: Generated<AddonSelection>;
  capacity: number | null;
  status: Generated<OfferingExtraStatus>;
  retired_at: Generated<Date | null>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type UniformRequirement = 'required' | 'optional';
/** 0217: item key, sizes, price and the returning-holder rule are immutable. */
export interface OfferingUniformsTable {
  id: string;
  organization_id: string;
  offering_id: string;
  item_key: string;
  name: string;
  sizes: Json<string[]>;
  requirement: Generated<UniformRequirement>;
  price_minor: number | null;
  currency: string | null;
  charge_lines: GeneratedJson<unknown[]>;
  returning_holder_free: Generated<boolean>;
  status: Generated<OfferingExtraStatus>;
  retired_at: Generated<Date | null>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CatalogExtrasTables {
  price_rule_tiers: PriceRuleTiersTable;
  offering_addons: OfferingAddonsTable;
  offering_uniforms: OfferingUniformsTable;
}
