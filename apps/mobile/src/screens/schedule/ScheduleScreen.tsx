/**
 * SCR-C-18 Schedule (SPK-UX-002, SPK-SCHED-008). Shell only: personal and authorised family
 * activities in facility local time, with material changes shown as old and new details.
 */
import { RequireSession } from '../../session/RequireSession';
import { Placeholder } from '../../ui/Placeholder';
import { Screen } from '../../ui/Screen';

export function ScheduleScreen() {
  return (
    <Screen>
      <RequireSession what="your schedule">
        <Placeholder
          screenId="SCR-C-18, SCR-C-19"
          title="Schedule"
          purpose="Your activities and those of family members you are authorised to see, in facility local time."
        />
      </RequireSession>
    </Screen>
  );
}
