import { DomainError } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  ImportBatchMachine,
  ImportExceptionMachine,
  ReconciliationApprovalMachine,
} from './migration.machines';

describe('ImportBatchMachine (§5.4)', () => {
  it('received → validated → reviewed → applied, with re-validation and abort', () => {
    expect(ImportBatchMachine.next('received', 'validate')).toBe('validated');
    expect(ImportBatchMachine.next('validated', 'validate')).toBe('validated');
    expect(ImportBatchMachine.next('validated', 'review')).toBe('reviewed');
    expect(ImportBatchMachine.next('reviewed', 'validate')).toBe('validated');
    expect(ImportBatchMachine.next('reviewed', 'apply')).toBe('applied');
    for (const from of ['received', 'validated', 'reviewed'] as const) {
      expect(ImportBatchMachine.next(from, 'abort')).toBe('aborted');
    }
  });

  it('refuses shortcuts and anything from a terminal state', () => {
    expect(() => ImportBatchMachine.next('received', 'apply')).toThrow(DomainError);
    expect(() => ImportBatchMachine.next('received', 'review')).toThrow(DomainError);
    expect(() => ImportBatchMachine.next('validated', 'apply')).toThrow(DomainError);
    for (const event of ['validate', 'review', 'apply', 'abort'] as const) {
      expect(ImportBatchMachine.can('applied', event)).toBe(false);
      expect(ImportBatchMachine.can('aborted', event)).toBe(false);
    }
    expect(ImportBatchMachine.terminal).toEqual(['applied', 'aborted']);
  });
});

describe('ImportExceptionMachine and ReconciliationApprovalMachine', () => {
  it('decide or withdraw once; approve, reject or supersede once', () => {
    expect(ImportExceptionMachine.next('open', 'decide')).toBe('decided');
    expect(ImportExceptionMachine.next('open', 'withdraw')).toBe('withdrawn');
    expect(() => ImportExceptionMachine.next('decided', 'decide')).toThrow(DomainError);
    expect(() => ImportExceptionMachine.next('withdrawn', 'decide')).toThrow(DomainError);
    expect(ReconciliationApprovalMachine.next('pending', 'approve')).toBe('approved');
    expect(ReconciliationApprovalMachine.next('pending', 'reject')).toBe('rejected');
    expect(ReconciliationApprovalMachine.next('pending', 'supersede')).toBe('superseded');
    expect(() => ReconciliationApprovalMachine.next('approved', 'reject')).toThrow(DomainError);
  });
});
