/**
 * SPK-REG-002 and PA-11 SPK-UX-011 (**Proposed**): every eligibility reason code the API's
 * evaluator sends (`registration-eligibility.ts`) reads as one plain customer sentence; a code not
 * listed reads as a plain sentence for its severity, never the API's staff wording; the staff-only
 * override is not offered to customers; the API's words are kept for "Details for support".
 */
import type { Schema } from '@sportspark/api-client';
import {
  ageFromMessage,
  customerAlternative,
  customerEligibilityLines,
  customerReason,
  eligibilitySupportLines,
  subjectOf,
  UNKNOWN_REASON_SENTENCES,
} from '../eligibility-words';

type Result = NonNullable<Schema<'EligibilityResult'>>;
type Reason = Result['reasons'][number];

function reason(code: string, message: string, severity: Reason['severity'] = 'blocking'): Reason {
  return { code, severity, message, source: { type: 'offering', id: null }, requiredAction: 'x' };
}

const BEN = subjectOf('Ben');

describe('eligibility reasons in customer words (SPK-REG-002, PA-11)', () => {
  it.each<[string, string, string]>([
    [
      'above_maximum_age',
      'The participant is 31 on 2026-11-23; this offering requires at least 5 and at most 12.',
      'Ages 5 to 12. Ben is 31.',
    ],
    [
      'below_minimum_age',
      'The participant is 3 on 2026-11-23; this offering requires at least 5 (U6 rule).',
      'Ages 5 and up. Ben is 3.',
    ],
    [
      'above_maximum_age',
      'The participant is 14 on 2026-11-23; this offering requires at most 12.',
      'Ages 12 and under. Ben is 14.',
    ],
    ['above_maximum_age', 'Too old.', 'Too old for this activity.'],
    ['below_minimum_age', 'Too young.', 'Too young for this activity.'],
    [
      'date_of_birth_unknown',
      'Age eligibility on 2026-11-23 cannot be evaluated without a date of birth.',
      'We need a date of birth to check the ages. The front desk can add it.',
    ],
    [
      'youth_requires_child',
      'Youth enrollment is for child participants.',
      'This registration type is for children.',
    ],
    [
      'participant_kind_not_permitted',
      'This offering accepts adult participants only.',
      'This activity is for adults only.',
    ],
    [
      'participant_kind_not_permitted',
      'This offering accepts child participants only.',
      'This activity is for children only.',
    ],
    [
      'participant_kind_not_permitted',
      'This offering accepts adult or child participants only.',
      "This activity isn't open to this person.",
    ],
    [
      'participant_inactive',
      'The participant record is not active.',
      "This person's profile isn't active. The front desk can help.",
    ],
    [
      'registration_closed',
      'Registration for this offering is not open.',
      "Registration for this activity isn't open.",
    ],
    [
      'registration_closed',
      'Registration for this offering is paused.',
      'Registration for this activity is paused.',
    ],
    [
      'intent_offering_mismatch',
      'A youth registration cannot target a rental offering.',
      "This registration type doesn't fit this activity.",
    ],
    [
      'eligibility_policy_missing',
      'No approved eligibility policy applies to this offering yet.',
      "The facility hasn't confirmed who can join yet. The front desk can check for you.",
    ],
    [
      'eligibility_policy_not_approved',
      'The eligibility policy of this offering is not approved.',
      "The facility hasn't confirmed who can join yet. The front desk can check for you.",
    ],
    [
      'team_entry_missing',
      'Joining a team requires the team entry to join.',
      'Choose the team to join.',
    ],
    [
      'team_entry_waiting',
      'The team is waiting for a place in the season. Registration opens when the team is placed.',
      'The team is waiting for a place in the season. You can register once it has one.',
    ],
    [
      'team_entry_not_open',
      'The team entry is not taking players.',
      "This team isn't taking players right now.",
    ],
    ['session_missing', 'This registration needs a scheduled session.', 'Choose a session first.'],
    [
      'session_not_bookable',
      'The session is canceled, completed or already started.',
      'This session is no longer available.',
    ],
    [
      'acknowledgment_missing',
      '"Medical form" must be acknowledged by the participant or a guardian before enrollment.',
      'Sign “Medical form” before registering.',
    ],
    [
      'waiver_missing',
      '"Liability waiver" has not been accepted for the participant; the participant or a guardian should accept it.',
      'Accept “Liability waiver” before registering.',
    ],
    [
      'waiver_lapsed',
      '"Liability waiver" has lapsed for the participant and must be accepted before registering.',
      '“Liability waiver” has expired. Accept it again before registering.',
    ],
    [
      'waiver_missing',
      '"Liability waiver" has not been accepted for the participant; staff recorded an override for this registration.',
      'The front desk has approved this registration without “Liability waiver”.',
    ],
  ])('PA-11: %s ("%s") reads "%s"', (code, message, sentence) => {
    expect(customerReason(reason(code, message), BEN)).toBe(sentence);
  });

  it.each<[Reason['severity'], string]>([
    ['blocking', UNKNOWN_REASON_SENTENCES.blocking],
    ['unknown', UNKNOWN_REASON_SENTENCES.unknown],
    ['warning', UNKNOWN_REASON_SENTENCES.warning],
    ['info', UNKNOWN_REASON_SENTENCES.info],
  ])('PA-11: an unknown code with severity %s reads "%s", not the API text', (severity, text) => {
    const r = reason('team_roster_full', 'The team roster is at its maximum of 18.', severity);
    expect(customerReason(r, BEN)).toBe(text);
    expect(customerReason(r, BEN)).not.toContain('roster');
  });

  it('PA-11: the name comes from the bracket of "You (Dev)"', () => {
    expect(subjectOf('You (Dev)')).toEqual({ name: 'Dev' });
    expect(subjectOf('  ')).toEqual({ name: 'This person' });
    expect(
      customerReason(
        reason(
          'above_maximum_age',
          'The participant is 31 on 2026-11-23; this offering requires at least 5 and at most 12.',
        ),
        subjectOf('You (Dev)'),
      ),
    ).toBe('Ages 5 to 12. Dev is 31.');
    expect(ageFromMessage('no number here')).toBeNull();
  });

  it('PA-11: alternatives in customer words; the staff override is dropped', () => {
    const alt = (kind: Result['alternatives'][number]['kind'], message: string) =>
      customerAlternative({ kind, message, offeringId: null });
    expect(alt('other_offering', 'Choose an offering whose registration is open.')).toBe(
      'Look for another activity that fits.',
    );
    expect(alt('join_waitlist', 'Join the waitlist.')).toBe('You can join the waiting list.');
    expect(alt('trial', 'Try a session.')).toBe('You can book a trial session first.');
    expect(alt('request_placement', 'Request placement on another team.')).toBe(
      'You can ask to be placed on another team.',
    );
    expect(alt('complete_acknowledgment', 'Complete the required acknowledgments.')).toBe(
      'Sign the required forms to continue.',
    );
    expect(alt('complete_acknowledgment', 'Accept the required waiver.')).toBe(
      'Accept the waiver to continue.',
    );
    expect(alt('contact_staff', 'Ask staff to review this registration.')).toBe(
      'The front desk can help.',
    );
    expect(
      alt(
        'contact_staff',
        'Staff with program authority may override eligibility with a recorded reason.',
      ),
    ).toBeNull();
  });

  it('SPK-REG-002: lines once each; the API words go to support, one line per reason and option', () => {
    const result: Result = {
      eligible: false,
      overridden: false,
      policyVersionId: null,
      referenceDate: '2026-11-23',
      evaluatedAt: '2026-11-16T12:00:00.000Z',
      reasons: [
        reason('date_of_birth_unknown', 'Age eligibility … without a date of birth.', 'unknown'),
        reason('eligibility_policy_missing', 'No approved eligibility policy.', 'unknown'),
        reason('eligibility_policy_not_approved', 'Not approved.', 'unknown'),
      ],
      alternatives: [
        {
          kind: 'contact_staff',
          message: 'Ask staff to review this registration.',
          offeringId: null,
        },
        {
          kind: 'contact_staff',
          message: 'Add the date of birth, then try again.',
          offeringId: null,
        },
      ],
    };
    expect(customerEligibilityLines(result, BEN)).toEqual({
      reasons: [
        'We need a date of birth to check the ages. The front desk can add it.',
        "The facility hasn't confirmed who can join yet. The front desk can check for you.",
      ],
      alternatives: ['The front desk can help.'],
    });
    expect(eligibilitySupportLines(result, 'Ben').map((l) => l.label)).toEqual([
      'Ben, date_of_birth_unknown',
      'Ben, eligibility_policy_missing',
      'Ben, eligibility_policy_not_approved',
      'Ben, option 1 (contact_staff)',
      'Ben, option 2 (contact_staff)',
    ]);
  });
});
