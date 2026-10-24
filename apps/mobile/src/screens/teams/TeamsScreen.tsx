/**
 * SCR-C-21 Teams (SPK-UX-002, SPK-CAP-001). Shell only: team workspaces, next fixture, standings
 * and readiness, with entry to create or renew a team entry.
 */
import { RequireSession } from '../../session/RequireSession';
import { Placeholder } from '../../ui/Placeholder';
import { Screen } from '../../ui/Screen';

export function TeamsScreen() {
  return (
    <Screen>
      <RequireSession what="your teams">
        <Placeholder
          screenId="SCR-C-21"
          title="Teams"
          purpose="Your teams and the teams of family members you are authorised to see: fixtures, availability and standings."
        />
      </RequireSession>
    </Screen>
  );
}
