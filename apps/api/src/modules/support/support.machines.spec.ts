import { describe, expect, it } from 'vitest';
import { CaseActionMachine, CaseMachine, type CaseEvent } from './support.machines';

describe('support state machines (§4.6)', () => {
  it('SPK-SUPPORT-002: CaseMachine transitions match the case lifecycle in migration 1100', () => {
    const pairs = new Set<string>();
    for (const from of CaseMachine.states) {
      for (const event of CaseMachine.eventsFrom(from)) {
        pairs.add(`${from}->${CaseMachine.next(from, event as CaseEvent)}`);
      }
    }
    // Exactly the pairs the `cases_guard` trigger allows.
    expect([...pairs].sort()).toEqual(
      [
        'open->waiting_customer',
        'open->waiting_internal',
        'open->resolved',
        'waiting_customer->open',
        'waiting_customer->waiting_internal',
        'waiting_customer->resolved',
        'waiting_internal->open',
        'waiting_internal->waiting_customer',
        'waiting_internal->resolved',
        'resolved->open',
        'resolved->closed',
      ].sort(),
    );
    expect(CaseMachine.isTerminal('closed')).toBe(true);
    expect(() => CaseMachine.next('open', 'close')).toThrow(/cannot close from open/);
    expect(() => CaseMachine.next('closed', 'reopen')).toThrow();
  });

  it('SPK-SUPPORT-003: a helper action ends succeeded or failed; unknown is resolved later, never assumed', () => {
    expect(CaseActionMachine.next('requested', 'succeed')).toBe('succeeded');
    expect(CaseActionMachine.next('requested', 'fail')).toBe('failed');
    expect(CaseActionMachine.next('requested', 'lose_outcome')).toBe('unknown');
    expect(CaseActionMachine.next('unknown', 'succeed')).toBe('succeeded');
    expect(CaseActionMachine.next('unknown', 'fail')).toBe('failed');
    expect(() => CaseActionMachine.next('unknown', 'lose_outcome')).toThrow();
    expect(() => CaseActionMachine.next('succeeded', 'fail')).toThrow();
    expect(() => CaseActionMachine.next('failed', 'succeed')).toThrow();
  });
});
