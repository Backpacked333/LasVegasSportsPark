// Root layout: the bundled fonts (src/ui/theme FONT_ASSETS), device services and providers, then
// the root stack (src/navigation/RootNavigator). Nothing renders until the fonts are loaded or
// failed to load; a failed load falls back to system fonts of the same weight.
//
// Around everything, the gesture-handler root that gestures and sheets need. Inside the providers:
// glass (src/ui/GlassSurface) and motion (src/ui/motion) where the device offers them, then the
// bottom-sheet provider, so sheets render above the navigator with every context available
// (ADR-008). src/testing/test-app.tsx mirrors this, without motion.
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppProviders } from '../src/providers/AppProviders';
import { consoleCrashReporter, installGlobalCrashHandler } from '../src/providers/crash-report';
import { createDeviceServices } from '../src/providers/services';
import { RootNavigator } from '../src/navigation/RootNavigator';
import { ErrorBoundary } from '../src/ui/ErrorBoundary';
import { GlassProvider } from '../src/ui/GlassSurface';
import { MotionProvider } from '../src/ui/motion';
import { FONT_ASSETS } from '../src/ui/theme';
import { ToastProvider } from '../src/ui/Toast';

const services = createDeviceServices();
const reporter = services.crashReporter ?? consoleCrashReporter;
// Errors no screen caught (SPK-UX-006, §5.11): reported, then React Native's own handling.
installGlobalCrashHandler(reporter, services.now);

export default function RootLayout() {
  const [loaded, error] = useFonts(FONT_ASSETS);
  if (!loaded && !error) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppProviders services={services}>
        <ErrorBoundary reporter={reporter} now={services.now}>
          {/* Glass where the device offers it (src/ui/GlassSurface); solid everywhere else. */}
          <GlassProvider>
            {/* Motion follows the device's reduce-motion setting (src/ui/motion). */}
            <MotionProvider>
              <BottomSheetModalProvider>
                <ToastProvider>
                  <RootNavigator />
                </ToastProvider>
              </BottomSheetModalProvider>
            </MotionProvider>
          </GlassProvider>
        </ErrorBoundary>
      </AppProviders>
    </GestureHandlerRootView>
  );
}
