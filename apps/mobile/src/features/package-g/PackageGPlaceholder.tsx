/**
 * The screen a customer Package G flow shows until its screen group builds it (§3.16, §6.5): the
 * frame, the session requirement, and behind its `CapabilityGate` the "not built yet" marker with
 * what stays pending once the capability is on. While the switch is off (DEC-016; every switch
 * starts off) the gate shows the turned-off state; `whenOff="notice"` keeps the page under the
 * notice for what the customer already has (the API keeps those reads available).
 */
import type { CapabilityId } from '@sportspark/api-client';
import { View } from 'react-native';
import { RequireSession } from '../../session/RequireSession';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { Placeholder } from '../../ui/Placeholder';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';

export interface PackageGPlaceholderProps {
  /** The flow's reference, e.g. "Package G rentals and parties (SPK-COND-003)". */
  reference: string;
  title: string;
  purpose: string;
  capability: CapabilityId | readonly CapabilityId[];
  /** What the session prompt asks to see, e.g. "your bookings". */
  what: string;
  whenOff?: 'block' | 'notice';
  stillAvailable?: string;
  pending?: { subject: string; decisions: readonly string[]; owner?: string };
  testID: string;
}

export function PackageGPlaceholder({
  reference,
  title,
  purpose,
  capability,
  what,
  whenOff = 'block',
  stillAvailable,
  pending,
  testID,
}: PackageGPlaceholderProps) {
  return (
    <Screen>
      <View testID={testID}>
        <RequireSession what={what}>
          <CapabilityGate
            capability={capability}
            subject={title}
            whenOff={whenOff}
            stillAvailable={stillAvailable}
          >
            <Placeholder screenId={reference} title={title} purpose={purpose} />
            {pending ? (
              <StateView
                variant="pending-decision"
                subject={pending.subject}
                decisions={[...pending.decisions]}
                owner={pending.owner}
              />
            ) : null}
          </CapabilityGate>
        </RequireSession>
      </View>
    </Screen>
  );
}
