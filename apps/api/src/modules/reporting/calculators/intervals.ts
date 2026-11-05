/**
 * Half-open millisecond intervals [start, end) and the set operations the utilization report
 * needs. A set of intervals is always kept normalized (sorted, non-overlapping, non-empty), so the
 * length of a union never counts the same instant twice (SPK-REPORT-003 rule U1).
 */
export type Interval = readonly [number, number];

export function normalize(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

export function union(...sets: readonly (readonly Interval[])[]): Interval[] {
  return normalize(sets.flat());
}

export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const [as, ae] = x[i] as Interval;
    const [bs, be] = y[j] as Interval;
    const s = Math.max(as, bs);
    const e = Math.min(ae, be);
    if (e > s) out.push([s, e]);
    if (ae < be) i += 1;
    else j += 1;
  }
  return out;
}

export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  for (const [s0, e0] of x) {
    let s = s0;
    for (const [bs, be] of y) {
      if (be <= s) continue;
      if (bs >= e0) break;
      if (bs > s) out.push([s, Math.min(bs, e0)]);
      s = Math.max(s, be);
      if (s >= e0) break;
    }
    if (s < e0) out.push([s, e0]);
  }
  return out;
}

export function clip(intervals: readonly Interval[], window: Interval): Interval[] {
  return intersect(intervals, [window]);
}

export function length(intervals: readonly Interval[]): number {
  return normalize(intervals).reduce((sum, [s, e]) => sum + (e - s), 0);
}
