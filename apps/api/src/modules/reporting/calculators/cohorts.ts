/**
 * Retention arithmetic (SPK-REPORT-005, metric dictionary rules K1 to K6). A cohort is a set of
 * member identities (teams, persons, households or payers) anchored to a period; a member returned
 * when it qualifies again in the comparison period. Members who could not return (not offered,
 * K4) are counted separately and leave the denominator only when the request says so.
 */
export interface CohortOutcome {
  cohortSize: number;
  returned: number;
  notOffered: number;
  denominator: number;
  rate: number | null;
  /** Members of the comparison period that were not in the anchor cohort (new, not retention). */
  newInComparison: number;
}

export function cohortOutcome(
  anchor: ReadonlySet<string>,
  comparison: ReadonlySet<string>,
  options: { notOffered?: ReadonlySet<string>; excludeNotOffered?: boolean } = {},
): CohortOutcome {
  const notOffered = new Set(
    [...(options.notOffered ?? new Set<string>())].filter((m) => anchor.has(m)),
  );
  let returned = 0;
  for (const member of anchor) if (comparison.has(member)) returned += 1;
  let newInComparison = 0;
  for (const member of comparison) if (!anchor.has(member)) newInComparison += 1;
  // A member who returned was evidently offered; never subtract it from the denominator.
  const excludable = [...notOffered].filter((m) => !comparison.has(m)).length;
  const denominator = anchor.size - (options.excludeNotOffered ? excludable : 0);
  return {
    cohortSize: anchor.size,
    returned,
    notOffered: excludable,
    denominator,
    rate: denominator > 0 ? returned / denominator : null,
    newInComparison,
  };
}
