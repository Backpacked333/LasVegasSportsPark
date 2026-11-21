/**
 * SCR-C-03 Home row verbs (SPK-UX-003; PA-11 SPK-UX-011 **Proposed**): the one verb on each notice
 * and registration row of the "To do" card. Pure functions: no clock, no reads.
 */
import { noticeVerb, registrationVerb } from '../home-layout';

describe('"To do" row verbs (SPK-UX-003, PA-11)', () => {
  it.each([
    ['payment_attention', 'Pay'],
    ['availability_request', 'Answer'],
    ['team_invitation', 'Accept'],
    ['waitlist_offer', 'Accept'],
    ['registration_outcome', 'View'],
    ['placement', 'View'],
  ])('a %s notice reads "%s"', (kind, verb) => {
    expect(noticeVerb({ kind } as Parameters<typeof noticeVerb>[0])).toBe(verb);
  });

  it.each([
    ['payment', 'Pay'],
    ['forms', 'Sign form'],
    ['approval', 'View'],
    ['placement', 'View'],
    [null, 'View'],
  ] as const)('a registration pending on %s reads "%s"', (reason, verb) => {
    expect(registrationVerb(reason)).toBe(verb);
  });
});
