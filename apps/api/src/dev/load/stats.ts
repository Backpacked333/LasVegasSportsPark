/** Latency statistics for a workload run (§5.9 indicators report percentiles). */
export interface LatencySummary {
  count: number;
  errors: number;
  /** Responses by status code (0 for a request that got no response). */
  statuses: Record<string, number>;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

/** Nearest-rank percentile of sorted values (p in 0..100). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export interface Sample {
  ms: number;
  status: number;
}

/** Summarizes samples; a status of 0 or 400 and above counts as an error. */
export function summarize(samples: readonly Sample[]): LatencySummary {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  let errors = 0;
  for (const sample of samples) {
    statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;
    if (sample.status === 0 || sample.status >= 400) errors += 1;
  }
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    count: samples.length,
    errors,
    statuses,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted.at(-1) ?? null),
  };
}

/** A deterministic pseudo-random sequence (mulberry32), so synthetic names repeat run to run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
