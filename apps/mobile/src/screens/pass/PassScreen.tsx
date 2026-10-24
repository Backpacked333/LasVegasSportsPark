/**
 * SCR-C-05 Facility pass (SPK-UX-002, SPK-ENTRY-002). Reachable from Home and every destination
 * header, never a tab. Not built: the API has no read of the customer's own pass reference (only
 * staff issue `POST /v1/passes` and scan `POST /v1/passes/scan`), so the screen says so instead of
 * showing anything that looks like a pass.
 */
import { RequireSession } from '../../session/RequireSession';
import { Placeholder } from '../../ui/Placeholder';
import { Screen } from '../../ui/Screen';

export function PassScreen() {
  return (
    <Screen>
      <RequireSession what="your facility pass">
        <Placeholder
          screenId="SCR-C-05"
          title="Facility pass"
          purpose="An opaque scannable reference for you or your household, without child or household details. Waiting on an API read of the customer's own pass."
        />
      </RequireSession>
    </Screen>
  );
}
