/**
 * Root stack (SPK-UX-001 native navigation and back behaviour): the five-destination tabs, plus
 * the facility pass and the inbox as stack screens reachable from anywhere (SPK-UX-002). When the
 * API says this build must be updated, the update screen covers everything (SCR-C-39). The
 * connectivity state is announced to VoiceOver once for the app here, not by each screen's banner
 * (SPK-UX-009, src/connectivity/ConnectivityBanner.tsx). Headers and the navigation library's
 * own colours follow the theme in use (classic or Legends mode).
 */
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useMemo } from 'react';
import { ConnectivityAnnouncer } from '../connectivity/ConnectivityBanner';
import { fonts, useTheme, type Theme } from '../ui/theme';
import { UpdateGate } from './UpdateGate';

/**
 * Stack headers of the park system in the theme in use: a bar in the page colour, the back button
 * in the text colour, a condensed uppercase title.
 */
function stackHeader({ colors }: Theme) {
  return {
    headerBackTitle: 'Back',
    headerStyle: { backgroundColor: colors.page },
    headerShadowVisible: false,
    headerTintColor: colors.text,
    headerTitleStyle: { ...fonts.display, fontSize: 22, color: colors.text },
    contentStyle: { backgroundColor: colors.page },
  } as const;
}

/**
 * The navigation library's own colours (what shows behind a screen during a transition, default
 * header and tab colours), so nothing of the other theme flashes while navigating.
 */
function navigationTheme({ dark, colors }: Theme) {
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.page,
      card: colors.page,
      text: colors.text,
      border: colors.border,
      notification: colors.danger,
    },
  };
}

export function RootNavigator() {
  const theme = useTheme();
  const screenOptions = useMemo(() => stackHeader(theme), [theme]);
  const navigation = useMemo(() => navigationTheme(theme), [theme]);
  return (
    <ThemeProvider value={navigation}>
      <ConnectivityAnnouncer />
      <UpdateGate>
        <Stack screenOptions={screenOptions}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="pass" options={{ title: 'Facility pass' }} />
          <Stack.Screen name="inbox" options={{ title: 'Notifications' }} />
          <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
          <Stack.Screen name="onboarding" options={{ title: 'Account setup' }} />
          <Stack.Screen name="recovery" options={{ title: 'Account recovery' }} />
          <Stack.Screen name="invitations/index" options={{ title: 'Invitations' }} />
          <Stack.Screen name="invitations/[id]" options={{ title: 'Invitation' }} />
          <Stack.Screen name="family" options={{ title: 'Family and permissions' }} />
          <Stack.Screen name="forms" options={{ title: 'Forms and acknowledgments' }} />
          <Stack.Screen name="preferences" options={{ title: 'Preferences' }} />
          <Stack.Screen name="link" options={{ title: 'Link' }} />
          <Stack.Screen name="family-calendar" options={{ title: 'Family calendar' }} />
          <Stack.Screen name="fixtures/[id]" options={{ title: 'Fixture' }} />
          <Stack.Screen name="sessions/[sessionId]" options={{ title: 'Activity' }} />
          {/* Package G (conditional, behind their capability switches; reached from Account). */}
          <Stack.Screen name="bookings/index" options={{ title: 'Rentals and parties' }} />
          <Stack.Screen name="bookings/[id]" options={{ title: 'Booking' }} />
          <Stack.Screen name="bookings/new/[offeringId]" options={{ title: 'Book' }} />
          <Stack.Screen name="memberships/index" options={{ title: 'Memberships' }} />
          <Stack.Screen name="session-packages/index" options={{ title: 'Session packages' }} />
          <Stack.Screen name="pos-receipts/index" options={{ title: 'Point-of-sale receipts' }} />
          <Stack.Screen name="+not-found" options={{ title: 'Not available' }} />
        </Stack>
      </UpdateGate>
    </ThemeProvider>
  );
}
