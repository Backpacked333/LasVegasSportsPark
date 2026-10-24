/**
 * Workspace screens for one assigned activity (SPK-UX-007), phone-width:
 *
 * - SCR-W-04 Session attendance (coach): the SCR-S-29 attendance panel for the assigned activity
 *   (SPK-ENTRY-001, SPK-ENTRY-005, §4.15, SPK-AT-018, DEC-032, DEC-033). The entry API serves an
 *   assigned coach or official only with an accepted assignment; anything else is not available.
 * - SCR-W-09 Supervised release (coach): the SCR-S-30 release flow for the coach's own session,
 *   children from its attendance, with the same online authority check (SPK-ENTRY-007, DEC-005,
 *   DEC-034, DEC-075).
 * - SCR-W-06 Permitted communication: not offered. The API lists no message action for an
 *   assignment (`availableActions`) and coaches and officials are not composer roles; the
 *   communication policy is DEC-012/DEC-062 (pending).
 * - SCR-W-07 Assessments: pending DEC-054 (Package G); the API has no assessment endpoints.
 */
import { activityFromAssignment } from '../../features/operations/activity';
import { AreaTabs, WORKSPACE_TABS } from '../../features/operations/AreaTabs';
import { formatRange } from '../../features/operations/format';
import { StateView } from '../../ui/StateView';
import { AttendancePanel } from '../arrival/AttendancePanel';
import { ReleasePanel } from '../arrival/ReleasePanel';
import { MyAssignmentPage } from './MyAssignment';

export function WorkspaceAttendanceScreen() {
  return (
    <MyAssignmentPage title={(item) => `Attendance${item ? `: ${item.activity.title}` : ''}`}>
      {(item) => {
        const activity = activityFromAssignment(item.assignment);
        if (!activity) {
          return (
            <StateView
              variant="unavailable"
              description="Attendance is not available for this assignment: it is not linked to a scheduled activity."
            />
          );
        }
        return (
          <>
            <p className="caption">
              {formatRange(item.activity.scheduledStart, item.activity.scheduledEnd)}
            </p>
            <AttendancePanel
              activity={activity}
              facilityId={item.activity.facilityId}
              timezone={null}
              title={`Record attendance: ${item.activity.title}`}
            />
          </>
        );
      }}
    </MyAssignmentPage>
  );
}

export function WorkspaceReleaseScreen() {
  return (
    <MyAssignmentPage
      title={(item) => `Supervised release${item ? `: ${item.activity.title}` : ''}`}
    >
      {(item) => {
        const activity = activityFromAssignment(item.assignment);
        if (!activity || item.assignment.targetType !== 'session') {
          return (
            <StateView
              variant="unavailable"
              description="Supervised release from the workspace is for your own program session."
            />
          );
        }
        return (
          <ReleasePanel facilityId={item.activity.facilityId} timezone={null} activity={activity} />
        );
      }}
    </MyAssignmentPage>
  );
}

export function WorkspaceMessageScreen() {
  return (
    <MyAssignmentPage
      title={(item) => `Message participants${item ? `: ${item.activity.title}` : ''}`}
    >
      {() => (
        <>
          <StateView
            variant="unavailable"
            title="Messaging is not available here yet"
            description="The service does not offer messaging for this assignment. Ask the league or program manager to send operational messages to its participants."
          />
          <StateView
            variant="pending-decision"
            subject="Messages from coaches and officials"
            decisions={['DEC-012', 'DEC-062']}
            owner="Operator/privacy owner"
          />
        </>
      )}
    </MyAssignmentPage>
  );
}

export function AssessmentsScreen() {
  return (
    <section aria-labelledby="assessments-title">
      <h2 id="assessments-title">Assessments</h2>
      <AreaTabs label="Workspace screens" tabs={WORKSPACE_TABS} />
      <StateView
        variant="pending-decision"
        subject="Recording assessments on approved templates"
        decisions={['DEC-054']}
        owner="Program manager; Operator/privacy owner"
      />
      <p className="caption">
        No assessment template is approved and the service does not record assessments yet (youth
        progression is planned for a later package), so nothing can be recorded here.
      </p>
    </section>
  );
}
