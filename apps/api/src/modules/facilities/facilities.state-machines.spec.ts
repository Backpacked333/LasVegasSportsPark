import { describe, expect, it } from 'vitest';
import {
  AssetMachine,
  assetEventFor,
  MaintenanceTaskMachine,
  PreventiveScheduleMachine,
  RestrictionMachine,
  scheduleEventFor,
} from './facilities.state-machines';

describe('facilities state machines (§4.6)', () => {
  it('SPK-FAC-002: a task moves open → assigned → in_progress → resolved → closed and closed is final', () => {
    expect(MaintenanceTaskMachine.next('open', 'assign')).toBe('assigned');
    expect(MaintenanceTaskMachine.next('assigned', 'start')).toBe('in_progress');
    expect(MaintenanceTaskMachine.next('in_progress', 'resolve')).toBe('resolved');
    expect(MaintenanceTaskMachine.next('resolved', 'close')).toBe('closed');
    expect(MaintenanceTaskMachine.isTerminal('closed')).toBe(true);
    expect(MaintenanceTaskMachine.eventsFrom('closed')).toEqual([]);
    expect(() => MaintenanceTaskMachine.next('closed', 'reopen')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('SPK-FAC-004: a failed inspection sends a resolved task back to work; unassigning returns to open', () => {
    expect(MaintenanceTaskMachine.next('resolved', 'fail_inspection')).toBe('in_progress');
    expect(MaintenanceTaskMachine.next('resolved', 'reopen')).toBe('in_progress');
    expect(MaintenanceTaskMachine.next('assigned', 'unassign')).toBe('open');
    expect(MaintenanceTaskMachine.can('open', 'unassign')).toBe(false);
    expect(MaintenanceTaskMachine.can('in_progress', 'fail_inspection')).toBe(false);
  });

  it('SPK-FAC-003/004: a restriction is proposed, approved, activated and released exactly in that order', () => {
    expect(RestrictionMachine.next('proposed', 'approve')).toBe('approved');
    expect(RestrictionMachine.next('approved', 'activate')).toBe('active');
    expect(RestrictionMachine.next('active', 'release')).toBe('released');
    expect(RestrictionMachine.can('proposed', 'release')).toBe(false);
    expect(RestrictionMachine.can('approved', 'release')).toBe(false);
    expect(RestrictionMachine.can('active', 'approve')).toBe(false);
    expect(RestrictionMachine.isTerminal('released')).toBe(true);
  });

  it('SPK-FAC-004 (FAC-01): only a restriction that never took effect is withdrawn; released and withdrawn are final', () => {
    expect(RestrictionMachine.next('proposed', 'withdraw')).toBe('withdrawn');
    expect(RestrictionMachine.next('approved', 'withdraw')).toBe('withdrawn');
    expect(RestrictionMachine.can('active', 'withdraw')).toBe(false);
    expect(RestrictionMachine.can('released', 'withdraw')).toBe(false);
    expect(RestrictionMachine.isTerminal('withdrawn')).toBe(true);
    expect(RestrictionMachine.eventsFrom('withdrawn')).toEqual([]);
    expect(() => RestrictionMachine.next('withdrawn', 'approve')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('SPK-FAC-001: asset and schedule status requests map to machine events', () => {
    expect(AssetMachine.next('in_service', assetEventFor('restricted'))).toBe('restricted');
    expect(AssetMachine.next('restricted', assetEventFor('in_service'))).toBe('in_service');
    expect(AssetMachine.next('out_of_service', assetEventFor('retired'))).toBe('retired');
    expect(AssetMachine.can('retired', 'return_to_service')).toBe(false);
    expect(PreventiveScheduleMachine.next('active', scheduleEventFor('paused'))).toBe('paused');
    expect(PreventiveScheduleMachine.next('paused', scheduleEventFor('active'))).toBe('active');
    expect(PreventiveScheduleMachine.next('paused', scheduleEventFor('ended'))).toBe('ended');
    expect(PreventiveScheduleMachine.can('ended', 'resume')).toBe(false);
  });
});
