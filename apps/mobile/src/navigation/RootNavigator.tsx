/**
 * Root stack (SPK-UX-001 native navigation and back behaviour): the five-destination tabs, plus
 * the facility pass and the inbox as stack screens reachable from anywhere (SPK-UX-002). When the
 * API says this build must be updated, the update screen covers everything (SCR-C-39).
 */
import { Stack } from 'expo-router';
import { UpdateGate } from './UpdateGate';

export function RootNavigator() {
  return (
    <UpdateGate>
      <Stack screenOptions={{ headerBackTitle: 'Back' }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pass" options={{ title: 'Facility pass' }} />
        <Stack.Screen name="inbox" options={{ title: 'Notifications' }} />
        <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
        <Stack.Screen name="family-calendar" options={{ title: 'Family calendar' }} />
        <Stack.Screen name="fixtures/[id]" options={{ title: 'Fixture' }} />
        <Stack.Screen name="sessions/[sessionId]" options={{ title: 'Activity' }} />
        <Stack.Screen name="+not-found" options={{ title: 'Not available' }} />
      </Stack>
    </UpdateGate>
  );
}
