// Root layout: device services and providers, then the root stack (src/navigation/RootNavigator).
import { AppProviders } from '../src/providers/AppProviders';
import { createDeviceServices } from '../src/providers/services';
import { RootNavigator } from '../src/navigation/RootNavigator';

const services = createDeviceServices();

export default function RootLayout() {
  return (
    <AppProviders services={services}>
      <RootNavigator />
    </AppProviders>
  );
}
