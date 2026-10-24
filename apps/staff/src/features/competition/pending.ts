/**
 * Decisions that gate parts of the competition, placement and youth screens
 * (docs/package-a/screen-and-journey-inventory.md section 8, docs/package-a/decision-register.md).
 * Screens name the decision and its owner instead of inventing the policy value (§6.6). Nothing
 * here is a policy value.
 */
export interface PendingDecision {
  subject: string;
  decisions: string[];
  owner: string;
}

export const PENDING = {
  ruleSets: {
    subject: 'Approved competition rule values for each format',
    decisions: ['DEC-002'],
    owner: 'League manager',
  },
  divisionCombinations: {
    subject: 'The approved division combinations and placement criteria',
    decisions: ['DEC-048'],
    owner: 'League manager',
  },
  fairness: {
    subject:
      'Whether coach or family convenience is an approved preference, and which preferences are hard constraints',
    decisions: ['DEC-049'],
    owner: 'League manager (adult); Program manager (youth)',
  },
  publicationAuthority: {
    subject: 'Who holds result publication authority',
    decisions: ['DEC-065'],
    owner: 'League manager',
  },
  discipline: {
    subject: 'Suspension scope and length, appeal process and completion criteria',
    decisions: ['DEC-010', 'DEC-063'],
    owner: 'League manager/operator; Operations',
  },
  tournaments: {
    subject: 'Tournament use by the complex',
    decisions: ['DEC-078'],
    owner: 'Product owner',
  },
  placementModel: {
    subject: 'The placement model and the placement fields approved for collection',
    decisions: ['DEC-031', 'DEC-051'],
    owner: 'Product and operations; Operator/privacy owner',
  },
  eligibilityOverride: {
    subject: 'Overriding a roster eligibility failure',
    decisions: ['DEC-066'],
    owner: 'Product and operations; League manager',
  },
  youthGroups: {
    subject: 'Youth group sizes, space and staffing requirements',
    decisions: ['DEC-003'],
    owner: 'Program manager',
  },
  progression: {
    subject: 'Progression recommendations',
    decisions: ['DEC-055'],
    owner: 'Program manager',
  },
} satisfies Record<string, PendingDecision>;
