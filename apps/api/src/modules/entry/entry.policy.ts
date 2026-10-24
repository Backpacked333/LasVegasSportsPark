import { z } from '@sportspark/contracts';

/**
 * Entry policy values the specification leaves to operators (§6.6). Each value is the
 * specification's proposed default, held as configuration; a facility may override it under
 * `facilities.settings.entry` once the operator has decided. None of these is an operator answer.
 */
export interface EntryPolicy {
  /** §4.15 "Proposed maximum roster age: two hours, pending operating approval" (DEC-033, Operations). */
  maxRosterAgeMinutes: number;
  /**
   * SPK-ENTRY-004: "An unrelated balance must not block participation unless the approved policy
   * expressly requires it." Default false (DEC-056, Finance and league manager).
   */
  blockOnUnrelatedBalance: boolean;
  /**
   * §4.15 "Supervised pickup requires an online authorization check or a separately approved manual
   * outage procedure." References of approved procedures; none is approved (DEC-005, DEC-034,
   * Operations), so an offline release is rejected until one is configured.
   */
  approvedOutageProcedures: readonly string[];
  /** Device clock tolerance: an observation further than this in the future is rejected (engineering proposal). */
  clockSkewToleranceMinutes: number;
  /**
   * A child participant leaves through a supervised release, never a plain departure (SPK-ENTRY-007;
   * whether supervised pickup is used at all is DEC-075, Product owner). Proposed default true.
   */
  childParticipantDepartureRequiresRelease: boolean;
  /** Every denied pickup is escalated (DEC-005 proposal: "denied or escalated under approved procedure"). */
  escalateDeniedPickups: boolean;
  /** Owner queues for the Today workspace (SPK-UX-006); engineering proposals pending DEC-015. */
  pickupEscalationQueue: string;
  attendanceReviewQueue: string;
  facilityOperationsQueue: string;
}

export const DEFAULT_ENTRY_POLICY: EntryPolicy = {
  maxRosterAgeMinutes: 120,
  blockOnUnrelatedBalance: false,
  approvedOutageProcedures: [],
  clockSkewToleranceMinutes: 5,
  childParticipantDepartureRequiresRelease: true,
  escalateDeniedPickups: false,
  pickupEscalationQueue: 'general_manager',
  attendanceReviewQueue: 'program_manager',
  facilityOperationsQueue: 'front_desk',
};

export const ENTRY_POLICY = Symbol('ENTRY_POLICY');

/** The facility override block (`facilities.settings.entry`); unknown keys are ignored. */
const FacilityEntrySettings = z.object({
  maxRosterAgeMinutes: z.number().int().min(1).max(1440).optional(),
  blockOnUnrelatedBalance: z.boolean().optional(),
  approvedOutageProcedures: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  clockSkewToleranceMinutes: z.number().int().min(0).max(120).optional(),
  childParticipantDepartureRequiresRelease: z.boolean().optional(),
  escalateDeniedPickups: z.boolean().optional(),
});

/**
 * The policy in force at a facility. An invalid override block is ignored as a whole (the
 * defaults apply), so a malformed setting can never approve an outage procedure by accident.
 */
export function policyForFacility(base: EntryPolicy, settings: unknown): EntryPolicy {
  const block =
    settings && typeof settings === 'object' && 'entry' in settings
      ? (settings as { entry: unknown }).entry
      : undefined;
  if (block === undefined) return base;
  const parsed = FacilityEntrySettings.safeParse(block);
  if (!parsed.success) return base;
  const overrides = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  ) as Partial<EntryPolicy>;
  return { ...base, ...overrides };
}
