/**
 * The demo roles and their guided tours. Each role signs in as one of the accounts the
 * development seed creates (apps/api/src/dev/seed-dev.ts, by subject), so the tour runs the real
 * screens against the real API: what the viewer is allowed to see is the API's answer for that
 * role, never decided here. Tour copy describes the screen and what to try on it; it does not
 * claim data exists, because a fresh demo database holds only the seeded accounts.
 */
export interface TourStep {
  /** Route the step opens. */
  path: string;
  title: string;
  body: string;
  /** Short things to try on this screen. */
  tryThis?: readonly string[];
}

export interface DemoRole {
  id: string;
  title: string;
  /** Who this is, in one line, for the role picker. */
  who: string;
  /** The seed account subject this role signs in as; null for a role that lives in another app. */
  subject: string | null;
  /** Where a role without a staff account is demonstrated instead. */
  elsewhere?: string;
  tour: readonly TourStep[];
}

export const DEMO_ROLES: readonly DemoRole[] = [
  {
    id: 'front-desk',
    title: 'Front desk',
    who: 'Checks people in, answers families and fixes payment problems.',
    subject: 'dev-desk',
    tour: [
      {
        path: '/today',
        title: 'Today is the operating home',
        body: 'Everything happening now at the facility: activities, field status, expected arrivals and the exceptions that need a decision.',
        tryThis: ['Switch the facility at the top', 'Open an exception when one is listed'],
      },
      {
        path: '/arrival',
        title: 'Arrival scanning',
        body: 'Scan a pass or look someone up. The result says plainly whether the person can go in, and why not when they cannot.',
        tryThis: ['Search for a person by name', 'Open the offline queue tab'],
      },
      {
        path: '/registrations/assisted',
        title: 'Register someone at the desk',
        body: 'Assisted registration builds a basket for a family, shows the price before anything is charged, and takes payment.',
      },
      {
        path: '/people',
        title: 'People and families',
        body: 'Find a person, see their household and who may act for them. Private details stay hidden unless your role allows them.',
      },
      {
        path: '/finance/payments',
        title: 'Payment problems',
        body: 'Payments whose outcome is unknown stay marked as unknown until they are reconciled, so nobody charges a family twice.',
      },
    ],
  },
  {
    id: 'league-manager',
    title: 'League manager',
    who: 'Runs leagues and tournaments: fixtures, results, disputes and standings.',
    subject: 'dev-league',
    tour: [
      {
        path: '/leagues',
        title: 'Competitions',
        body: 'Every league and tournament with its seasons and divisions. Start here to set up a new season.',
        tryThis: ['Create a competition', 'Open the rule sets tab'],
      },
      {
        path: '/leagues/rule-sets',
        title: 'Rule sets',
        body: 'Points for a win, tie breakers and match length live in a rule set that seasons reuse.',
      },
      {
        path: '/teams',
        title: 'Teams and placement',
        body: 'Review team entries and place players on teams. The placement board keeps sibling and carpool requests visible.',
      },
      {
        path: '/schedule/drafts',
        title: 'Schedule drafts',
        body: 'Fixtures go into a draft first. Families see nothing until the draft is reviewed and published.',
      },
      {
        path: '/leagues/results-review',
        title: 'Results review',
        body: 'Reported scores wait here. Confirm them, or open the dispute when the two teams disagree.',
      },
      {
        path: '/leagues/disputes',
        title: 'Disputes',
        body: 'Each dispute keeps both reports and the decision with its reason, so standings can be explained later.',
      },
    ],
  },
  {
    id: 'administrator',
    title: 'Administrator',
    who: 'Sets up staff access, optional modules, integrations and reports.',
    subject: 'dev-admin',
    tour: [
      {
        path: '/admin/accounts',
        title: 'Accounts and roles',
        body: 'Who works here and what each role may do. Changes are recorded with who made them and why.',
      },
      {
        path: '/admin/capabilities',
        title: 'Capability switches',
        body: 'Optional modules such as rentals, memberships and point of sale. Turning one on shows its screens to the roles that use it.',
        tryThis: ['Turn on a module, then look at the navigation'],
      },
      {
        path: '/programs',
        title: 'Programs and camps',
        body: 'Create a program and its offerings. Nothing is visible to families until an offering is published.',
        tryThis: ['Create a program', 'Add an offering and review its publication'],
      },
      {
        path: '/communications/compose',
        title: 'Messages',
        body: 'Write to an audience and see who it reaches before sending, including people who cannot be reached.',
      },
      {
        path: '/reports',
        title: 'Reports',
        body: 'Operating reports, utilization and exports for the period you choose.',
      },
      {
        path: '/admin/audit',
        title: 'Audit records',
        body: 'Every consequential change in the demo so far is listed here, including the ones you just made.',
      },
    ],
  },
  {
    id: 'coach',
    title: 'Coach',
    who: 'Takes attendance, messages families and assesses players.',
    subject: 'dev-coach',
    tour: [
      {
        path: '/workspace',
        title: 'My assignments',
        body: 'A coach sees only their own sessions and teams. Each assignment opens attendance, release and messages.',
      },
      {
        path: '/workspace/assessments',
        title: 'Player assessments',
        body: 'Assess players against a template. Recommendations feed placement for the next season.',
      },
      {
        path: '/workspace/offline',
        title: 'Working offline',
        body: 'Attendance taken without a connection waits here and sends when the device is back online. Nothing pretends to be saved before it is.',
      },
    ],
  },
  {
    id: 'referee',
    title: 'Referee',
    who: 'Accepts match assignments, reports results and sees fees.',
    subject: 'dev-official',
    tour: [
      {
        path: '/workspace',
        title: 'My assignments',
        body: 'Matches this official is assigned to, with time, field and the other officials.',
      },
      {
        path: '/workspace/fees',
        title: 'My fees',
        body: 'Fees for matches officiated, and whether each has been approved and paid.',
      },
    ],
  },
  {
    id: 'family',
    title: 'Parent or player',
    who: 'Registers, pays, sees the family schedule and shows a pass at the gate.',
    subject: null,
    elsewhere: 'Families use the mobile app. Start it in demo mode and sign in as the parent.',
    tour: [],
  },
];

export function findRole(id: string | null): DemoRole | null {
  return DEMO_ROLES.find((r) => r.id === id) ?? null;
}
