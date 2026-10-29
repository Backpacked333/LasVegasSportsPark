import { defineStateMachine } from './state-machines';
import { z } from './zod';

/**
 * Conditional capabilities (§1.6, §6.5 Package G; K-12, IF-30). Whether the complex uses each one
 * is pending: DEC-016 decides applicability for all of them, and most have their own Register E
 * record (DEC-072 to DEC-082). A capability is a per-organization switch that defaults to off; only
 * a system administrator changes it, naming one of its applicability references, and every change
 * is audited and kept in an append-only history (migration 0011).
 *
 * - `commands`: commands that create a new commitment of the capability call
 *   `CapabilityService.require`; reads, cancellations, declines, refunds, reversals, settlements,
 *   retirements, ends, reconciliations, expiry jobs and provider outcomes never do (overview.md,
 *   Proposed).
 * - `recorded_only`: the switch and its history only; nothing checks it (shipped behaviour whose
 *   enforcement is itself a DEC-016 question, or a capability whose commands wait for a decision).
 */
export const CAPABILITY_IDS = [
  'memberships',
  'session_packages',
  'rentals',
  'parties',
  'tournaments',
  'point_of_sale',
  'access_hardware',
  'accounting',
  'youth_progression',
  'pickup_sessions',
  'assistant',
  'installments',
  'supervised_pickup',
  'advanced_fairness',
  'retention_tools',
] as const;

export const CapabilityIdSchema = z.enum(CAPABILITY_IDS).openapi('CapabilityId');
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const CapabilityEnforcementSchema = z
  .enum(['commands', 'recorded_only'])
  .openapi('CapabilityEnforcement');
export type CapabilityEnforcement = z.infer<typeof CapabilityEnforcementSchema>;

export interface CapabilityDefinition {
  /** The decisions whose answer may enable or disable it: DEC-016 and its own Register E record. */
  applicabilityReferences: readonly string[];
  /** Decisions that shape it but never enable it (shown only). */
  relatedDecisions: readonly string[];
  enforcement: CapabilityEnforcement;
  /** The modules whose commands check it. */
  owningModules: readonly string[];
  description: string;
}

export const CAPABILITIES: Readonly<Record<CapabilityId, CapabilityDefinition>> = {
  memberships: {
    applicabilityReferences: ['DEC-016', 'DEC-072'],
    relatedDecisions: ['POL-038'],
    enforcement: 'commands',
    owningModules: ['catalog', 'enrollment'],
    description:
      'Memberships with included sessions, terms and renewal notices (§3.16, SPK-COND-001)',
  },
  session_packages: {
    applicabilityReferences: ['DEC-016', 'DEC-074'],
    relatedDecisions: ['POL-039', 'POL-007'],
    enforcement: 'commands',
    owningModules: ['catalog', 'enrollment'],
    description: 'Session packages: purchased credits redeemed against sessions (SPK-COND-002)',
  },
  rentals: {
    applicabilityReferences: ['DEC-016', 'DEC-076'],
    relatedDecisions: [],
    enforcement: 'commands',
    owningModules: ['catalog', 'enrollment'],
    description: 'Field and resource rentals with booking terms (§3.16)',
  },
  parties: {
    applicabilityReferences: ['DEC-016', 'DEC-077'],
    relatedDecisions: ['POL-040'],
    enforcement: 'commands',
    owningModules: ['catalog', 'enrollment'],
    description: 'Party packages: resources, equipment, host staffing and terms (SPK-COND-003)',
  },
  tournaments: {
    applicabilityReferences: ['DEC-016', 'DEC-078'],
    relatedDecisions: [],
    enforcement: 'commands',
    owningModules: ['competition'],
    description: 'Tournament competitions (§3.16)',
  },
  point_of_sale: {
    applicabilityReferences: ['DEC-016', 'DEC-079'],
    relatedDecisions: ['DEC-057', 'DEC-019', 'POL-018'],
    enforcement: 'commands',
    owningModules: ['finance'],
    description: 'Point of sale: products, registers, sales and tenders (§3.16)',
  },
  access_hardware: {
    applicabilityReferences: ['DEC-016', 'DEC-080'],
    relatedDecisions: ['DEC-023', 'DEC-032'],
    enforcement: 'commands',
    owningModules: ['entry'],
    description: 'Access devices and their policies (§3.16, SPK-COND-004)',
  },
  accounting: {
    applicabilityReferences: ['DEC-016', 'DEC-081'],
    relatedDecisions: ['DEC-022'],
    enforcement: 'commands',
    owningModules: ['finance'],
    description: 'Accounting mappings and export batches (§3.16, SPK-PAY-010, SPK-PAY-011)',
  },
  youth_progression: {
    applicabilityReferences: ['DEC-016'],
    relatedDecisions: ['DEC-003', 'DEC-054', 'DEC-055'],
    enforcement: 'commands',
    owningModules: ['enrollment'],
    description: 'Youth assessments and progression recommendations (SPK-YOUTH-005, SPK-YOUTH-006)',
  },
  pickup_sessions: {
    applicabilityReferences: ['DEC-016', 'DEC-082'],
    relatedDecisions: [],
    enforcement: 'commands',
    owningModules: ['enrollment'],
    description: 'Pickup sessions booked individually (SPK-PLACE-004, §6.5 Package G "Pickup")',
  },
  assistant: {
    applicabilityReferences: ['DEC-016'],
    relatedDecisions: ['DEC-013'],
    enforcement: 'commands',
    owningModules: ['automation'],
    description: 'Reviewable operational assistance (SPK-AUTO-001 to SPK-AUTO-005)',
  },
  installments: {
    applicabilityReferences: ['DEC-016', 'DEC-073'],
    relatedDecisions: ['DEC-008'],
    enforcement: 'recorded_only',
    owningModules: ['finance'],
    description:
      'Installment plans (shipped in Package D; whether the switch is enforced is a DEC-016 question)',
  },
  supervised_pickup: {
    applicabilityReferences: ['DEC-016', 'DEC-075'],
    relatedDecisions: ['DEC-005'],
    enforcement: 'recorded_only',
    owningModules: ['entry'],
    description:
      'Supervised pickup and release (shipped in Package E; whether the switch is enforced is a DEC-016 question)',
  },
  advanced_fairness: {
    applicabilityReferences: ['DEC-016'],
    relatedDecisions: ['DEC-049', 'POL-042'],
    enforcement: 'recorded_only',
    owningModules: ['competition'],
    description:
      'Advanced fixture fairness preferences (SPK-FIX-003; no command until DEC-049 is answered)',
  },
  retention_tools: {
    applicabilityReferences: ['DEC-016'],
    relatedDecisions: [],
    enforcement: 'recorded_only',
    owningModules: ['reporting'],
    description: 'Retention reads and tools (SPK-REPORT-005)',
  },
};

/** A decision reference as recorded on a change: `DEC-` and three digits. */
export const DecisionReferenceSchema = z
  .string()
  .regex(/^DEC-[0-9]{3}$/, 'a decision reference such as DEC-016')
  .openapi('DecisionReference');

/**
 * The switch's lifecycle (kernel-local machine, Proposed beside §4.6, DEC-093): `disabled` (no
 * row, or the last change disabled it) and `enabled`. Enabling an enabled switch, or disabling a
 * disabled one, is INVALID_TRANSITION, so every recorded change is a real change.
 */
export type CapabilitySwitchState = 'disabled' | 'enabled';
export type CapabilitySwitchEvent = 'enable' | 'disable';
export const CapabilitySwitchMachine = defineStateMachine<
  CapabilitySwitchState,
  CapabilitySwitchEvent
>({
  name: 'CapabilitySwitch',
  initial: 'disabled',
  states: ['disabled', 'enabled'],
  terminal: [],
  transitions: {
    disabled: { enable: 'enabled' },
    enabled: { disable: 'disabled' },
  },
});
