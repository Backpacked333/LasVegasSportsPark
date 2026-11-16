/**
 * SCR-C-03 Home layout decisions (SPK-UX-003; PA-11 SPK-UX-011 **Proposed**; ADR-008): which
 * person blocks Home shows and in which order (`homeLayout`), and the one verb on each "Needs you"
 * row. Pure functions: no clock, no reads.
 */
import { homeLayout, noticeVerb, registrationVerb } from '../home-layout';

describe('homeLayout (SCR-C-03, ADR-008)', () => {
  it('a parent (family members, no team of their own) sees "Family this week" only', () => {
    expect(homeLayout({ family: { soonest: '2026-10-25T17:00:00.000Z' }, team: null })).toEqual([
      'family',
    ]);
    expect(homeLayout({ family: { soonest: null }, team: null })).toEqual(['family']);
  });

  it('a player (on a team, no family members) sees "My team" only', () => {
    expect(homeLayout({ family: null, team: { soonest: '2026-10-25T17:00:00.000Z' } })).toEqual([
      'team',
    ]);
    expect(homeLayout({ family: null, team: { soonest: null } })).toEqual(['team']);
  });

  it('someone who is both sees whichever comes sooner first', () => {
    const earlier = '2026-10-24T17:00:00.000Z';
    const later = '2026-10-26T17:00:00.000Z';
    expect(homeLayout({ family: { soonest: later }, team: { soonest: earlier } })).toEqual([
      'team',
      'family',
    ]);
    expect(homeLayout({ family: { soonest: earlier }, team: { soonest: later } })).toEqual([
      'family',
      'team',
    ]);
  });

  it('nothing scheduled counts as later than anything scheduled, and a tie keeps the family first', () => {
    const at = '2026-10-24T17:00:00.000Z';
    expect(homeLayout({ family: { soonest: null }, team: { soonest: at } })).toEqual([
      'team',
      'family',
    ]);
    expect(homeLayout({ family: { soonest: at }, team: { soonest: null } })).toEqual([
      'family',
      'team',
    ]);
    expect(homeLayout({ family: { soonest: at }, team: { soonest: at } })).toEqual([
      'family',
      'team',
    ]);
    expect(homeLayout({ family: { soonest: null }, team: { soonest: null } })).toEqual([
      'family',
      'team',
    ]);
  });

  it('someone who is neither sees no person block', () => {
    expect(homeLayout({ family: null, team: null })).toEqual([]);
  });
});

describe('"Needs you" verbs (SPK-UX-003, PA-11)', () => {
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
