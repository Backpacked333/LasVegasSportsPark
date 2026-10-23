import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  assertKindMatchesDateOfBirth,
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
});
