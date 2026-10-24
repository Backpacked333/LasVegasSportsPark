import { describe, expect, it } from 'vitest';
import { evidenceItem, freshnessOf, mergeEvidence, missingEvidence } from './evidence';

const observedAt = new Date('2027-01-16T20:00:00.000Z');
const minutesAgo = (m: number) => new Date(observedAt.getTime() - m * 60_000);

describe('SPK-AUTO-002 evidence freshness', () => {
  it('a record or live evaluation read now is live, whatever its last change', () => {
    expect(freshnessOf('record', observedAt, minutesAgo(60 * 24 * 400), 60)).toEqual({
      freshness: 'live',
      ageSeconds: 400 * 24 * 3600,
    });
    expect(freshnessOf('evaluation', observedAt, observedAt, 60)).toEqual({
      freshness: 'live',
      ageSeconds: 0,
    });
  });

  it('a stored or derived result is recent within the window and stale beyond it; without an as-of instant it is unknown', () => {
    expect(freshnessOf('snapshot', observedAt, minutesAgo(60), 60).freshness).toBe('recent');
    expect(freshnessOf('snapshot', observedAt, minutesAgo(61), 60)).toEqual({
      freshness: 'stale',
      ageSeconds: 61 * 60,
    });
    expect(freshnessOf('snapshot', observedAt, null, 60)).toEqual({
      freshness: 'unknown',
      ageSeconds: null,
    });
    // A clock skew never produces a negative age.
    expect(freshnessOf('snapshot', observedAt, new Date(observedAt.getTime() + 5000), 60)).toEqual({
      freshness: 'recent',
      ageSeconds: 0,
    });
  });

  it('a context reference reports whether the record changed after the client observed it', () => {
    const changed = evidenceItem(
      'scheduling.schedule_draft',
      { recordType: 'schedule_draft', recordId: 'd1', asOf: minutesAgo(5), basis: 'record' },
      observedAt,
      60,
      minutesAgo(10),
    );
    expect(changed).toMatchObject({ changedSinceClientObservation: true, ageSeconds: 300 });
    const unchanged = evidenceItem(
      'scheduling.schedule_draft',
      { recordType: 'schedule_draft', recordId: 'd1', asOf: minutesAgo(15), basis: 'record' },
      observedAt,
      60,
      minutesAgo(10),
    );
    expect(unchanged.changedSinceClientObservation).toBe(false);
    const noObservation = evidenceItem(
      'x.y',
      { recordType: 'Odd Type!', recordId: 'r', asOf: null, basis: 'record' },
      observedAt,
      60,
    );
    expect(noObservation).toMatchObject({
      recordType: 'odd_type_',
      freshness: 'unknown',
      asOf: null,
      changedSinceClientObservation: null,
    });
  });

  it('merging keeps the first mention of a read and replaces it only with a strictly later read', () => {
    const first = evidenceItem(
      't.a',
      { recordType: 'fixture', recordId: 'f', label: 'first', asOf: observedAt, basis: 'record' },
      observedAt,
      60,
      minutesAgo(1),
    );
    const sameRead = { ...first, label: 'second', changedSinceClientObservation: null };
    expect(mergeEvidence([first, sameRead])).toEqual([first]);
    const later = {
      ...first,
      label: 'later',
      observedAt: new Date(observedAt.getTime() + 1000).toISOString(),
      changedSinceClientObservation: null,
    };
    expect(mergeEvidence([first, later])).toEqual([
      { ...later, changedSinceClientObservation: first.changedSinceClientObservation },
    ]);
  });

  it('missing evidence is bounded and typed', () => {
    expect(
      missingEvidence('payment_attempt', 'p1', 'finance.payment', 'not_available', 'x'.repeat(900)),
    ).toMatchObject({
      recordType: 'payment_attempt',
      recordId: 'p1',
      reason: 'not_available',
      description: 'x'.repeat(500),
    });
  });
});
