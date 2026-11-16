/**
 * Quick navigation destinations (SPK-UX-005): every destination belongs to an area's own path,
 * paths are unique, and matching is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { STAFF_AREAS, WORKSPACE_PATH } from '../areas';
import { DESTINATIONS, destinationFor, scoreDestination } from '../destinations';

describe('quick navigation destinations (SPK-UX-005)', () => {
  it('lists each of the fourteen areas once as a top-level place, then the workspace', () => {
    const top = DESTINATIONS.filter((d) => d.top);
    expect(top.map((d) => d.path)).toEqual([...STAFF_AREAS.map((a) => a.path), WORKSPACE_PATH]);
  });

  it('every destination sits under the path of the area that owns it', () => {
    for (const d of DESTINATIONS) {
      const root =
        d.area === null ? WORKSPACE_PATH : STAFF_AREAS.find((a) => a.id === d.area)?.path;
      expect(root, d.path).toBeDefined();
      expect(d.path === root || d.path.startsWith(`${root}/`), d.path).toBe(true);
    }
  });

  it('paths are unique and never carry a record id', () => {
    const paths = DESTINATIONS.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path).toMatch(/^\/[a-z-]+(\/[a-z-]+)*$/);
  });

  it('destinationFor names the screen a path is in, by the longest matching path', () => {
    expect(destinationFor('/finance/payments')?.title).toBe('Payment attempts');
    expect(destinationFor('/finance/payments/0192f1a0')?.title).toBe('Payment attempts');
    expect(destinationFor('/finance')?.title).toBe('Finance');
    expect(destinationFor('/people/0192f1a0')?.title).toBe('People and families');
    expect(destinationFor('/nowhere')).toBeUndefined();
  });

  it('scores a title start above a word start, a word start above the context or keywords', () => {
    const payments = DESTINATIONS.find((d) => d.path === '/finance/payments');
    const fees = DESTINATIONS.find((d) => d.path === '/staff/fees');
    const finance = DESTINATIONS.find((d) => d.path === '/finance');
    if (!payments || !fees || !finance) throw new Error('fixtures missing');
    expect(scoreDestination(payments, 'pay')).toBeGreaterThan(scoreDestination(fees, 'pay'));
    expect(scoreDestination(payments, 'attempts')).toBeGreaterThan(
      scoreDestination(finance, 'attempts'),
    );
    expect(scoreDestination(payments, 'zebra')).toBe(0);
    expect(scoreDestination(payments, 'payment zebra')).toBe(0);
    expect(scoreDestination(payments, '')).toBe(1);
    // A query is matched as text, never as a pattern.
    expect(scoreDestination(payments, '(')).toBe(0);
  });
});
