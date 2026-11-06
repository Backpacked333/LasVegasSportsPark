/**
 * Facilities and maintenance area (SPK-UX-005): SCR-S-41 assets and maintenance tasks, SCR-S-42
 * operating restrictions and release to service.
 */
import { Link, Navigate, Route, Routes } from 'react-router';
import { Icon } from '../../ui/Icon';
import { PageHeader } from '../../ui/Page';
import { SubNav } from '../../features/schedule-facilities/SubNav';
import '../../features/schedule-facilities/schedule-facilities.css';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { MaintenanceScreen } from './MaintenanceScreen';
import { MaintenanceTaskScreen } from './MaintenanceTaskScreen';
import { RestrictionDetailScreen } from './RestrictionDetailScreen';
import { RestrictionsScreen } from './RestrictionsScreen';

const SECTIONS = [
  { to: 'maintenance', label: 'Assets and maintenance tasks' },
  { to: 'restrictions', label: 'Operating restrictions' },
] as const;

export function FacilitiesArea() {
  return (
    <section aria-labelledby="area-facilities" className="area-stack">
      <PageHeader
        eyebrow="Operate · Restrictions, work orders and assets"
        title="Facilities and maintenance"
        titleId="area-facilities"
        actions={
          <Link className="button button-primary" to="/facilities/maintenance#report">
            <Icon name="add" size={19} />
            Report a problem
          </Link>
        }
      />
      <SubNav label="Facilities sections" items={SECTIONS} />
      <Routes>
        <Route index element={<Navigate to="maintenance" replace />} />
        <Route path="maintenance" element={<MaintenanceScreen />} />
        <Route path="maintenance/tasks/:taskId" element={<MaintenanceTaskScreen />} />
        <Route path="restrictions" element={<RestrictionsScreen />} />
        <Route path="restrictions/:restrictionId" element={<RestrictionDetailScreen />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Routes>
    </section>
  );
}
