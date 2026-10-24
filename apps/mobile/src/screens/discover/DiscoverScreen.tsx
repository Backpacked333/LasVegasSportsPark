/**
 * SCR-C-07 Discover (SPK-UX-002, SPK-CAT-001). Shell only: leagues, programs, camps, trials,
 * pickup and rentals with registration-window state. Pickup sessions and rentals are conditional
 * capabilities pending DEC-016/DEC-072 to DEC-082 (Product owner).
 */
import { Placeholder } from '../../ui/Placeholder';
import { Screen } from '../../ui/Screen';

export function DiscoverScreen() {
  return (
    <Screen>
      <Placeholder
        screenId="SCR-C-07"
        title="Discover"
        purpose="Leagues, programs, camps, trials, pickup and available rentals, each with its registration window."
      />
    </Screen>
  );
}
