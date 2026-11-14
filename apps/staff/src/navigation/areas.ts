/**
 * The fourteen staff navigation areas (SPK-UX-005), in specification order, with the screens of
 * docs/package-a/screen-and-journey-inventory.md section 5 each one holds. "Visibility depends on
 * permissions": the navigation lists the areas `GET /v1/me/permissions` marks visible for this
 * principal (`AreaNav`, K-05; the area mapping is the API's, Proposed), and every area's screens
 * still render the API's ACCESS_DENIED as "not available" when opened directly (the client never
 * decides authorization). The conditional Package G screens (SCR-S-51 to SCR-S-57) sit in the
 * areas the inventory assigns them, behind their capability switches (DEC-016).
 */
import type { NavigationAreaId } from '@sportspark/api-client';
import type { IconName } from '../ui/Icon';

/**
 * The sidebar groups the areas by the job they serve (redesign handoff): run the park now, run
 * competition, grow participation, run the business. Every area belongs to exactly one group.
 */
export type StaffAreaGroup = 'Operate' | 'Compete' | 'Grow' | 'Business';

export interface StaffArea {
  /** The API's navigation area id (`MeNavigationArea.id`). */
  id: NavigationAreaId;
  title: string;
  path: string;
  icon: IconName;
  group: StaffAreaGroup;
  screenIds: string;
  purpose: string;
  /** The area's screen group registers its own routes in App.tsx (no placeholder). */
  ownRoutes?: boolean;
  /** Built screens of an area that still shows its placeholder, linked from the area page. */
  links?: readonly {
    path: string;
    title: string;
    screenIds: string;
    /** SPK-UX-005: the API permission required before the client offers this link. */
    actionId?: string;
  }[];
  /** With `links`: the screens of the area not built yet, and why (shown as the placeholder). */
  pending?: { screenIds: string; purpose: string };
}

export const STAFF_AREAS: readonly StaffArea[] = [
  {
    id: 'today',
    title: 'Today',
    path: '/today',
    icon: 'dashboard',
    group: 'Operate',
    screenIds: 'SCR-S-01, SCR-S-02, SCR-S-50',
    purpose:
      'Operating home: current activities, field status, arrivals, readiness, coverage, exceptions (SPK-UX-006).',
    ownRoutes: true,
  },
  {
    id: 'schedule',
    title: 'Schedule',
    path: '/schedule',
    icon: 'calendar_month',
    group: 'Operate',
    screenIds: 'SCR-S-03 to SCR-S-07, SCR-S-51, SCR-S-52',
    purpose: 'Calendar and resources, schedule drafts, publication review, closures.',
    ownRoutes: true,
  },
  {
    id: 'leagues',
    title: 'Leagues and tournaments',
    path: '/leagues',
    icon: 'trophy',
    group: 'Compete',
    screenIds: 'SCR-S-08 to SCR-S-13',
    purpose: 'Competitions, seasons, divisions, fixtures, readiness, results, disputes, standings.',
    ownRoutes: true,
  },
  {
    id: 'programs',
    title: 'Programs and camps',
    path: '/programs',
    icon: 'school',
    group: 'Grow',
    screenIds: 'SCR-S-14, SCR-S-15',
    purpose: 'Programs, offerings, sessions and publication.',
    ownRoutes: true,
  },
  {
    id: 'teams',
    title: 'Teams and placement',
    path: '/teams',
    icon: 'groups',
    group: 'Compete',
    screenIds: 'SCR-S-16 to SCR-S-19',
    purpose: 'Team entries, rosters, placement board, youth groups.',
    ownRoutes: true,
  },
  {
    id: 'people',
    title: 'People and families',
    path: '/people',
    icon: 'family_restroom',
    group: 'Grow',
    screenIds: 'SCR-S-20 to SCR-S-23',
    purpose: 'Person search, households and grants, disputed access, duplicates.',
    ownRoutes: true,
  },
  {
    id: 'registrations',
    title: 'Registrations and waitlists',
    path: '/registrations',
    icon: 'how_to_reg',
    group: 'Grow',
    screenIds: 'SCR-S-24 to SCR-S-27',
    purpose: 'Approvals, assisted registration, waitlists, cancellations and transfers.',
    ownRoutes: true,
  },
  {
    id: 'arrival',
    title: 'Arrival and attendance',
    path: '/arrival',
    icon: 'qr_code_scanner',
    group: 'Operate',
    screenIds: 'SCR-S-28 to SCR-S-31',
    purpose: 'Arrival scanning, attendance, supervised release, offline queue review.',
    ownRoutes: true,
  },
  {
    id: 'staff',
    title: 'Staff and officials',
    path: '/staff',
    icon: 'sports',
    group: 'Compete',
    screenIds: 'SCR-S-32 to SCR-S-34',
    purpose: 'Availability and qualifications, assignments and replacement, fee approvals.',
    ownRoutes: true,
  },
  {
    id: 'finance',
    title: 'Finance',
    path: '/finance',
    icon: 'account_balance',
    group: 'Business',
    screenIds: 'SCR-S-35 to SCR-S-38, SCR-S-53 to SCR-S-55, SCR-S-57',
    purpose:
      'Obligations, payment attempts and unknown outcomes, refunds and credits, reconciliation.',
    ownRoutes: true,
  },
  {
    id: 'communications',
    title: 'Communications',
    path: '/communications',
    icon: 'campaign',
    group: 'Business',
    screenIds: 'SCR-S-39, SCR-S-40',
    purpose: 'Message composer with audience preview, delivery status.',
    ownRoutes: true,
  },
  {
    id: 'facilities',
    title: 'Facilities and maintenance',
    path: '/facilities',
    icon: 'construction',
    group: 'Operate',
    screenIds: 'SCR-S-41, SCR-S-42',
    purpose: 'Assets and maintenance tasks, operating restrictions and release to service.',
    ownRoutes: true,
  },
  {
    id: 'reports',
    title: 'Reports',
    path: '/reports',
    icon: 'monitoring',
    group: 'Business',
    screenIds: 'SCR-S-43 to SCR-S-45',
    purpose: 'Operating reports, utilization and economics, exports.',
    ownRoutes: true,
  },
  {
    id: 'admin',
    title: 'Administration',
    path: '/admin',
    icon: 'admin_panel_settings',
    group: 'Business',
    screenIds: 'SCR-S-46 to SCR-S-49, SCR-S-56',
    purpose:
      'Accounts and roles, integrations and configuration, migration imports, support cases, access hardware.',
    links: [
      { path: '/admin/accounts', title: 'Accounts, roles and permissions', screenIds: 'SCR-S-46' },
      { path: '/admin/audit', title: 'Audit records', screenIds: 'SCR-S-46' },
      {
        path: '/admin/integrations',
        title: 'Integrations and configuration',
        screenIds: 'SCR-S-47',
      },
      { path: '/admin/capabilities', title: 'Capability switches', screenIds: 'SCR-S-47' },
      { path: '/admin/provider-events', title: 'Provider events', screenIds: 'SCR-S-47' },
      {
        path: '/admin/migration',
        title: 'Migration imports and reconciliation',
        screenIds: 'SCR-S-48',
      },
      {
        path: '/support/cases',
        title: 'Support cases',
        screenIds: 'SCR-S-49',
        actionId: 'support.read_case',
      },
      {
        path: '/admin/access-hardware',
        title: 'Access hardware (conditional)',
        screenIds: 'SCR-S-56',
      },
    ],
  },
];

/** Sidebar groups in display order. */
export const STAFF_AREA_GROUPS: readonly StaffAreaGroup[] = [
  'Operate',
  'Compete',
  'Grow',
  'Business',
];

/** The coach and referee workspace (SPK-UX-007), outside the fourteen areas. */
export const WORKSPACE_PATH = '/workspace';
