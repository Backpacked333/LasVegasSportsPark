import { describe, expect, it } from 'vitest';
import {
  attended,
  contradictedHeads,
  currentHeads,
  effectiveState,
  hashPassReference,
  headsConflict,
  localDayWindow,
  newPassReference,
  PASS_REFERENCE_PREFIX,
  statesConflict,
  type ObservationLike,
} from './entry.shared';
import { denialReasonFor } from './services/releases.service';

const obs = (
  id: string,
  observedState: ObservationLike['observedState'],
  minute: number,
  correctsObservationId: string | null = null,
): ObservationLike => ({
  id,
  correctsObservationId,
  observedState,
  observedAt: new Date(Date.UTC(2027, 0, 16, 18, minute)),
  receivedAt: new Date(Date.UTC(2027, 0, 16, 19, minute)),
});

describe('attendance heads (SPK-ENTRY-005, §4.15 conflicts)', () => {
  it('present, late and left early are attendance; only absent contradicts them', () => {
    expect(['present', 'late', 'left_early'].every((s) => attended(s as never))).toBe(true);
    expect(attended('absent')).toBe(false);
    expect(statesConflict('present', 'late')).toBe(false);
    expect(statesConflict('left_early', 'absent')).toBe(true);
  });

  it('the current state is the head of each correction chain; corrected rows stay in history only', () => {
    const rows = [obs('a', 'absent', 0), obs('b', 'late', 5, 'a'), obs('c', 'present', 6, 'b')];
    expect(currentHeads(rows).map((r) => r.id)).toEqual(['c']);
    expect(effectiveState(currentHeads(rows))).toBe('present');
  });

  it('independent observations that disagree conflict and have no effective state', () => {
    const rows = [obs('a', 'present', 0), obs('b', 'absent', 1)];
    const heads = currentHeads(rows);
    expect(headsConflict(heads)).toBe(true);
    expect(effectiveState(heads)).toBeNull();
    expect(contradictedHeads(rows, 'absent').map((r) => r.id)).toEqual(['a']);
    // A correction replacing `b` with present resolves the contradiction.
    expect(contradictedHeads(rows, 'present', 'b')).toEqual([]);
  });

  it('agreeing heads take the latest observation; nothing recorded is null', () => {
    expect(effectiveState(currentHeads([obs('a', 'present', 0), obs('b', 'left_early', 40)]))).toBe(
      'left_early',
    );
    expect(effectiveState([])).toBeNull();
  });
});

describe('pass references (SPK-ENTRY-002)', () => {
  it('are random, prefixed, carry 256 bits and hash deterministically', () => {
    const a = newPassReference();
    const b = newPassReference();
    expect(a).not.toBe(b);
    expect(a.startsWith(PASS_REFERENCE_PREFIX)).toBe(true);
    expect(Buffer.from(a.slice(PASS_REFERENCE_PREFIX.length), 'base64url')).toHaveLength(32);
    expect(hashPassReference(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPassReference(` ${a} `)).toBe(hashPassReference(a));
    expect(hashPassReference(a)).not.toBe(hashPassReference(b));
  });
});

describe('facility-local day (SPK-SCHED-008)', () => {
  it('covers the local calendar day, including daylight-saving transition days', () => {
    const normal = localDayWindow('America/Los_Angeles', new Date('2027-01-16T17:00:00Z'));
    expect(normal).toEqual({
      date: '2027-01-16',
      start: new Date('2027-01-16T08:00:00Z'),
      end: new Date('2027-01-17T08:00:00Z'),
    });
    const springForward = localDayWindow('America/Los_Angeles', new Date(), '2027-03-14');
    expect(springForward.end.getTime() - springForward.start.getTime()).toBe(23 * 3_600_000);
  });
});

describe('pickup denial reasons (SPK-ENTRY-007, SPK-AT-016)', () => {
  it('names what the collector holds and why it does not authorize pickup', () => {
    expect(denialReasonFor('p', ['view', 'pay'])).toMatch(
      /They hold view, pay; schedule visibility and payment permission do not establish pickup authority/,
    );
    expect(denialReasonFor('p', [])).toMatch(/does not hold current pickup \(collect\) permission/);
    expect(denialReasonFor(null, [])).toMatch(/no verified record/);
  });
});
