/**
 * Schedule area (SPK-UX-005): SCR-S-03 calendar and resources, SCR-S-04 drafts, SCR-S-05
 * publication review, SCR-S-06 closures, SCR-S-07 resource inventory. The conditional screens
 * SCR-S-51 Rentals and SCR-S-52 Parties live in their own directories under
 * src/screens/package-g/ and are nested here, behind their capability switches (DEC-016, DEC-076,
 * DEC-077; inventory section 5: "no answer yet keeps them in the inventory"). "Public schedule"
 * is the switch and the links of the facility's public and lobby schedule (SPK-SCHED-010,
 * proposed amendment PA-06; capability `public_schedule`, pending DEC-100).
 */
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { DaySummaryLine } from '../../features/schedule-facilities/DaySummary';
import { SubNav } from '../../features/schedule-facilities/SubNav';
import '../../features/schedule-facilities/schedule-facilities.css';
import { PageHeader } from '../../ui/Page';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { PartiesScreen } from '../package-g/parties/PartiesScreen';
import { RentalsScreen } from '../package-g/rentals/RentalsScreen';
import { ClosureDetailScreen } from './ClosureDetailScreen';
import { ClosuresScreen } from './ClosuresScreen';
import { PublicationReviewScreen } from './PublicationReviewScreen';
import { PublicScheduleSettingsScreen } from './PublicScheduleSettingsScreen';
import { ResourceInventoryScreen } from './ResourceInventoryScreen';
import { ScheduleCalendarScreen } from './ScheduleCalendarScreen';
import { ScheduleDraftEditorScreen } from './ScheduleDraftEditorScreen';
import { ScheduleDraftsScreen } from './ScheduleDraftsScreen';

// Absolute paths: a relative link inside the `/schedule/*` splat route resolves against the
// current page (from /schedule/calendar, "rentals" would open /schedule/calendar/rentals).
const SECTIONS = [
  { to: '/schedule/calendar', label: 'Calendar and resources' },
  { to: '/schedule/drafts', label: 'Drafts and publication' },
  { to: '/schedule/closures', label: 'Closures' },
  { to: '/schedule/resources', label: 'Resource inventory' },
  { to: '/schedule/rentals', label: 'Rentals' },
  { to: '/schedule/parties', label: 'Parties' },
  { to: '/schedule/public', label: 'Public schedule' },
] as const;

export function ScheduleArea() {
  const { pathname } = useLocation();
  // The day timeline and week (S 1b, S 2b) carry their own header; the other sections keep tabs.
  const calendar = /^\/schedule(\/calendar)?\/?$/.test(pathname);
  if (calendar) {
    return (
      <section aria-labelledby="area-schedule" className="area-stack">
        <Routes>
          <Route index element={<Navigate to="calendar" replace />} />
          <Route path="calendar" element={<ScheduleCalendarScreen />} />
        </Routes>
      </section>
    );
  }
  return (
    <section aria-labelledby="area-schedule" className="area-stack">
      <PageHeader
        eyebrow={
          <>
            Operate · Spaces, bookings and closures
            <DaySummaryLine />
          </>
        }
        title="Schedule"
        titleId="area-schedule"
      />
      <SubNav label="Schedule sections" items={SECTIONS} />
      <Routes>
        <Route index element={<Navigate to="calendar" replace />} />
        <Route path="calendar" element={<ScheduleCalendarScreen />} />
        <Route path="drafts" element={<ScheduleDraftsScreen />} />
        <Route path="drafts/:draftId" element={<ScheduleDraftEditorScreen />} />
        <Route path="drafts/:draftId/publish" element={<PublicationReviewScreen />} />
        <Route path="closures" element={<ClosuresScreen />} />
        <Route path="closures/:closureId" element={<ClosureDetailScreen />} />
        <Route path="resources" element={<ResourceInventoryScreen />} />
        <Route path="rentals/*" element={<RentalsScreen />} />
        <Route path="parties/*" element={<PartiesScreen />} />
        <Route path="public" element={<PublicScheduleSettingsScreen />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Routes>
    </section>
  );
}
