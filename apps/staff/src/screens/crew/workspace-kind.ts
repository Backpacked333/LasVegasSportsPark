/**
 * Which phone workspace a staff member gets (staff redesign Phase 8): the coach's (Week · Teams ·
 * Now · Messages · More), the referee's (Home · Games · Pay · Issues · More), the field crew's
 * (Fields · Tasks · Report · Queue · More), or the original workspace tabs for everyone else.
 *
 * This chooses a layout and a home screen, never what the viewer may do: every screen still reads
 * the API, which answers for the viewer, and offers an action only when the API lists it. The
 * staff roles of `GET /v1/me` are a navigation hint here, as the account menu's role label is.
 * A person holding several roles gets the first that applies in the order coach, official,
 * facilities operator; managers and the desk keep Today as their home.
 */
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { WORKSPACE_PATH } from '../../navigation/areas';
import { WORKSPACE_PHONE_TABS, type WorkspaceTab } from '../workspace/workspace-tabs';

export type { WorkspaceTab };

export type WorkspaceKind = 'coach' | 'referee' | 'crew' | 'default';

/** Roles that run the facility from Today; they keep Today as home even with a field role. */
const TODAY_ROLES: readonly string[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'finance_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
];

export function workspaceKindOf(staffRoles: readonly string[]): WorkspaceKind {
  if (staffRoles.includes('coach')) return 'coach';
  if (staffRoles.includes('official')) return 'referee';
  if (staffRoles.includes('facilities_operator')) return 'crew';
  return 'default';
}

export const COACH_HOME = `${WORKSPACE_PATH}/week`;
export const REFEREE_HOME = `${WORKSPACE_PATH}/referee`;
export const CREW_HOME = `${WORKSPACE_PATH}/fields`;

/** Where "/" opens for these roles: the role's home, or Today. */
export function homePathOf(staffRoles: readonly string[]): string {
  if (staffRoles.some((r) => TODAY_ROLES.includes(r))) return '/today';
  switch (workspaceKindOf(staffRoles)) {
    case 'coach':
      return COACH_HOME;
    case 'referee':
      return REFEREE_HOME;
    case 'crew':
      return CREW_HOME;
    default:
      return '/today';
  }
}

/** The original workspace tabs (S 2d: "The workspace tab bar is unchanged"; workspace-tabs.ts). */
export const DEFAULT_WORKSPACE_TABS: readonly WorkspaceTab[] = WORKSPACE_PHONE_TABS;

const MORE: WorkspaceTab = { to: `${WORKSPACE_PATH}/more`, label: 'More', icon: 'more_horiz' };

export const WORKSPACE_TABS_BY_KIND: Record<WorkspaceKind, readonly WorkspaceTab[]> = {
  coach: [
    { to: COACH_HOME, label: 'Week', icon: 'calendar_month' },
    { to: `${WORKSPACE_PATH}/teams`, label: 'Teams', icon: 'groups' },
    { to: WORKSPACE_PATH, label: 'Now', icon: 'stadium', end: true },
    { to: `${WORKSPACE_PATH}/messages`, label: 'Messages', icon: 'forum' },
    MORE,
  ],
  referee: [
    { to: REFEREE_HOME, label: 'Home', icon: 'home' },
    { to: WORKSPACE_PATH, label: 'Games', icon: 'sports_soccer', end: true },
    { to: `${WORKSPACE_PATH}/fees`, label: 'Pay', icon: 'payments' },
    {
      to: `${WORKSPACE_PATH}/report-problem`,
      label: 'Issues',
      icon: 'construction',
      also: [`${WORKSPACE_PATH}/issues`],
    },
    MORE,
  ],
  crew: [
    { to: CREW_HOME, label: 'Fields', icon: 'grass' },
    { to: '/facilities/board', label: 'Tasks', icon: 'handyman' },
    { to: `${WORKSPACE_PATH}/report-problem`, label: 'Report', icon: 'construction' },
    { to: `${WORKSPACE_PATH}/offline`, label: 'Queue', icon: 'sync' },
    MORE,
  ],
  default: DEFAULT_WORKSPACE_TABS,
};

/** The viewer's workspace kind, from `GET /v1/me` (the default tabs until it answers). */
export function useWorkspaceKind(): WorkspaceKind {
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  return workspaceKindOf(me.data?.principal.staffRoles ?? []);
}

/** The phone workspace tabs for the viewer. */
export function useWorkspaceTabs(): readonly WorkspaceTab[] {
  return WORKSPACE_TABS_BY_KIND[useWorkspaceKind()];
}
