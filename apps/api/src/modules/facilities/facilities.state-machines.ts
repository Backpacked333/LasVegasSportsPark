import { defineStateMachine } from '@sportspark/contracts';
import type {
  AssetStatus,
  MaintenanceTaskStatus,
  PreventiveScheduleStatus,
  RestrictionStatus,
} from '@sportspark/db';

/**
 * Facilities lifecycles (§4.6 "each command must define allowed source state"). The database check
 * constraints in migration 0900 list exactly these states.
 */

export type MaintenanceTaskEvent =
  'assign' | 'unassign' | 'start' | 'resolve' | 'close' | 'reopen' | 'fail_inspection';
/**
 * A task is reported open, may be assigned an owner, worked on, resolved and closed. A failed
 * inspection sends a resolved task back to work; a closed task is final (a new task references
 * it). Closing never releases an operating restriction (SPK-FAC-004).
 */
export const MaintenanceTaskMachine = defineStateMachine<
  MaintenanceTaskStatus,
  MaintenanceTaskEvent
>({
  name: 'MaintenanceTask',
  initial: 'open',
  states: ['open', 'assigned', 'in_progress', 'resolved', 'closed'],
  terminal: ['closed'],
  transitions: {
    open: { assign: 'assigned', start: 'in_progress', resolve: 'resolved', close: 'closed' },
    assigned: {
      assign: 'assigned',
      unassign: 'open',
      start: 'in_progress',
      resolve: 'resolved',
      close: 'closed',
    },
    in_progress: {
      assign: 'in_progress',
      unassign: 'in_progress',
      resolve: 'resolved',
      close: 'closed',
    },
    resolved: {
      assign: 'resolved',
      close: 'closed',
      reopen: 'in_progress',
      fail_inspection: 'in_progress',
    },
    closed: {},
  },
});

export type RestrictionEvent = 'approve' | 'activate' | 'release';
/**
 * proposed → approved (authority recorded) → active (scheduling closure applied, availability
 * affected: SPK-FAC-003) → released (authorized return to service lifted the closure: SPK-FAC-004).
 */
export const RestrictionMachine = defineStateMachine<RestrictionStatus, RestrictionEvent>({
  name: 'Restriction',
  initial: 'proposed',
  states: ['proposed', 'approved', 'active', 'released'],
  terminal: ['released'],
  transitions: {
    proposed: { approve: 'approved' },
    approved: { activate: 'active' },
    active: { release: 'released' },
    released: {},
  },
});

export type AssetEvent = 'restrict' | 'return_to_service' | 'take_out_of_service' | 'retire';
export const AssetMachine = defineStateMachine<AssetStatus, AssetEvent>({
  name: 'Asset',
  initial: 'in_service',
  states: ['in_service', 'restricted', 'out_of_service', 'retired'],
  terminal: ['retired'],
  transitions: {
    in_service: {
      restrict: 'restricted',
      take_out_of_service: 'out_of_service',
      retire: 'retired',
    },
    restricted: {
      return_to_service: 'in_service',
      take_out_of_service: 'out_of_service',
      retire: 'retired',
    },
    out_of_service: { return_to_service: 'in_service', restrict: 'restricted', retire: 'retired' },
    retired: {},
  },
});

export type PreventiveScheduleEvent = 'pause' | 'resume' | 'end';
export const PreventiveScheduleMachine = defineStateMachine<
  PreventiveScheduleStatus,
  PreventiveScheduleEvent
>({
  name: 'PreventiveSchedule',
  initial: 'active',
  states: ['active', 'paused', 'ended'],
  terminal: ['ended'],
  transitions: {
    active: { pause: 'paused', end: 'ended' },
    paused: { resume: 'active', end: 'ended' },
    ended: {},
  },
});

/** Maps a requested asset status to the machine event that reaches it. */
export function assetEventFor(to: AssetStatus): AssetEvent {
  switch (to) {
    case 'in_service':
      return 'return_to_service';
    case 'restricted':
      return 'restrict';
    case 'out_of_service':
      return 'take_out_of_service';
    case 'retired':
      return 'retire';
  }
}

/** Maps a requested schedule status to the machine event that reaches it. */
export function scheduleEventFor(to: PreventiveScheduleStatus): PreventiveScheduleEvent {
  switch (to) {
    case 'active':
      return 'resume';
    case 'paused':
      return 'pause';
    case 'ended':
      return 'end';
  }
}
