/**
 * Quick navigation destinations (SPK-UX-005, SPK-UX-010 "dense but understandable"): every screen
 * of the dashboard that opens without first choosing a record, by the name its own area gives it,
 * so a person who knows what they want can type it instead of walking the menus.
 *
 * A destination belongs to one of the fourteen areas (or to the coach and referee workspace) and
 * is offered only when `GET /v1/me/permissions` lists that area for the viewer (K-05): the same
 * rule as the sidebar. Listing a destination never grants anything: the screen it opens still
 * renders what the API answers (ACCESS_DENIED as "not available", a capability that is turned off
 * as turned off).
 */
import type { NavigationAreaId } from '@sportspark/api-client';
import type { IconName } from '../ui/Icon';
import { STAFF_AREAS, WORKSPACE_PATH } from './areas';

export interface Destination {
  path: string;
  title: string;
  /** The area that owns it; null for the workspace, which every signed-in viewer may open. */
  area: NavigationAreaId | null;
  /** Shown under the title: where this lives. */
  context: string;
  icon: IconName;
  /** Other words people use for it. */
  keywords?: string;
  /** An area's home (or the workspace's): listed before anything is typed. */
  top: boolean;
}

/** Screens inside an area, as their area's own tabs name them. */
const AREA_SCREENS: Readonly<
  Partial<Record<NavigationAreaId, readonly [path: string, title: string, keywords?: string][]>>
> = {
  schedule: [
    ['/schedule/calendar', 'Calendar and resources', 'fields pitches bookings day week'],
    ['/schedule/drafts', 'Drafts and publication', 'publish schedule draft'],
    ['/schedule/closures', 'Closures', 'closed weather holiday'],
    ['/schedule/resources', 'Resource inventory', 'fields pitches spaces setup'],
    ['/schedule/rentals', 'Rentals', 'field rental booking'],
    ['/schedule/parties', 'Parties', 'birthday party booking'],
  ],
  arrival: [
    ['/arrival/attendance', 'Session attendance', 'check in roll call present'],
    ['/arrival/release', 'Supervised release', 'pick up child guardian'],
    ['/arrival/offline', 'Offline queue', 'sync pending scans'],
  ],
  facilities: [
    ['/facilities/maintenance', 'Assets and maintenance tasks', 'repair work order equipment'],
    ['/facilities/restrictions', 'Operating restrictions', 'out of service release'],
  ],
  leagues: [
    ['/leagues/rule-sets', 'Rule sets', 'rules points tiebreak'],
    ['/leagues/results-review', 'Result review tasks', 'scores results confirm'],
    ['/leagues/disputes', 'Disputes', 'protest result'],
    ['/leagues/discipline', 'Discipline', 'cards suspension'],
  ],
  teams: [['/teams/youth-groups', 'Youth group placement', 'placement board groups']],
  staff: [
    ['/staff/availability', 'Availability and qualifications', 'referee coach certification'],
    ['/staff/fees', 'Fee and hours approvals', 'official pay timesheet'],
  ],
  people: [
    ['/people/invitations', 'Invitations', 'invite guardian family'],
    ['/people/access-reviews', 'Access reviews', 'disputed access custody'],
    ['/people/duplicates', 'Duplicate review', 'merge person'],
  ],
  registrations: [
    ['/registrations/queue', 'Approvals', 'approve registration pending'],
    ['/registrations/assisted', 'Assisted registration', 'register someone enroll'],
    ['/registrations/waitlists', 'Waitlists', 'waiting list offer'],
    ['/registrations/enrollments', 'Cancellations and transfers', 'cancel transfer enrollment'],
  ],
  finance: [
    ['/finance/obligations', 'Obligations and orders', 'balance owed invoice'],
    ['/finance/payments', 'Payment attempts', 'card unknown outcome charge'],
    ['/finance/credits', 'Refunds and credits', 'refund credit'],
    ['/finance/reconciliation', 'Reconciliation', 'settlement payout'],
    ['/finance/memberships', 'Memberships', 'member plan'],
    ['/finance/session-packages', 'Session packages', 'punch card pack'],
    ['/finance/point-of-sale', 'Point of sale', 'pos register till sale'],
    ['/finance/accounting-exports', 'Accounting export batches', 'ledger export'],
  ],
  communications: [['/communications/compose', 'Compose a message', 'send email sms announce']],
  reports: [
    ['/reports/insight', 'Utilization, economics, demand and retention', 'analytics heatmap'],
    ['/reports/exports', 'Stored runs and exports', 'download csv'],
  ],
  admin: [
    ['/admin/accounts', 'Accounts and roles', 'users permissions staff access'],
    ['/admin/audit', 'Audit records', 'history log who changed'],
    ['/admin/integrations', 'Integrations and settings', 'configuration providers'],
    ['/admin/capabilities', 'Capability switches', 'feature turn on off'],
    ['/admin/provider-events', 'Provider events', 'webhooks'],
    ['/admin/migration', 'Migration imports', 'import batch reconciliation'],
    ['/admin/cases', 'Support cases', 'help ticket'],
    ['/admin/access-hardware', 'Access hardware', 'gates readers doors'],
  ],
};

const WORKSPACE_SCREENS: readonly [path: string, title: string, keywords?: string][] = [
  [WORKSPACE_PATH, 'My assignments', 'coach referee workspace today games sessions'],
  [`${WORKSPACE_PATH}/fees`, 'Hours and fees', 'my pay timesheet'],
  [`${WORKSPACE_PATH}/assessments`, 'Assessments', 'player evaluation feedback'],
  [`${WORKSPACE_PATH}/report-problem`, 'Report a problem', 'issue field broken'],
];

export const DESTINATIONS: readonly Destination[] = [
  ...STAFF_AREAS.flatMap((area): Destination[] => [
    {
      path: area.path,
      title: area.title,
      area: area.id,
      context: area.group,
      icon: area.icon,
      keywords: area.purpose,
      top: true,
    },
    ...(AREA_SCREENS[area.id] ?? []).map(([path, title, keywords]): Destination => ({
      path,
      title,
      area: area.id,
      context: area.title,
      icon: area.icon,
      keywords,
      top: false,
    })),
  ]),
  ...WORKSPACE_SCREENS.map(([path, title, keywords]): Destination => ({
    path,
    title,
    area: null,
    context: 'Coach and referee workspace',
    icon: 'sports',
    keywords,
    top: path === WORKSPACE_PATH,
  })),
];

/** The destination whose path is the longest prefix of `pathname` (the screen a path is in). */
export function destinationFor(pathname: string): Destination | undefined {
  let best: Destination | undefined;
  for (const d of DESTINATIONS) {
    if (pathname === d.path || pathname.startsWith(`${d.path}/`)) {
      if (!best || d.path.length > best.path.length) best = d;
    }
  }
  return best;
}

/**
 * How well `query` matches a destination (or an action named the same way): every word of the query must appear; the title counts
 * most (its start, then a word start, then anywhere), then the context, then the keywords.
 * Zero means no match. Deterministic: ties keep the registry's order.
 */
export function scoreDestination(
  d: { title: string; context: string; keywords?: string },
  query: string,
): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const title = d.title.toLowerCase();
  const context = d.context.toLowerCase();
  const keywords = (d.keywords ?? '').toLowerCase();
  let score = 0;
  for (const word of words) {
    if (title.startsWith(word)) score += 100;
    else if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title))
      score += 60;
    else if (title.includes(word)) score += 40;
    else if (context.includes(word)) score += 20;
    else if (keywords.includes(word)) score += 10;
    else return 0;
  }
  return score;
}
