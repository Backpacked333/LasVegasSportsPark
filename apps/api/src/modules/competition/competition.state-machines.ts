import { defineStateMachine, errors, type StateMachine } from '@sportspark/contracts';
import type {
  CompetitionStatus,
  FixtureStatus,
  JoinRequestStatus,
  SeasonStatus,
  TeamEntryStatus,
  TeamInvitationStatus,
  TeamStatus,
} from '@sportspark/db';

/**
 * Competition lifecycles (§4.6 "each command must define allowed source state"). The check
 * constraints in migration 0400 list exactly these states.
 */

export type CompetitionEvent = 'activate' | 'archive';
export const CompetitionMachine = defineStateMachine<CompetitionStatus, CompetitionEvent>({
  name: 'Competition',
  initial: 'draft',
  states: ['draft', 'active', 'archived'],
  terminal: ['archived'],
  transitions: {
    draft: { activate: 'active', archive: 'archived' },
    active: { archive: 'archived' },
    archived: {},
  },
});

export type SeasonEvent = 'open' | 'activate' | 'complete' | 'archive';
export const SeasonMachine = defineStateMachine<SeasonStatus, SeasonEvent>({
  name: 'Season',
  initial: 'draft',
  states: ['draft', 'open', 'active', 'completed', 'archived'],
  terminal: ['archived'],
  transitions: {
    draft: { open: 'open', archive: 'archived' },
    open: { activate: 'active', archive: 'archived' },
    active: { complete: 'completed', archive: 'archived' },
    completed: { archive: 'archived' },
    archived: {},
  },
});

export type TeamEvent = 'deactivate' | 'reactivate' | 'archive';
export const TeamMachine = defineStateMachine<TeamStatus, TeamEvent>({
  name: 'Team',
  initial: 'active',
  states: ['active', 'inactive', 'archived'],
  terminal: ['archived'],
  transitions: {
    active: { deactivate: 'inactive', archive: 'archived' },
    inactive: { reactivate: 'active', archive: 'archived' },
    archived: {},
  },
});

export type TeamEntryEvent = 'approve' | 'reject' | 'withdraw';
export const TeamEntryMachine = defineStateMachine<TeamEntryStatus, TeamEntryEvent>({
  name: 'TeamEntry',
  initial: 'applied',
  states: ['applied', 'approved', 'withdrawn', 'rejected'],
  terminal: ['withdrawn', 'rejected'],
  transitions: {
    applied: { approve: 'approved', reject: 'rejected', withdraw: 'withdrawn' },
    approved: { withdraw: 'withdrawn' },
    withdrawn: {},
    rejected: {},
  },
});

export type TeamInvitationEvent = 'accept' | 'decline' | 'revoke' | 'expire';
export const TeamInvitationMachine = defineStateMachine<TeamInvitationStatus, TeamInvitationEvent>({
  name: 'TeamInvitation',
  initial: 'pending',
  states: ['pending', 'accepted', 'declined', 'revoked', 'expired'],
  terminal: ['accepted', 'declined', 'revoked', 'expired'],
  transitions: {
    pending: { accept: 'accepted', decline: 'declined', revoke: 'revoked', expire: 'expired' },
    accepted: {},
    declined: {},
    revoked: {},
    expired: {},
  },
});

export type JoinRequestEvent = 'approve' | 'decline' | 'withdraw';
export const JoinRequestMachine = defineStateMachine<JoinRequestStatus, JoinRequestEvent>({
  name: 'JoinRequest',
  initial: 'pending',
  states: ['pending', 'approved', 'declined', 'withdrawn'],
  terminal: ['approved', 'declined', 'withdrawn'],
  transitions: {
    pending: { approve: 'approved', decline: 'declined', withdraw: 'withdrawn' },
    approved: {},
    declined: {},
    withdrawn: {},
  },
});

/**
 * Fixture lifecycle. `record_played`, `forfeit` and `abandon` are driven by results (part 2);
 * a replay after abandonment schedules the fixture again.
 */
export type FixtureEvent =
  'schedule' | 'unschedule' | 'postpone' | 'cancel' | 'record_played' | 'forfeit' | 'abandon';
export const FixtureMachine = defineStateMachine<FixtureStatus, FixtureEvent>({
  name: 'Fixture',
  initial: 'unscheduled',
  states: ['unscheduled', 'scheduled', 'played', 'forfeit', 'canceled', 'abandoned', 'postponed'],
  terminal: ['played', 'forfeit', 'canceled'],
  transitions: {
    unscheduled: { schedule: 'scheduled', cancel: 'canceled', forfeit: 'forfeit' },
    scheduled: {
      unschedule: 'unscheduled',
      postpone: 'postponed',
      cancel: 'canceled',
      record_played: 'played',
      forfeit: 'forfeit',
      abandon: 'abandoned',
    },
    postponed: { schedule: 'scheduled', cancel: 'canceled', forfeit: 'forfeit' },
    abandoned: { schedule: 'scheduled', record_played: 'played', forfeit: 'forfeit' },
    played: {},
    forfeit: {},
    canceled: {},
  },
});

/** The event that moves `from` to `to`, or INVALID_TRANSITION when the machine has none. */
export function eventTo<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  to: S,
): E {
  for (const event of machine.eventsFrom(from)) {
    if (machine.transitions[from][event] === to) return event;
  }
  throw errors.invalidTransition(machine.name, from, `move to ${to}`);
}
