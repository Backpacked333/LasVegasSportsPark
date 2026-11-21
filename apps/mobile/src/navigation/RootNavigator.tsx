/**
 * Root stack (SPK-UX-001 native navigation and back behaviour): the five-destination tabs, plus
 * the facility pass (a modal over whatever is open) and the inbox as stack screens reachable from
 * anywhere (SPK-UX-002). Stack titles are plain customer words (PA-11 SPK-UX-011, **Proposed**):
 * Cart, Review, Checkout, Payments, Registrations, Forms and waivers, Family. When the
 * API says this build must be updated, the update screen covers everything (SCR-C-39). The
 * connectivity state is announced to VoiceOver once for the app here, not by each screen's banner
 * (SPK-UX-009, src/connectivity/ConnectivityBanner.tsx). Headers and the navigation library's
 * own colours follow the theme in use (classic or Legends mode). Screen transitions follow
 * `useMotion()` like every other animation (ADR-008): with reduced motion a pushed screen appears
 * at once (`animation: 'none'`); otherwise the platform's own transition plays.
 */
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useMemo } from 'react';
import { ConnectivityAnnouncer } from '../connectivity/ConnectivityBanner';
import { DemoOverlay } from '../demo';
import { useMotion } from '../ui/motion';
import { fonts, useTheme, type Theme } from '../ui/theme';
import { UpdateGate } from './UpdateGate';

/**
 * Stack headers of the park system in the theme in use: a bar in the page colour, the back button
 * in the text colour, a condensed uppercase title.
 */
export function stackHeader({ colors }: Theme, reducedMotion: boolean) {
  return {
    animation: reducedMotion ? ('none' as const) : ('default' as const),
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
  const motion = useMotion();
  const screenOptions = useMemo(() => stackHeader(theme, motion.reduced), [theme, motion.reduced]);
  const navigation = useMemo(() => navigationTheme(theme), [theme]);
  return (
    <ThemeProvider value={navigation}>
      <ConnectivityAnnouncer />
      <UpdateGate>
        <Stack screenOptions={screenOptions}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="pass" options={{ title: 'Facility pass', presentation: 'modal' }} />
          <Stack.Screen name="inbox" options={{ title: 'Inbox' }} />
          <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
          <Stack.Screen name="onboarding" options={{ title: 'Account setup' }} />
          <Stack.Screen name="recovery" options={{ title: 'Account recovery' }} />
          <Stack.Screen name="invitations/index" options={{ title: 'Invitations' }} />
          <Stack.Screen name="invitations/[id]" options={{ title: 'Invitation' }} />
          <Stack.Screen name="family" options={{ title: 'Family' }} />
          <Stack.Screen name="forms" options={{ title: 'Forms and waivers' }} />
          <Stack.Screen name="preferences" options={{ title: 'Notifications and calendar' }} />
          <Stack.Screen name="link" options={{ title: 'Link' }} />
          <Stack.Screen name="registration/basket/[basketId]" options={{ title: 'Cart' }} />
          <Stack.Screen name="registration/quote/[quoteId]" options={{ title: 'Review' }} />
          <Stack.Screen name="registration/checkout/[quoteId]" options={{ title: 'Checkout' }} />
          <Stack.Screen name="payments/index" options={{ title: 'Payments' }} />
          <Stack.Screen name="enrollments/index" options={{ title: 'Registrations' }} />
          {/* Game day draws its own back button and title on the team's band (handoff M 1i). */}
          <Stack.Screen name="fixtures/[id]" options={{ title: 'Game', headerShown: false }} />
          <Stack.Screen name="sessions/[sessionId]" options={{ title: 'Activity' }} />
          {/* Package G (conditional, behind their capability switches; reached from Account). */}
          <Stack.Screen name="bookings/index" options={{ title: 'Rentals and parties' }} />
          <Stack.Screen name="bookings/[id]" options={{ title: 'Booking' }} />
          <Stack.Screen name="bookings/new/[offeringId]" options={{ title: 'Book' }} />
          <Stack.Screen name="memberships/index" options={{ title: 'Memberships' }} />
          <Stack.Screen name="session-packages/index" options={{ title: 'Class packs' }} />
          <Stack.Screen name="pos-receipts/index" options={{ title: 'In-person receipts' }} />
          {/* Parent-app redesign Phase 3 (handoff M 3e, 5c, 3h, 4c, 4d, 4a, 4b). */}
          <Stack.Screen name="people/[id]/index" options={{ title: '' }} />
          <Stack.Screen
            name="people/[id]/care-notes"
            options={{ headerShown: false, presentation: 'modal', gestureEnabled: false }}
          />
          <Stack.Screen name="people/new" options={{ headerShown: false, presentation: 'modal' }} />
          <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
          <Stack.Screen name="messages/coach" options={{ headerShown: false }} />
          <Stack.Screen name="payments/receipt/[paymentId]" options={{ title: '' }} />
          <Stack.Screen name="payments/all" options={{ title: 'All payments' }} />
          <Stack.Screen name="+not-found" options={{ title: 'Not available' }} />
        </Stack>
        {DemoOverlay ? <DemoOverlay /> : null}
      </UpdateGate>
    </ThemeProvider>
  );
}
