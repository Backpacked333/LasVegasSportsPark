// Root layout: the bundled fonts (src/ui/theme FONT_ASSETS), device services and providers, then
// the root stack (src/navigation/RootNavigator). Nothing renders until the fonts are loaded or
// failed to load; a failed load falls back to system fonts of the same weight.
import { useFonts } from 'expo-font';
import { AppProviders } from '../src/providers/AppProviders';
import { consoleCrashReporter, installGlobalCrashHandler } from '../src/providers/crash-report';
import { createDeviceServices } from '../src/providers/services';
import { RootNavigator } from '../src/navigation/RootNavigator';
import { ErrorBoundary } from '../src/ui/ErrorBoundary';
import { FONT_ASSETS } from '../src/ui/theme';

const services = createDeviceServices();
const reporter = services.crashReporter ?? consoleCrashReporter;
// Errors no screen caught (SPK-UX-006, §5.11): reported, then React Native's own handling.
installGlobalCrashHandler(reporter, services.now);

export default function RootLayout() {
  const [loaded, error] = useFonts(FONT_ASSETS);
  if (!loaded && !error) return null;
  return (
    <AppProviders services={services}>
      <ErrorBoundary reporter={reporter} now={services.now}>
        <RootNavigator />
      </ErrorBoundary>
    </AppProviders>
  );
}
