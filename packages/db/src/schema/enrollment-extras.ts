import type { Generated } from 'kysely';
import type { GeneratedTimestamp, Json, NullableTimestamp, Timestamp } from './core';

/**
 * Enrollment tables of the proposed amendments PA-03 (SPK-PAY-014: the add-ons of a basket line,
 * migration 0522) and PA-07 (SPK-REG-012: uniform choices, orders and hand-over events, migration
 * 0523). The tier and day selection of a line are columns of `basket_lines` and `enrollments`
 * (migration 0521, `./enrollment.ts`).
 */

/** 0522: one row per add-on (per registration) or per add-on and session (per session). */
export interface BasketLineAddonsTable {
  id: string;
  organization_id: string;
  basket_line_id: string;
  offering_id: string;
  addon_id: string;
  session_id: string | null;
  created_at: GeneratedTimestamp;
}

/** 0523: the uniform and size chosen for a basket line. */
export interface BasketLineUniformsTable {
  id: string;
  organization_id: string;
  basket_line_id: string;
  offering_id: string;
  offering_uniform_id: string;
  size: string;
  created_at: GeneratedTimestamp;
}

export type UniformOrderStatusValue = 'ordered' | 'paid' | 'handed_over' | 'canceled';
/** 0523: UniformOrderMachine; the trigger refuses any other transition. */
export interface UniformOrdersTable {
  id: string;
  organization_id: string;
  enrollment_id: string;
  basket_line_id: string | null;
  offering_id: string;
  offering_uniform_id: string;
  team_entry_id: string | null;
  participant_person_id: string;
  item_key: string;
  name: string;
  size: string;
  price_minor: number | null;
  currency: string | null;
  status: Generated<UniformOrderStatusValue>;
  ordered_at: Timestamp;
  paid_at: NullableTimestamp;
  handed_over_at: NullableTimestamp;
  handed_over_by: Json<Record<string, unknown>> | null;
  handed_over_by_person_id: string | null;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type UniformHandoverEventKind = 'handed_over' | 'correction';
/** 0523: append-only. A correction names the hand-over of the same order it undoes. */
export interface UniformHandoverEventsTable {
  id: string;
  organization_id: string;
  uniform_order_id: string;
  kind: UniformHandoverEventKind;
  corrects_event_id: string | null;
  reason: string | null;
  actor: Json<Record<string, unknown>>;
  actor_person_id: string | null;
  occurred_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface EnrollmentExtrasTables {
  basket_line_addons: BasketLineAddonsTable;
  basket_line_uniforms: BasketLineUniformsTable;
  uniform_orders: UniformOrdersTable;
  uniform_handover_events: UniformHandoverEventsTable;
}
