import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_POLICY, policyForFacility } from './entry.policy';
import {
  AccessDeviceMachine,
  AccessPolicyMachine,
  DeviceCommandMachine,
  PassMachine,
  SessionCheckinMachine,
  VisitMachine,
} from './entry.state-machines';

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

  it('ENT-05 AccessDeviceMachine: active → retired, final', () => {
    expect(AccessDeviceMachine.next('active', 'retire')).toBe('retired');
    expect(AccessDeviceMachine.can('retired', 'retire')).toBe(false);
  });

  it('ENT-05 AccessPolicyMachine: a draft is approved or withdrawn; an active policy only retires', () => {
    expect(AccessPolicyMachine.next('draft', 'approve')).toBe('active');
    expect(AccessPolicyMachine.next('draft', 'withdraw')).toBe('retired');
    expect(AccessPolicyMachine.next('active', 'retire')).toBe('retired');
    expect(AccessPolicyMachine.can('active', 'approve')).toBe(false);
    expect(AccessPolicyMachine.can('draft', 'retire')).toBe(false);
    expect(AccessPolicyMachine.eventsFrom('retired')).toEqual([]);
  });

  it('ENT-05 DeviceCommandMachine: failed and unknown retry, a receipt settles pending or unknown, delivered is final', () => {
    expect(DeviceCommandMachine.next('pending', 'deliver')).toBe('delivered');
    expect(DeviceCommandMachine.next('pending', 'fail')).toBe('failed');
    expect(DeviceCommandMachine.next('pending', 'lose')).toBe('unknown');
    expect(DeviceCommandMachine.next('unknown', 'deliver')).toBe('delivered');
    expect(DeviceCommandMachine.next('unknown', 'retry')).toBe('pending');
    expect(DeviceCommandMachine.next('failed', 'retry')).toBe('pending');
    expect(DeviceCommandMachine.can('failed', 'deliver')).toBe(false);
    expect(DeviceCommandMachine.next('failed', 'supersede')).toBe('superseded');
    expect(DeviceCommandMachine.eventsFrom('delivered')).toEqual([]);
    expect(DeviceCommandMachine.eventsFrom('superseded')).toEqual([]);
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
