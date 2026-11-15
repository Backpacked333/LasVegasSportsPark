/**
 * The demo roles and their guided tours. Each role signs in as one of the accounts the
 * development seed creates (apps/api/src/dev/seed-dev.ts, by subject), so the tour runs the real
 * screens against the real API: what the viewer is allowed to see is the API's answer for that
 * role, never decided here.
 *
 * The tours describe the demo dataset (apps/api/src/dev/seed-demo.ts, ADR-007): the sample
 * families, classes, camp, league, rentals and register session `pnpm demo` seeds. The names in
 * "Try this" are those sample records. A step that opens a seeded record names a link
 * (`links.ts`); when the demo was started without the dataset it opens the fallback `path`.
 */
import type { DemoLinkName } from './links';

export interface TourStep {
  /** Route the step opens (the fallback when the step names a `link`). */
  path: string;
  /** The seeded record the step opens when the demo knows it. */
  link?: DemoLinkName;
  title: string;
  body: string;
  /** Short things to try on this screen. */
  tryThis?: readonly string[];
  /** Pages that need no sign-in, offered as links that open in a new tab. */
  openLinks?: readonly { label: string; link: DemoLinkName }[];
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
    who: 'Checks people in, registers families, runs the register and fixes payment problems.',
    subject: 'dev-desk',
    tour: [
      {
        path: '/today',
        title: 'Today is the operating home',
        body: 'Everything happening now at the facility: classes and games by field, field status, expected arrivals and the exceptions that need a decision.',
        tryThis: [
          'Find the Mini kickers class and the evening rental on Field 1',
          'Switch the facility at the top',
        ],
      },
      {
        path: '/arrival',
        title: 'Arrival and waivers at the door',
        body: 'Scan a pass or look someone up: the result says plainly whether the person can go in. A missing liability waiver shows as a warning, with the way to record it.',
        tryThis: [
          'Look up Nora Heath: her waiver is missing',
          'Look up Sora Dune: the waiver was entered from paper',
          'Open the offline queue tab',
        ],
      },
      {
        path: '/people',
        link: 'missingWaiverPerson',
        title: "Waivers on a person's record",
        body: 'Each record shows the liability waiver: accepted in the app, entered from paper with the date on the paper, or missing.',
        tryThis: [
          'Record a paper waiver for Nora Heath with the date written on it',
          'Open Sora Dune to see a waiver that came from paper',
        ],
      },
      {
        path: '/registrations/assisted',
        title: 'Register someone at the desk',
        body: 'Assisted registration builds a basket for a family and shows the price before anything is charged. The camp is sold by the week or by the day, with add-ons and a jersey; classes show a per-class price or a member price.',
        tryThis: [
          'Holiday camp week for Kiran Alder: choose Single day, add lunch and a jersey size',
          'Skills academy for Kiran Alder: the price is per class, for the classes still to come',
          'Futsal club for Lena Birch, who holds the park membership: the member price applies',
        ],
      },
      {
        path: '/registrations/queue',
        title: 'Applications waiting for approval',
        body: 'The Advanced squad takes players only after a coach has agreed. Two applications wait here; nothing is charged until one is accepted.',
        tryThis: ['Open an application to see who applied and what it waits for'],
      },
      {
        path: '/programs',
        link: 'campUniforms',
        title: 'Uniform list',
        body: 'Who ordered which size for the camp, whether it is paid, and whether it has been handed over.',
        tryThis: [
          'Mark the Youth M jersey as handed over',
          'Correct a hand-over recorded by mistake',
        ],
      },
      {
        path: '/schedule/rentals',
        link: 'rentalRoster',
        title: 'Rental group roster',
        body: 'The renter lists who is coming, and each person shows whether the waiver is accepted. Open invitations are listed with them; the roster never blocks the booking.',
        tryThis: [
          'See who on the roster has not accepted the waiver',
          'Add a person to the roster',
          'Revoke one of the open invitations',
        ],
      },
      {
        path: '/finance/point-of-sale',
        link: 'registerSession',
        title: 'Register and open-amount lines',
        body: "The open register session with today's sales. A line without a product, such as a lost key or a damage fee, needs a reason category; above the desk's limit a second person approves it before it can be paid.",
        tryThis: [
          'Open the sale that waits for a second approval',
          'Start a sale and add a line for a lost locker key',
          'Open the receipt of a paid sale',
        ],
      },
      {
        path: '/people',
        title: 'People and families',
        body: 'Find a person, see their household and who may act for them. Private details stay hidden unless your role allows them.',
        tryThis: ['Search for Birch to see a household with two children'],
      },
      {
        path: '/finance/payments',
        title: 'Payment problems',
        body: 'Payments whose outcome is unknown stay marked as unknown until they are checked with the provider, so nobody charges a family twice.',
        tryThis: ['Find the payment marked unknown', 'Find the declined card'],
      },
    ],
  },
  {
    id: 'league-manager',
    title: 'League manager',
    who: 'Runs leagues and tournaments: teams, fixtures, results, standings and season messages.',
    subject: 'dev-league',
    tour: [
      {
        path: '/leagues',
        title: 'Competitions',
        body: 'Every league and tournament with its seasons and divisions. Friday night league is under way; Spring cup is still being set up.',
        tryThis: ['Open Friday night league', 'Open the rule sets tab'],
      },
      {
        path: '/leagues',
        link: 'season',
        title: 'A season under way',
        body: 'Winter season has two divisions and eight teams. Its fixtures were generated from a specification and published through a schedule draft.',
        tryThis: ['Open the fixtures of the season', 'Open the standings of each division'],
      },
      {
        path: '/leagues/rule-sets',
        title: 'Rule sets',
        body: 'Points for a win, tie breakers and match length live in a rule set that seasons reuse.',
      },
      {
        path: '/teams',
        link: 'teamEntries',
        title: 'Team waiting list and place offers',
        body: 'Premier is full. Canyon Comets hold an open offer for the place that was added, Sunset Strikers are next on the list, and Mirage Athletic has applied and is not placed yet.',
        tryThis: [
          'See the open offer and when it expires',
          'Withdraw the offer, then offer the place to the next team',
          'Approve Mirage Athletic into Recreational',
        ],
      },
      {
        path: '/schedule/drafts',
        title: 'Schedule drafts',
        body: 'Fixtures go into a draft first, and teams see nothing until it is reviewed and published. The two drafts of this season are published.',
      },
      {
        path: '/leagues/results-review',
        link: 'seasonResults',
        title: 'Results and standings',
        body: 'A reported score waits until the league manager publishes it, and publishing updates the standings. Two scores from the latest game night are waiting.',
        tryThis: [
          'Publish one of the two waiting scores',
          'Open the standings and see the table change',
        ],
      },
      {
        path: '/leagues',
        link: 'competition',
        title: 'Public standings and the lobby display',
        body: 'This competition is public: anyone with the link sees fixtures, results and standings without signing in. The lobby display shows the schedule of the day by field.',
        tryThis: [
          'Open the public standings in a new tab',
          'Open the lobby display on a second screen',
          'Make the competition private: the public link stops working',
        ],
        openLinks: [
          { label: 'Public standings', link: 'publicStandings' },
          { label: 'Lobby display', link: 'lobby' },
          { label: "Today's public schedule", link: 'publicSchedule' },
        ],
      },
      {
        path: '/communications/sequences',
        link: 'messageSchedule',
        title: 'Messages for the season',
        body: "The season's messages come from a sequence of templates, and nothing is sent until someone confirms it. One was sent, one was skipped and two wait for confirmation.",
        tryThis: [
          "Preview the welcome message with the season's dates filled in",
          'Confirm it, or edit the text first',
          'Bring the skipped message back',
        ],
      },
      {
        path: '/leagues/disputes',
        title: 'Disputes',
        body: 'Each dispute keeps the report, the objection and the decision with its reason, so standings can be explained later. One captain has disputed a score.',
        tryThis: ['Open the dispute from the first Premier game'],
      },
    ],
  },
  {
    id: 'administrator',
    title: 'Administrator',
    who: 'Sets up staff access, optional modules, programs, message templates and reports.',
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
        body: 'Optional modules are off until the facility decides it wants them. In the demo all are on, including the ten newest: liability waivers, per-class prices, member prices, price tiers and add-ons, uniforms, rental rosters, open-amount register lines, the team waiting list, public schedules and message sequences.',
        tryThis: [
          'Turn off Team waiting list, then open Teams as the league manager',
          'Read which decision each switch rests on',
        ],
      },
      {
        path: '/programs',
        title: 'Programs and camps',
        body: 'Programs and their offerings. Nothing is visible to families until an offering is published; one class is still a draft.',
        tryThis: ['Open Youth soccer school', 'Review the draft class before publishing it'],
      },
      {
        path: '/programs',
        link: 'camp',
        title: 'Price tiers, add-ons and a uniform',
        body: 'Holiday camp week is sold as a full week or a single day. Lunch and early drop-off are chosen per day, the team photo has six places, and the jersey comes in three sizes.',
        tryThis: [
          'Look at the two price tiers',
          'Add another add-on',
          'Open the required waiver of the offering',
        ],
      },
      {
        path: '/programs',
        link: 'memberClass',
        title: 'Per-class and member prices',
        body: 'Futsal club has a member price for children who hold the park membership. Skills academy is priced per class, so a child who joins late pays for the classes still to come.',
        tryThis: ['Read the price section of Futsal club', 'Open Skills academy and compare'],
      },
      {
        path: '/registrations/waitlists',
        link: 'waitlist',
        title: 'Waitlist',
        body: 'The goalkeeper clinic is full and one child is waiting. A freed place is offered to the waitlist before anyone else.',
        tryThis: ['See who is waiting and since when'],
      },
      {
        path: '/communications/templates',
        title: 'Message templates and sequences',
        body: 'Reusable wording with placeholders such as the name of the season and its dates. A sequence sends templates a number of days before or after a date of the season or class.',
        tryThis: [
          'Open the welcome template',
          'Open Message sequences to see the steps for seasons',
        ],
      },
      {
        path: '/communications/compose',
        title: 'Messages',
        body: 'Write to an audience and see who it reaches before sending, including people who cannot be reached.',
      },
      {
        path: '/finance/point-of-sale',
        link: 'registerSession',
        title: 'Open-amount lines on the register',
        body: 'Lines without a product are listed apart on the register session: the reason, the amount, who entered it and who approved it. The sales report lists them the same way for the finance roles.',
        tryThis: ['Find the line that still waits for approval'],
      },
      {
        path: '/reports',
        title: 'Reports',
        body: 'Operating reports for the period you choose. A stored run of the registration funnel is listed; each run keeps its figures so it can be reproduced.',
        tryThis: ['Open the stored run', 'Run a report for this week'],
      },
      {
        path: '/admin/audit',
        title: 'Audit records',
        body: 'Every consequential change in the demo so far is listed here, including the ones you just made.',
      },
    ],
  },
  {
    id: 'general-manager',
    title: 'General manager',
    who: 'Runs the facility: approvals, money that needs a decision, fields and reports.',
    // Created by the demo dataset (apps/api/src/dev/seed-demo.ts), not by the development seed.
    subject: 'demo-manager',
    tour: [
      {
        path: '/today',
        title: 'Today across the facility',
        body: 'The same operating home as the front desk, with the exceptions of every queue: today a payment to check and a cancellation whose refund is to settle.',
        tryThis: ['Open the exception about the cancellation', 'Acknowledge an exception'],
      },
      {
        path: '/finance/payments',
        title: 'Money that needs a decision',
        body: 'One payment has an unknown outcome and one card was declined. A canceled registration waits for its refund to be settled, and one refund is still with the provider.',
        tryThis: [
          'Open the payment marked unknown and check it with the provider',
          'Open the refund that is still processing',
        ],
      },
      {
        path: '/finance/point-of-sale',
        link: 'openAmountSale',
        title: 'Approve an open-amount line',
        body: "The desk entered a line above its limit, so the sale cannot be paid yet. A second person approves it with a reason; the desk's own approval is refused.",
        tryThis: ['Approve the line with a reason', 'Then take payment for the sale'],
      },
      {
        path: '/registrations/queue',
        title: 'Applications to decide',
        body: 'Two children applied to the Advanced squad. Accepting an application offers the place; declining it records the reason.',
        tryThis: ['Accept one application', 'Decline the other with a reason'],
      },
      {
        path: '/facilities',
        title: 'Fields and maintenance',
        body: 'Assets, maintenance tasks and restrictions. A torn goal net on Field 3 was reported at the desk and is waiting for an owner.',
        tryThis: ['Assign the task to yourself', 'Record what was done'],
      },
      {
        path: '/schedule/closures',
        title: 'Closures',
        body: 'A closure of Field 3 is planned for a turf repair. Before it applies, the screen lists what it would affect.',
        tryThis: ['Preview the impact of the closure', 'Withdraw it with a reason'],
      },
      {
        path: '/reports',
        title: 'Reports for the finance roles',
        body: 'Stored runs of sales by product line, what is still owed and the registration funnel. The sales report lists open-amount register lines apart, one row each.',
        tryThis: ['Open the sales run and find the lost key and the damage fee', 'Export a run'],
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
        tryThis: ['Open the next Mini kickers class', 'Accept the class that is offered'],
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
        body: 'Matches this official is assigned to, with time, field and the other officials. One match is accepted and one is offered.',
        tryThis: ['Accept the offered match', 'Open the accepted match'],
      },
      {
        path: '/workspace/fees',
        title: 'My fees',
        body: 'Fees for matches officiated, and whether each has been approved and exported. The list fills once a match is completed.',
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
