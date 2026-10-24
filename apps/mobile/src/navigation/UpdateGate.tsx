/**
 * SCR-C-39 "Update required" gate (§4.13, SPK-AT-027): once any response says this build is
 * below the minimum supported version, the update screen covers the app.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useApp } from '../providers/AppProviders';
import { UpdateRequiredScreen } from '../screens/update-required/UpdateRequiredScreen';

export function UpdateGate({ children }: { children: ReactNode }) {
  const { updateRequired, services } = useApp();
  return (
    <View style={{ flex: 1 }}>
      {children}
      {updateRequired ? (
        <UpdateRequiredScreen error={updateRequired} appVersion={services.config.appVersion} />
      ) : null}
    </View>
  );
}
