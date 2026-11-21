/**
 * The staff phone tab bar (redesign handoff S 1d; the design marks it Proposed): under 600 px the
 * rail becomes a floating glass tab bar like the workspace's, with Today, Scan (the arrival desk),
 * Schedule and Report (report a problem on a field), so a manager on the field has them under the
 * thumb. Everything else stays in the Menu drawer. A tab shows only when the API lists its area
 * for the viewer (Report: the workspace's problem report, which every staff member may file).
 * Hidden on workspace pages, which have their own tab bar.
 */
import type { NavigationAreaId } from '@sportspark/api-client';
import { NavLink, useLocation } from 'react-router';
import { usePermissions } from '../api/permissions';
import { WORKSPACE_PATH } from '../navigation/areas';
import { Glass } from '../ui/glass/Glass';
import { Icon, type IconName } from '../ui/Icon';
import { useRailBadges } from './RailBadges';
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery';

const TABS: readonly {
  to: string;
  label: string;
  icon: IconName;
  area: NavigationAreaId | null;
}[] = [
  { to: '/today', label: 'Today', icon: 'today', area: 'today' },
  { to: '/arrival', label: 'Scan', icon: 'qr_code_scanner', area: 'arrival' },
  { to: '/schedule', label: 'Schedule', icon: 'calendar_month', area: 'schedule' },
  { to: `${WORKSPACE_PATH}/report-problem`, label: 'Report', icon: 'construction', area: null },
];

export function PhoneTabBar() {
  const { pathname } = useLocation();
  const permissions = usePermissions();
  const badges = useRailBadges();
  const phone = useMediaQuery(PHONE_QUERY);
  if (!phone) return null;
  if (pathname === WORKSPACE_PATH || pathname.startsWith(`${WORKSPACE_PATH}/`)) return null;
  const tabs = TABS.filter((t) => t.area === null || permissions.isAreaVisible(t.area) === true);
  if (tabs.length === 0) return null;
  return (
    <nav className="staff-tabbar" aria-label="Quick tabs">
      <Glass radius={32} blur={5}>
        <ul>
          {tabs.map((tab) => {
            const badge = tab.area ? badges.get(tab.area) : undefined;
            return (
              <li key={tab.to}>
                <NavLink to={tab.to} className="staff-tab">
                  {({ isActive }) => (
                    <>
                      <Icon name={tab.icon} size={22} filled={isActive} />
                      <span>{tab.label}</span>
                      {badge && badge.count > 0 ? (
                        <span className="staff-tab-count" data-tone={badge.tone}>
                          {badge.count}
                          <span className="visually-hidden">: {badge.label}</span>
                        </span>
                      ) : null}
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </Glass>
    </nav>
  );
}
