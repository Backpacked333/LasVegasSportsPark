import type {
  AgeBand,
  EligibilityAlternative,
  EligibilityResult,
  OfferingKind,
  PolicyVersion,
  PublicationState,
  RegistrationEligibilityReason,
  RegistrationIntent,
} from '@sportspark/contracts';
import { INTENT_OFFERING_KINDS } from '../enrollment.policy';

/**
 * SPK-REG-002: eligibility is evaluated from versioned policies and the configured reference date,
 * never from a stored age (§4.5). Every reason is understandable and names its source and the
 * permitted next action; alternatives say what the registrant may do instead. Unknown evidence
 * (a missing date of birth, a missing policy) is never a pass. This is a pure function so the
 * same evaluation runs on application, hold and transfer.
 */
export interface EligibilityOffering {
  id: string;
  kind: OfferingKind;
  publicationState: PublicationState;
  ageBand: AgeBand;
  startsOn: string;
  endsOn: string;
}

export interface EligibilityPerson {
  id: string;
  kind: 'adult' | 'child';
  status: string;
  /** YYYY-MM-DD or null when unknown. */
  dateOfBirth: string | null;
}

export interface EligibilityInput {
  intent: RegistrationIntent;
  at: Date;
  offering: EligibilityOffering;
  registrationOpen: boolean;
  eligibilityReferenceDate: string;
  eligibilityPolicy: PolicyVersion | null;
  requiredForms: PolicyVersion[];
  /** Policy version ids of the required forms the participant has acknowledged. */
  acknowledgedFormIds: readonly string[];
  person: EligibilityPerson;
  /** join_team: the entry applied to. */
  teamEntry?: { id: string; status: string } | null;
  /**
   * join_team on an open entry: the competition's own player eligibility for that entry (season
   * rule set, multi-team restrictions, roster limits, suspensions; SPK-CAP-004, SPK-REG-002), so a
   * join the competition rules forbid is refused before anything is quoted or charged (SPK-AT-002).
   */
  teamEligibility?: {
    reasons: ReadonlyArray<{
      code: string;
      severity: RegistrationEligibilityReason['severity'];
      message: string;
      requiredAction: string;
    }>;
  } | null;
  /** Session-scoped intents: the session booked. */
  session?: { id: string; status: string; scheduledStart: Date } | null;
}

export interface EligibilityPolicyContent {
  minAgeYears?: number;
  maxAgeYears?: number;
  participantKinds?: Array<'adult' | 'child'>;
  requiresApproval?: boolean;
  /** Free text shown with age reasons (e.g. the governing rule). */
  ageRuleLabel?: string;
}

/** Whole years completed on the reference date (YYYY-MM-DD both). */
export function ageOn(dateOfBirth: string, referenceDate: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ry, rm, rd] = referenceDate.split('-').map(Number) as [number, number, number];
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

export function evaluateRegistrationEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: RegistrationEligibilityReason[] = [];
  const alternatives: EligibilityAlternative[] = [];
  const offeringSource = { type: 'offering', id: input.offering.id };
  const policy = input.eligibilityPolicy;
  const policySource = { type: 'policy_version', id: policy?.id ?? null };
  const content = (policy?.content ?? {}) as EligibilityPolicyContent;

  if (input.person.status !== 'active') {
    reasons.push({
      code: 'participant_inactive',
      severity: 'blocking',
      message: 'The participant record is not active.',
      source: { type: 'person', id: input.person.id },
      requiredAction: 'contact_staff',
    });
  }

  if (!input.registrationOpen) {
    reasons.push({
      code: 'registration_closed',
      severity: 'blocking',
      message:
        input.offering.publicationState === 'registration_paused'
          ? 'Registration for this offering is paused.'
          : 'Registration for this offering is not open.',
      source: offeringSource,
      requiredAction: 'choose_another_offering',
    });
    alternatives.push({
      kind: 'other_offering',
      message: 'Choose an offering whose registration is open.',
      offeringId: null,
    });
  }

  const permittedKinds = INTENT_OFFERING_KINDS[input.intent];
  if (!permittedKinds.includes(input.offering.kind)) {
    reasons.push({
      code: 'intent_offering_mismatch',
      severity: 'blocking',
      message: `A ${input.intent.replaceAll('_', ' ')} registration cannot target a ${input.offering.kind} offering.`,
      source: offeringSource,
      requiredAction: 'choose_matching_offering',
    });
  }

  if (!policy) {
    reasons.push({
      code: 'eligibility_policy_missing',
      severity: 'unknown',
      message: 'No approved eligibility policy applies to this offering yet.',
      source: offeringSource,
      requiredAction: 'contact_staff',
    });
    alternatives.push({
      kind: 'contact_staff',
      message: 'Ask staff to review this registration.',
      offeringId: null,
    });
  } else if (policy.approvalStatus !== 'approved') {
    reasons.push({
      code: 'eligibility_policy_not_approved',
      severity: 'unknown',
      message: 'The eligibility policy of this offering is not approved.',
      source: policySource,
      requiredAction: 'contact_staff',
    });
  }

  if (content.participantKinds && !content.participantKinds.includes(input.person.kind)) {
    reasons.push({
      code: 'participant_kind_not_permitted',
      severity: 'blocking',
      message: `This offering accepts ${content.participantKinds.join(' or ')} participants only.`,
      source: policySource,
      requiredAction: 'choose_matching_offering',
    });
  }
  if (input.intent === 'youth' && input.person.kind !== 'child') {
    reasons.push({
      code: 'youth_requires_child',
      severity: 'blocking',
      message: 'Youth enrollment is for child participants.',
      source: { type: 'person', id: input.person.id },
      requiredAction: 'choose_matching_offering',
    });
  }

  const minAge = content.minAgeYears ?? input.offering.ageBand.minAgeYears;
  const maxAge = content.maxAgeYears ?? input.offering.ageBand.maxAgeYears;
  if (minAge !== undefined || maxAge !== undefined) {
    if (!input.person.dateOfBirth) {
      reasons.push({
        code: 'date_of_birth_unknown',
        severity: 'unknown',
        message: `Age eligibility on ${input.eligibilityReferenceDate} cannot be evaluated without a date of birth.`,
        source: { type: 'person', id: input.person.id },
        requiredAction: 'record_date_of_birth',
      });
      alternatives.push({
        kind: 'contact_staff',
        message: 'Add the date of birth to the participant record, then try again.',
        offeringId: null,
      });
    } else {
      const age = ageOn(input.person.dateOfBirth, input.eligibilityReferenceDate);
      const band = [
        minAge !== undefined ? `at least ${minAge}` : null,
        maxAge !== undefined ? `at most ${maxAge}` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      if ((minAge !== undefined && age < minAge) || (maxAge !== undefined && age > maxAge)) {
        reasons.push({
          code: age < (minAge ?? 0) ? 'below_minimum_age' : 'above_maximum_age',
          severity: 'blocking',
          message: `The participant is ${age} on ${input.eligibilityReferenceDate}; this offering requires ${band}${content.ageRuleLabel ? ` (${content.ageRuleLabel})` : ''}.`,
          source:
            content.minAgeYears !== undefined || content.maxAgeYears !== undefined
              ? policySource
              : offeringSource,
          requiredAction: 'choose_age_appropriate_offering',
        });
        alternatives.push({
          kind: 'other_offering',
          message:
            'Choose an offering whose age band includes the participant on its reference date.',
          offeringId: null,
        });
        alternatives.push({
          kind: 'contact_staff',
          message: 'Staff with program authority may override eligibility with a recorded reason.',
          offeringId: null,
        });
      }
    }
  }

  if (input.intent === 'join_team') {
    if (!input.teamEntry) {
      reasons.push({
        code: 'team_entry_missing',
        severity: 'blocking',
        message: 'Joining a team requires the team entry to join.',
        source: { type: 'team_entry', id: null },
        requiredAction: 'name_team_entry',
      });
    } else if (!['applied', 'approved'].includes(input.teamEntry.status)) {
      reasons.push({
        code: 'team_entry_not_open',
        severity: 'blocking',
        message: 'The team entry is not taking players.',
        source: { type: 'team_entry', id: input.teamEntry.id },
        requiredAction: 'choose_another_team',
      });
      alternatives.push({
        kind: 'request_placement',
        message: 'Request placement on another team.',
        offeringId: null,
      });
    } else if (input.teamEligibility) {
      const team = input.teamEntry;
      const competing = input.teamEligibility.reasons.filter(
        (r) => r.severity === 'blocking' || r.severity === 'unknown',
      );
      for (const r of competing) {
        reasons.push({
          code: r.code,
          severity: r.severity,
          message: r.message,
          source: { type: 'team_entry', id: team.id },
          requiredAction: r.requiredAction,
        });
      }
      if (competing.length > 0) {
        alternatives.push({
          kind: 'request_placement',
          message: 'Request placement on another team.',
          offeringId: null,
        });
      }
    }
  }

  if (
    input.session !== undefined &&
    (input.intent === 'pickup' || input.intent === 'trial' || input.intent === 'makeup')
  ) {
    if (!input.session) {
      reasons.push({
        code: 'session_missing',
        severity: 'blocking',
        message: 'This registration needs a scheduled session.',
        source: { type: 'offering_session', id: null },
        requiredAction: 'choose_session',
      });
    } else if (
      input.session.status !== 'scheduled' ||
      input.session.scheduledStart.getTime() <= input.at.getTime()
    ) {
      reasons.push({
        code: 'session_not_bookable',
        severity: 'blocking',
        message: 'The session is canceled, completed or already started.',
        source: { type: 'offering_session', id: input.session.id },
        requiredAction: 'choose_session',
      });
    }
  }

  const missingForms = input.requiredForms.filter((f) => !input.acknowledgedFormIds.includes(f.id));
  for (const form of missingForms) {
    // Outstanding forms do not block the application (the guardian signs before the hold, SPK-REG-009).
    reasons.push({
      code: 'acknowledgment_missing',
      severity: 'warning',
      message: `"${form.title}" must be acknowledged by the participant or a guardian before enrollment.`,
      source: { type: 'policy_version', id: form.id },
      requiredAction: 'complete_acknowledgment',
    });
  }
  if (missingForms.length > 0) {
    alternatives.push({
      kind: 'complete_acknowledgment',
      message: 'Complete the required acknowledgments.',
      offeringId: null,
    });
  }

  const eligible = reasons.every((r) => r.severity === 'warning' || r.severity === 'info');
  return {
    eligible,
    policyVersionId: policy?.id ?? null,
    referenceDate: input.eligibilityReferenceDate,
    evaluatedAt: input.at.toISOString(),
    reasons,
    alternatives: dedupeAlternatives(alternatives),
    overridden: false,
  };
}

function dedupeAlternatives(items: EligibilityAlternative[]): EligibilityAlternative[] {
  const seen = new Set<string>();
  return items.filter((a) => {
    const key = `${a.kind}:${a.offeringId ?? ''}:${a.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Required-form ids still unacknowledged according to an evaluation. */
export function missingAcknowledgments(result: EligibilityResult): string[] {
  return result.reasons
    .filter((r) => r.code === 'acknowledgment_missing' && r.source.id)
    .map((r) => r.source.id as string);
}
