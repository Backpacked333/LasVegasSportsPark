import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  assertKindMatchesDateOfBirth,
  assignmentScopeCovers,
  claimIssuerCoversStaffLogin,
  hashToken,
  isGrantEffective,
  isWithinEffectiveDates,
  newToken,
  normalizeContactValue,
} from './identity.shared';

describe('identity pure rules', () => {
  const now = new Date('2026-10-23T12:00:00Z');

  it('SPK-IAM-003/006: a grant is effective only while unrevoked, unsuspended, dated and on an active relationship', () => {
    const base = {
      effective_from: new Date('2026-01-01T00:00:00Z'),
      effective_to: null,
      revoked_at: null,
      suspended_at: null,
    };
    expect(isGrantEffective(base, 'active', now)).toBe(true);
    expect(isGrantEffective({ ...base, revoked_at: now }, 'active', now)).toBe(false);
    expect(isGrantEffective({ ...base, suspended_at: now }, 'active', now)).toBe(false);
    expect(isGrantEffective(base, 'suspended', now)).toBe(false);
    expect(isGrantEffective(base, 'ended', now)).toBe(false);
    expect(isGrantEffective({ ...base, effective_to: now }, 'active', now)).toBe(false);
    expect(isGrantEffective({ ...base, effective_from: now }, 'active', now)).toBe(true);
    expect(
      isWithinEffectiveDates({ effective_from: '2026-10-23T12:00:01Z', effective_to: null }, now),
    ).toBe(false);
  });

  it('§4.5: age derives from the date of birth, never a stored number', () => {
    expect(ageInYears('2008-10-23', now)).toBe(18);
    expect(ageInYears('2008-10-24', now)).toBe(17);
    expect(() => assertKindMatchesDateOfBirth('adult', '2008-10-24', now)).toThrow(/child/);
    expect(() => assertKindMatchesDateOfBirth('child', '2008-10-23', now)).toThrow(/adult/);
    expect(() => assertKindMatchesDateOfBirth('adult', null, now)).not.toThrow();
    expect(() => assertKindMatchesDateOfBirth('child', '2027-01-01', now)).toThrow(/future/);
  });

  it('tokens are stored as hashes only', () => {
    const token = newToken();
    expect(token).not.toBe(newToken());
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });

  it('normalizes contact values deterministically', () => {
    expect(normalizeContactValue('email', '  Parent@Example.TEST ')).toBe('parent@example.test');
    expect(normalizeContactValue('phone', '+1 (702) 555-0100')).toBe('+17025550100');
  });

  it('§2.1 / §4.14 (R3-SECURITY-01): an assignment scope covers a membership only within its facilities', () => {
    expect(assignmentScopeCovers(null, [])).toBe(true);
    expect(assignmentScopeCovers(null, ['f1', 'f2'])).toBe(true);
    expect(assignmentScopeCovers(['f1'], [])).toBe(false);
    expect(assignmentScopeCovers(['f1'], ['f1'])).toBe(true);
    expect(assignmentScopeCovers(['f1'], ['f1', 'f2'])).toBe(false);
    expect(assignmentScopeCovers([], ['f1'])).toBe(false);
  });

  it('SPK-AT-025 / §2.1: a self claim hands over a staff login only if its issuer administered every facility', () => {
    const admin = { kind: 'staff', staffRoles: ['system_administrator'] };
    expect(claimIssuerCoversStaffLogin({ kind: 'system' }, [[]])).toBe(true);
    expect(
      claimIssuerCoversStaffLogin({ ...admin, staffAssignmentScope: null }, [[], ['f2']]),
    ).toBe(true);
    expect(claimIssuerCoversStaffLogin({ ...admin, staffAssignmentScope: ['f1'] }, [['f1']])).toBe(
      true,
    );
    expect(claimIssuerCoversStaffLogin({ ...admin, staffAssignmentScope: ['f1'] }, [[]])).toBe(
      false,
    );
    expect(
      claimIssuerCoversStaffLogin({ ...admin, staffAssignmentScope: ['f1'] }, [['f1'], ['f2']]),
    ).toBe(false);
    // no recorded scope (an older snapshot) or no assigning role: fails closed
    expect(claimIssuerCoversStaffLogin(admin, [['f1']])).toBe(false);
    expect(
      claimIssuerCoversStaffLogin(
        { kind: 'staff', staffRoles: ['support_operator'], staffAssignmentScope: null },
        [['f1']],
      ),
    ).toBe(false);
    expect(claimIssuerCoversStaffLogin(null, [['f1']])).toBe(false);
  });
});
