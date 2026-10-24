import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_POLICY, policyForFacility } from './entry.policy';
import { PassMachine, SessionCheckinMachine, VisitMachine } from './entry.state-machines';

describe('entry lifecycles (§4.6: every command defines its allowed source state)', () => {
  it('PassMachine: active → revoked, and revoked is final', () => {
    expect(PassMachine.next('active', 'revoke')).toBe('revoked');
    expect(() => PassMachine.next('revoked', 'revoke')).toThrow(/cannot revoke from revoked/);
  });

  it('VisitMachine: on_site → departed | voided, both final', () => {
    expect(VisitMachine.next('on_site', 'depart')).toBe('departed');
    expect(VisitMachine.next('on_site', 'void')).toBe('voided');
    for (const terminal of ['departed', 'voided'] as const) {
      expect(VisitMachine.isTerminal(terminal)).toBe(true);
      expect(VisitMachine.eventsFrom(terminal)).toEqual([]);
    }
  });

  it('SessionCheckinMachine: held is re-evaluated until admitted or withdrawn; admitted can only be withdrawn', () => {
    expect(SessionCheckinMachine.next('held', 'admit')).toBe('admitted');
    expect(SessionCheckinMachine.next('held', 'reevaluate')).toBe('held');
    expect(SessionCheckinMachine.next('held', 'withdraw')).toBe('withdrawn');
    expect(SessionCheckinMachine.next('admitted', 'withdraw')).toBe('withdrawn');
    expect(SessionCheckinMachine.can('admitted', 'reevaluate')).toBe(false);
    expect(SessionCheckinMachine.can('admitted', 'admit')).toBe(false);
    expect(SessionCheckinMachine.eventsFrom('withdrawn')).toEqual([]);
  });
});

describe('entry policy (proposed defaults, §6.6)', () => {
  it('defaults to the specification proposals: two-hour roster, balance informational, no outage procedure', () => {
    expect(DEFAULT_ENTRY_POLICY).toMatchObject({
      maxRosterAgeMinutes: 120,
      blockOnUnrelatedBalance: false,
      approvedOutageProcedures: [],
    });
  });

  it('applies a valid facility override and ignores an invalid block as a whole', () => {
    expect(
      policyForFacility(DEFAULT_ENTRY_POLICY, {
        entry: { maxRosterAgeMinutes: 60, approvedOutageProcedures: ['OUTAGE-1'] },
      }),
    ).toMatchObject({ maxRosterAgeMinutes: 60, approvedOutageProcedures: ['OUTAGE-1'] });
    expect(
      policyForFacility(DEFAULT_ENTRY_POLICY, {
        entry: { maxRosterAgeMinutes: 'soon', approvedOutageProcedures: ['OUTAGE-1'] },
      }),
    ).toBe(DEFAULT_ENTRY_POLICY);
    expect(policyForFacility(DEFAULT_ENTRY_POLICY, {})).toBe(DEFAULT_ENTRY_POLICY);
    expect(policyForFacility(DEFAULT_ENTRY_POLICY, null)).toBe(DEFAULT_ENTRY_POLICY);
  });
});
