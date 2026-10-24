import { defineStateMachine } from '@sportspark/contracts';

/**
 * Entry lifecycles (§4.6 asks every command to define its allowed source state). The database
 * guards in migration 0800 (`passes_guard`, `visits_guard`, `session_checkins_guard`) refuse the
 * same transitions these machines refuse. Observations, departures, releases, offline batches and
 * occupancy snapshots are append-only facts and have no lifecycle.
 */

export type PassState = 'active' | 'revoked';
export type PassEvent = 'revoke';
export const PassMachine = defineStateMachine<PassState, PassEvent>({
  name: 'Pass',
  initial: 'active',
  states: ['active', 'revoked'],
  terminal: ['revoked'],
  transitions: { active: { revoke: 'revoked' }, revoked: {} },
});

export type VisitState = 'on_site' | 'departed' | 'voided';
export type VisitEvent = 'depart' | 'void';
export const VisitMachine = defineStateMachine<VisitState, VisitEvent>({
  name: 'Visit',
  initial: 'on_site',
  states: ['on_site', 'departed', 'voided'],
  terminal: ['departed', 'voided'],
  transitions: {
    on_site: { depart: 'departed', void: 'voided' },
    departed: {},
    voided: {},
  },
});

/**
 * A check-in starts `held` (blocking issues) or `admitted` (none). A held check-in is re-evaluated
 * until it is admitted or withdrawn; an admitted one can only be withdrawn.
 */
export type SessionCheckinState = 'held' | 'admitted' | 'withdrawn';
export type SessionCheckinEvent = 'admit' | 'reevaluate' | 'withdraw';
export const SessionCheckinMachine = defineStateMachine<SessionCheckinState, SessionCheckinEvent>({
  name: 'SessionCheckin',
  initial: 'held',
  states: ['held', 'admitted', 'withdrawn'],
  terminal: ['withdrawn'],
  transitions: {
    held: { admit: 'admitted', reevaluate: 'held', withdraw: 'withdrawn' },
    admitted: { withdraw: 'withdrawn' },
    withdrawn: {},
  },
});
