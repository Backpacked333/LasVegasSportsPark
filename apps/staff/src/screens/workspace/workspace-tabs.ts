/**
 * The coach and referee workspace's phone tabs (SPK-UX-007; staff S 2d "the workspace tab bar is
 * unchanged") and the full-screen flows that hide them (S 3g pickup). One list, so a new tab or a
 * new coach home (redesign Phase 8 "Coach · My week": Week · Teams · Now · Messages · More) is a
 * change here only.
 */
import { WORKSPACE_PATH } from '../../navigation/areas';
import type { IconName } from '../../ui/Icon';

export interface WorkspaceTab {
  to: string;
  label: string;
  icon: IconName;
  /** Current only on this exact path (the workspace home). */
  end?: boolean;
  /** Other paths this tab is current on (a flow reached from it). */
  also?: readonly string[];
}

export const WORKSPACE_PHONE_TABS: readonly WorkspaceTab[] = [
  { to: WORKSPACE_PATH, label: 'Now', icon: 'stadium', end: true },
  { to: `${WORKSPACE_PATH}/assessments`, label: 'Assess', icon: 'checklist' },
  { to: `${WORKSPACE_PATH}/fees`, label: 'Fees', icon: 'payments' },
  {
    to: `${WORKSPACE_PATH}/issues`,
    label: 'Issues',
    icon: 'construction',
    also: [`${WORKSPACE_PATH}/report-problem`],
  },
  { to: `${WORKSPACE_PATH}/offline`, label: 'Queue', icon: 'sync' },
];

/** Workspace pages drawn full screen, without the tab bar (a task with its own close or back). */
export const FULL_SCREEN_PATTERNS: readonly RegExp[] = [
  /^\/workspace\/assignments\/[^/]+\/pickup\/?$/,
];

export function isFullScreenWorkspacePath(pathname: string): boolean {
  return FULL_SCREEN_PATTERNS.some((p) => p.test(pathname));
}

/** Whether a tab is the current one at a path (its own path, below it, or one of `also`). */
export function isTabCurrent(tab: WorkspaceTab, pathname: string): boolean {
  const path = pathname.replace(/\/$/, '') || '/';
  const under = (p: string) => path === p || path.startsWith(`${p}/`);
  if (tab.end) return path === tab.to;
  return under(tab.to) || (tab.also ?? []).some(under);
}
