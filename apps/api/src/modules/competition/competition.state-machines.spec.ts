import { describe, expect, it } from 'vitest';
import {
  CompetitionMachine,
  FixtureMachine,
  JoinRequestMachine,
  SeasonMachine,
  TeamEntryMachine,
  TeamInvitationMachine,
  TeamMachine,
  eventTo,
} from './competition.state-machines';

/** §4.6: every command names its allowed source state; nothing moves a record backwards from a terminal state. */
describe('competition state machines (§4.6)', () => {
  it('Season: draft → open → active → completed → archived, never backwards', () => {
    expect(SeasonMachine.next('draft', 'open')).toBe('open');
    expect(SeasonMachine.next('open', 'activate')).toBe('active');
    expect(SeasonMachine.next('active', 'complete')).toBe('completed');
    expect(SeasonMachine.next('completed', 'archive')).toBe('archived');
    expect(SeasonMachine.can('open', 'complete')).toBe(false);
    expect(() => SeasonMachine.next('archived', 'open')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
    expect(SeasonMachine.isTerminal('archived')).toBe(true);
    expect(eventTo(SeasonMachine, 'draft', 'open')).toBe('open');
    expect(() => eventTo(SeasonMachine, 'draft', 'completed')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('TeamEntry (SPK-COMP-004): applied → approved | rejected | withdrawn; approved → withdrawn only', () => {
    expect(TeamEntryMachine.next('applied', 'approve')).toBe('approved');
    expect(TeamEntryMachine.next('applied', 'reject')).toBe('rejected');
    expect(TeamEntryMachine.next('applied', 'withdraw')).toBe('withdrawn');
    expect(TeamEntryMachine.next('approved', 'withdraw')).toBe('withdrawn');
    expect(TeamEntryMachine.can('approved', 'approve')).toBe(false);
    expect(TeamEntryMachine.can('approved', 'reject')).toBe(false);
    expect(TeamEntryMachine.eventsFrom('rejected')).toEqual([]);
    expect(TeamEntryMachine.eventsFrom('withdrawn')).toEqual([]);
  });

  it('Competition and Team lifecycles', () => {
    expect(CompetitionMachine.next('draft', 'activate')).toBe('active');
    expect(CompetitionMachine.next('active', 'archive')).toBe('archived');
    expect(CompetitionMachine.can('archived', 'activate')).toBe(false);
    expect(TeamMachine.next('active', 'deactivate')).toBe('inactive');
    expect(TeamMachine.next('inactive', 'reactivate')).toBe('active');
    expect(TeamMachine.next('inactive', 'archive')).toBe('archived');
    expect(TeamMachine.eventsFrom('archived')).toEqual([]);
  });

  it('TeamInvitation and JoinRequest resolve exactly once', () => {
    for (const event of ['accept', 'decline', 'revoke', 'expire'] as const) {
      const to = TeamInvitationMachine.next('pending', event);
      expect(TeamInvitationMachine.isTerminal(to)).toBe(true);
      expect(TeamInvitationMachine.eventsFrom(to)).toEqual([]);
    }
    for (const event of ['approve', 'decline', 'withdraw'] as const) {
      const to = JoinRequestMachine.next('pending', event);
      expect(JoinRequestMachine.isTerminal(to)).toBe(true);
    }
    expect(() => TeamInvitationMachine.next('accepted', 'revoke')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('Fixture: unscheduled ↔ scheduled, postponed and abandoned return to scheduled, outcomes are terminal', () => {
    expect(FixtureMachine.next('unscheduled', 'schedule')).toBe('scheduled');
    expect(FixtureMachine.next('scheduled', 'unschedule')).toBe('unscheduled');
    expect(FixtureMachine.next('scheduled', 'postpone')).toBe('postponed');
    expect(FixtureMachine.next('postponed', 'schedule')).toBe('scheduled');
    expect(FixtureMachine.next('scheduled', 'abandon')).toBe('abandoned');
    expect(FixtureMachine.next('abandoned', 'schedule')).toBe('scheduled');
    expect(FixtureMachine.next('scheduled', 'record_played')).toBe('played');
    expect(FixtureMachine.next('scheduled', 'forfeit')).toBe('forfeit');
    expect(FixtureMachine.next('scheduled', 'cancel')).toBe('canceled');
    for (const terminal of ['played', 'forfeit', 'canceled'] as const) {
      expect(FixtureMachine.isTerminal(terminal)).toBe(true);
      expect(FixtureMachine.eventsFrom(terminal)).toEqual([]);
    }
    expect(FixtureMachine.can('unscheduled', 'record_played')).toBe(false);
    expect(FixtureMachine.can('unscheduled', 'postpone')).toBe(false);
  });
});
