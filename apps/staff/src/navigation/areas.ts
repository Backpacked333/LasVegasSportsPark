/**
 * The fourteen staff navigation areas (SPK-UX-005), in specification order, with the screens of
 * docs/package-a/screen-and-journey-inventory.md section 5 each one will hold. "Visibility depends
 * on permissions": the API does not yet publish which areas or actions a principal may use, so
 * every area is listed and each area's screens render the API's ACCESS_DENIED as "not available"
 * (the client never decides authorization).
 */
export interface StaffArea {
  id: string;
  title: string;
  path: string;
  screenIds: string;
  purpose: string;
  /** The area's screen group registers its own routes in App.tsx (no placeholder). */
  ownRoutes?: boolean;
  /** Built screens of an area that still shows its placeholder, linked from the area page. */
  links?: readonly { path: string; title: string; screenIds: string }[];
}

export const STAFF_AREAS: readonly StaffArea[] = [
  {
    id: 'today',
    title: 'Today',
    path: '/today',
    screenIds: 'SCR-S-01, SCR-S-02, SCR-S-50',
    purpose:
      'Operating home: current activities, field status, arrivals, readiness, coverage, exceptions (SPK-UX-006).',
    ownRoutes: true,
  },
  {
    id: 'schedule',
    title: 'Schedule',
    path: '/schedule',
    screenIds: 'SCR-S-03 to SCR-S-07, SCR-S-51, SCR-S-52',
    purpose: 'Calendar and resources, schedule drafts, publication review, closures.',
    ownRoutes: true,
  },
  {
    id: 'leagues',
    title: 'Leagues and tournaments',
    path: '/leagues',
    screenIds: 'SCR-S-08 to SCR-S-13',
    purpose: 'Competitions, seasons, divisions, fixtures, readiness, results, disputes, standings.',
    ownRoutes: true,
  },
  {
    id: 'programs',
    title: 'Programs and camps',
    path: '/programs',
    screenIds: 'SCR-S-14, SCR-S-15',
    purpose: 'Programs, offerings, sessions and publication.',
    ownRoutes: true,
  },
  {
    id: 'teams',
    title: 'Teams and placement',
    path: '/teams',
    screenIds: 'SCR-S-16 to SCR-S-19',
    purpose: 'Team entries, rosters, placement board, youth groups.',
    ownRoutes: true,
  },
  {
    id: 'people',
    title: 'People and families',
    path: '/people',
    screenIds: 'SCR-S-20 to SCR-S-23',
    purpose: 'Person search, households and grants, disputed access, duplicates.',
    ownRoutes: true,
  },
  {
    id: 'registrations',
    title: 'Registrations and waitlists',
    path: '/registrations',
    screenIds: 'SCR-S-24 to SCR-S-27',
    purpose: 'Approvals, assisted registration, waitlists, cancellations and transfers.',
    ownRoutes: true,
  },
  {
    id: 'arrival',
    title: 'Arrival and attendance',
    path: '/arrival',
    screenIds: 'SCR-S-28 to SCR-S-31',
    purpose: 'Arrival scanning, attendance, supervised release, offline queue review.',
    ownRoutes: true,
  },
  {
    id: 'staff',
    title: 'Staff and officials',
    path: '/staff',
    screenIds: 'SCR-S-32 to SCR-S-34',
    purpose: 'Availability and qualifications, assignments and replacement, fee approvals.',
    ownRoutes: true,
  },
  {
    id: 'finance',
    title: 'Finance',
    path: '/finance',
    screenIds: 'SCR-S-35 to SCR-S-38, SCR-S-53 to SCR-S-55, SCR-S-57',
    purpose:
      'Obligations, payment attempts and unknown outcomes, refunds and credits, reconciliation.',
    ownRoutes: true,
  },
  {
    id: 'communications',
    title: 'Communications',
    path: '/communications',
    screenIds: 'SCR-S-39, SCR-S-40',
    purpose: 'Message composer with audience preview, delivery status.',
    ownRoutes: true,
  },
  {
    id: 'facilities',
    title: 'Facilities and maintenance',
    path: '/facilities',
    screenIds: 'SCR-S-41, SCR-S-42',
    purpose: 'Assets and maintenance tasks, operating restrictions and release to service.',
    ownRoutes: true,
  },
  {
    id: 'reports',
    title: 'Reports',
    path: '/reports',
    screenIds: 'SCR-S-43 to SCR-S-45',
    purpose: 'Operating reports, utilization and economics, exports.',
  },
  {
    id: 'admin',
    title: 'Administration',
    path: '/admin',
    screenIds: 'SCR-S-46 to SCR-S-49, SCR-S-56',
    purpose:
      'Accounts and roles, integrations and configuration, migration imports, support cases.',
    links: [{ path: '/admin/cases', title: 'Support cases', screenIds: 'SCR-S-49' }],
  },
];

/** The coach and referee workspace (SPK-UX-007), outside the fourteen areas. */
export const WORKSPACE_PATH = '/workspace';
