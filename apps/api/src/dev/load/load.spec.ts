import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaleManifest, WorkloadManifestSchema } from './manifest';
import { percentile, seededRandom, summarize } from './stats';

describe('workload harness (§5.10, §5.9)', () => {
  it('§5.10: the committed manifest holds the specification envelope and validates', () => {
    const raw = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../load/workload.manifest.json'), 'utf8'),
    ) as unknown;
    const manifest = WorkloadManifestSchema.parse(raw);
    expect(manifest.envelope).toEqual({
      people: 25_000,
      historicalEnrollments: 100_000,
      attendanceAndOperationalEvents: 1_000_000,
      activeCustomerSessions: 250,
      activeStaffOrScannerSessions: 20,
      contendersForFinalPlace: 50,
    });
    expect(manifest.targets.staffLookupP95Ms).toBe(750);
    const rehearsal = scaleManifest(manifest, 0.01);
    expect(rehearsal.envelope.people).toBe(250);
    expect(rehearsal.envelope.activeStaffOrScannerSessions).toBe(1);
    expect(rehearsal.envelope.contendersForFinalPlace).toBe(50);
  });

  it('§5.9: percentiles use the nearest rank; errors and statuses are counted', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([], 95)).toBeNull();
    const summary = summarize([
      { ms: 10, status: 200 },
      { ms: 30, status: 200 },
      { ms: 20, status: 429 },
      { ms: 5000, status: 0 },
    ]);
    expect(summary).toMatchObject({
      count: 4,
      errors: 2,
      statuses: { '200': 2, '429': 1, '0': 1 },
      p50Ms: 20,
      maxMs: 5000,
    });
  });

  it('synthetic data is deterministic for a seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
