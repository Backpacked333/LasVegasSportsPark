/**
 * SCR-C-39 "Update required" gate (§4.13, SPK-AT-027): once any response says this build is
 * below the minimum supported version, the update screen covers the app.
 *
 * Covering it is not enough for screen readers (SPK-UX-009, R4-CLIENTS-A11Y-COPY-04): the app
 * stays mounted under the overlay (unmounting the navigator would lose its state), and
 * `accessibilityViewIsModal` on the overlay is iOS only. So while the update screen shows, the app
 * underneath is removed from the accessibility tree on both platforms
 * (`importantForAccessibility="no-hide-descendants"` for TalkBack, `accessibilityElementsHidden`
 * for VoiceOver): TalkBack can no longer move to, or activate, the controls it covers. The update
 * screen announces itself when it appears (`ui/announce`).
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useApp } from '../providers/AppProviders';
import { UpdateRequiredScreen } from '../screens/update-required/UpdateRequiredScreen';

export function UpdateGate({ children }: { children: ReactNode }) {
  const { updateRequired, services } = useApp();
  const covered = updateRequired !== null;
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{ flex: 1 }}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={covered}
        testID="update-gate-content"
      >
        {children}
      </View>
      {updateRequired ? (
        <UpdateRequiredScreen error={updateRequired} appVersion={services.config.appVersion} />
      ) : null}
    </View>
  );
}
