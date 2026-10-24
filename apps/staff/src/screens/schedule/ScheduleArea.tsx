/**
 * Schedule area (SPK-UX-005): SCR-S-03 calendar and resources, SCR-S-04 drafts, SCR-S-05
 * publication review, SCR-S-06 closures, SCR-S-07 resource inventory. The conditional screens
 * SCR-S-51 Rentals and SCR-S-52 Parties stay in the area as pending decisions (inventory section 5:
 * "no answer yet keeps them in the inventory"); they are not built.
 */
import { Navigate, Route, Routes } from 'react-router';
import { SubNav } from '../../features/schedule-facilities/SubNav';
import '../../features/schedule-facilities/schedule-facilities.css';
import { StateView } from '../../ui/StateView';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { ClosureDetailScreen } from './ClosureDetailScreen';
import { ClosuresScreen } from './ClosuresScreen';
import { PublicationReviewScreen } from './PublicationReviewScreen';
import { ResourceInventoryScreen } from './ResourceInventoryScreen';
import { ScheduleCalendarScreen } from './ScheduleCalendarScreen';
import { ScheduleDraftEditorScreen } from './ScheduleDraftEditorScreen';
import { ScheduleDraftsScreen } from './ScheduleDraftsScreen';

const SECTIONS = [
  { to: 'calendar', label: 'Calendar and resources' },
  { to: 'drafts', label: 'Drafts and publication' },
  { to: 'closures', label: 'Closures' },
  { to: 'resources', label: 'Resource inventory' },
  { to: 'rentals', label: 'Rentals' },
  { to: 'parties', label: 'Parties' },
] as const;

function ConditionalScreen({
  id,
  title,
  decision,
}: {
  id: string;
  title: string;
  decision: string;
}) {
  return (
    <section aria-labelledby={`conditional-${id}`}>
      <h3 id={`conditional-${id}`}>{title}</h3>
      <StateView
        variant="pending-decision"
        subject={`${title} (${id}, a conditional capability)`}
        decisions={[decision, 'DEC-016', 'DEC-047']}
        owner="Product owner; for DEC-047 also the Migration owner/operator"
      />
    </section>
  );
}

export function ScheduleArea() {
  return (
    <section aria-labelledby="area-schedule">
      <h2 id="area-schedule">Schedule</h2>
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
        <Route
          path="rentals"
          element={<ConditionalScreen id="SCR-S-51" title="Rentals" decision="DEC-076" />}
        />
        <Route
          path="parties"
          element={<ConditionalScreen id="SCR-S-52" title="Parties" decision="DEC-077" />}
        />
        <Route path="*" element={<NotFoundScreen />} />
      </Routes>
    </section>
  );
}
