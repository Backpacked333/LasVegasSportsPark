import { describe, expect, it } from 'vitest';
import { equivalenceKey, periodKeyForDates } from './equivalence-key';

const ctx = {
  offeringId: 'off-1',
  programId: 'prog-1',
  participantPersonId: 'person-1',
};

describe('equivalence keys (§4.7 invariant 2)', () => {
  it('scopes the key to the offering, program, program period or session', () => {
    expect(
      equivalenceKey({ kind: 'seat', equivalenceScope: 'offering', equivalenceRule: {} }, ctx),
    ).toBe('seat|offering:off-1|person:person-1');
    expect(
      equivalenceKey(
        { kind: 'roster_place', equivalenceScope: 'program', equivalenceRule: {} },
        ctx,
      ),
    ).toBe('roster_place|program:prog-1|person:person-1');
    expect(
      equivalenceKey(
        { kind: 'seat', equivalenceScope: 'program_period', equivalenceRule: {} },
        { ...ctx, periodKey: periodKeyForDates('2027-01-10', '2027-03-07') },
      ),
    ).toBe('seat|program:prog-1|period:2027-01-10..2027-03-07|person:person-1');
    expect(
      equivalenceKey(
        { kind: 'session_seat', equivalenceScope: 'session', equivalenceRule: {} },
        { ...ctx, sessionId: 's-9' },
      ),
    ).toBe('session_seat|session:s-9|person:person-1');
  });

  it('scope none permits duplicates; missing context is an error, never a silent collision', () => {
    expect(
      equivalenceKey(
        { kind: 'package_credits', equivalenceScope: 'none', equivalenceRule: {} },
        ctx,
      ),
    ).toBeNull();
    expect(() =>
      equivalenceKey(
        { kind: 'seat', equivalenceScope: 'program_period', equivalenceRule: {} },
        ctx,
      ),
    ).toThrow(/periodKey/);
    expect(() =>
      equivalenceKey({ kind: 'seat', equivalenceScope: 'session', equivalenceRule: {} }, ctx),
    ).toThrow(/sessionId/);
  });

  it('two different participants never share a key', () => {
    const def = {
      kind: 'seat' as const,
      equivalenceScope: 'offering' as const,
      equivalenceRule: {},
    };
    expect(equivalenceKey(def, ctx)).not.toBe(
      equivalenceKey(def, { ...ctx, participantPersonId: 'person-2' }),
    );
  });
});
