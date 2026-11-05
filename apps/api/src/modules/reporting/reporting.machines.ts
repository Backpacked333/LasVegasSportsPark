import { defineStateMachine, type StateMachine } from '@sportspark/contracts';

/**
 * Module lifecycles (§4.6 "each command must define allowed source state"). The check constraints
 * and guard triggers of migration 1300 list the same states and transitions.
 */

export type ExportState = 'ready' | 'downloaded' | 'expired' | 'revoked';
export type ExportEvent = 'download' | 'expire' | 'revoke';

/**
 * Export (SPK-REPORT-007, §4.14 "Expiring exports"): single use. A ready export is downloaded once
 * by its requester before it expires, expires unused, or is revoked; every other state is final.
 */
export const ExportMachine: StateMachine<ExportState, ExportEvent> = defineStateMachine<
  ExportState,
  ExportEvent
>({
  name: 'Export',
  initial: 'ready',
  states: ['ready', 'downloaded', 'expired', 'revoked'],
  terminal: ['downloaded', 'expired', 'revoked'],
  transitions: {
    ready: { download: 'downloaded', expire: 'expired', revoke: 'revoked' },
    downloaded: {},
    expired: {},
    revoked: {},
  },
});

export type CostInputState = 'active' | 'withdrawn';
export type CostInputEvent = 'withdraw';

/** Agreed cost input (SPK-REPORT-004): withdrawn once, never edited (record a new input instead). */
export const CostInputMachine: StateMachine<CostInputState, CostInputEvent> = defineStateMachine<
  CostInputState,
  CostInputEvent
>({
  name: 'CostInput',
  initial: 'active',
  states: ['active', 'withdrawn'],
  terminal: ['withdrawn'],
  transitions: { active: { withdraw: 'withdrawn' }, withdrawn: {} },
});

export type MetricDefinitionState = 'active' | 'superseded';
export type MetricDefinitionEvent = 'supersede';

/** Metric definition version (SPK-REPORT-001): a changed definition supersedes the active one. */
export const MetricDefinitionMachine: StateMachine<MetricDefinitionState, MetricDefinitionEvent> =
  defineStateMachine<MetricDefinitionState, MetricDefinitionEvent>({
    name: 'MetricDefinition',
    initial: 'active',
    states: ['active', 'superseded'],
    terminal: ['superseded'],
    transitions: { active: { supersede: 'superseded' }, superseded: {} },
  });
