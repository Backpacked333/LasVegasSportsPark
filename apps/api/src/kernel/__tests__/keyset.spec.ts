import { DomainError, encodeCursor, newId } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { decodeCreatedCursor } from '../../modules/enrollment/enrollment.shared';
import { decodeKeyset } from '../../modules/finance/finance.shared';
import { readKeysetCursor } from '../../modules/migration/migration.shared';
import { KeysetInstant } from '../database/keyset';

/**
 * R2-API-CONTRACT-01b (§4.5, §4.10): one keyset instant for every module. Only an instant
 * PostgreSQL can represent decodes, so a crafted cursor never reaches a `::timestamptz` cast as a
 * server fault: enrollment and finance read it as the first page, migration refuses it as invalid.
 */
describe('keyset cursor instants (R2-API-CONTRACT-01b)', () => {
  const bad = [
    '0000-01-01T00:00:00Z',
    '2026-13-40T00:00:00Z',
    'yesterday',
    '2026-10-31 12:00:00+00',
  ];
  const good = ['2026-10-31T12:00:00Z', '2026-10-31T12:00:00.123Z', '2026-10-31T12:00:00.123456Z'];

  it('§4.5: KeysetInstant admits ISO-8601 UTC instants up to microseconds and nothing PostgreSQL cannot cast', () => {
    for (const value of good) expect(KeysetInstant.safeParse(value).success, value).toBe(true);
    for (const value of bad) expect(KeysetInstant.safeParse(value).success, value).toBe(false);
    expect(KeysetInstant.safeParse('2026-10-31T12:00:00.1234567Z').success).toBe(false);
  });

  it('§4.10: enrollment and finance read a crafted cursor as the first page; migration refuses it with VALIDATION_FAILED', () => {
    for (const at of bad) {
      const cursor = encodeCursor({ at, id: newId() });
      expect(decodeCreatedCursor(cursor), at).toBeNull();
      expect(decodeKeyset(cursor), at).toBeNull();
      let refused: unknown = null;
      try {
        readKeysetCursor(cursor);
      } catch (error) {
        refused = error;
      }
      expect(DomainError.is(refused) && refused.code, at).toBe('VALIDATION_FAILED');
    }
    const id = newId();
    expect(decodeKeyset(encodeCursor({ at: good[2], id }))).toEqual({ at: good[2], id });
    expect(readKeysetCursor(encodeCursor({ at: good[2], id }))).toEqual({ at: good[2], id });
  });
});
