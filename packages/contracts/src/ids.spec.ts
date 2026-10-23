import { describe, expect, it } from 'vitest';
import { isUuid, newId } from './ids';

describe('ids', () => {
  it('generates RFC 9562 version 7 uuids that sort by time', () => {
    const a = newId(1_000_000);
    const b = newId(2_000_000);
    expect(isUuid(a)).toBe(true);
    expect(a.charAt(14)).toBe('7');
    expect(a < b).toBe(true);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId()));
    expect(ids.size).toBe(5000);
  });
});
