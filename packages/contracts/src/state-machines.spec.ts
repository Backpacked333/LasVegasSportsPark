import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import {
  ALL_STATE_MACHINES,
  CheckoutMachine,
  HoldMachine,
  PaymentAttemptMachine,
  ResultMachine,
  defineStateMachine,
  type StateMachine,
} from './state-machines';

describe('state machines (§4.6)', () => {
  it('every machine has an initial state, terminal states with no exits, and reachable states', () => {
    for (const machine of ALL_STATE_MACHINES as readonly StateMachine<string, string>[]) {
      expect(machine.states).toContain(machine.initial);
      for (const t of machine.terminal) {
        expect(machine.eventsFrom(t)).toEqual([]);
      }
      const reachable = new Set<string>([machine.initial]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const s of [...reachable]) {
          for (const to of Object.values(machine.transitions[s as never] ?? {}) as string[]) {
            if (!reachable.has(to)) {
              reachable.add(to);
              grew = true;
            }
          }
        }
      }
      expect([...reachable].sort()).toEqual([...machine.states].sort());
    }
  });

  it('holds have exactly one terminal outcome (SPK-REG-006)', () => {
    expect(HoldMachine.next('active', 'commit')).toBe('committed');
    expect(() => HoldMachine.next('committed', 'release')).toThrow(DomainError);
    expect(() => HoldMachine.next('expired', 'commit')).toThrow(/cannot commit from expired/);
  });

  it('unknown payment outcomes resolve only to authoritative terminal states (SPK-PAY-007)', () => {
    expect(PaymentAttemptMachine.next('processing', 'lose_track')).toBe('unknown');
    expect(PaymentAttemptMachine.eventsFrom('unknown').sort()).toEqual([
      'cancel',
      'fail',
      'succeed',
    ]);
    expect(PaymentAttemptMachine.can('unknown', 'process')).toBe(false);
  });

  it('checkout keeps provider success with local failure visible as recovery_required (§4.11)', () => {
    const s1 = CheckoutMachine.next('prepared', 'initiate_payment');
    const s2 = CheckoutMachine.next(s1, 'payment_succeeded');
    const s3 = CheckoutMachine.next(s2, 'finalization_failed');
    expect(s3).toBe('recovery_required');
    expect(CheckoutMachine.eventsFrom('recovery_required').sort()).toEqual([
      'compensate',
      'recovered',
    ]);
  });

  it('results never go backwards from official (SPK-RESULT-001)', () => {
    expect(ResultMachine.next('official', 'supersede')).toBe('superseded');
    expect(ResultMachine.can('official', 'return_for_correction')).toBe(false);
    expect(ResultMachine.can('superseded', 'publish')).toBe(false);
  });

  it('rejects definitions with unknown states', () => {
    expect(() =>
      defineStateMachine({
        name: 'Broken',
        initial: 'a',
        states: ['a'],
        terminal: [],
        transitions: { a: { go: 'b' } } as never,
      }),
    ).toThrow(/unknown target state/);
  });
});
