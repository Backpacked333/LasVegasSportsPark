/**
 * The device's safe-area insets for screens that draw their own top or bottom (the full-bleed
 * pages of the redesign: the activity, Register, the waitlist offer, the pass). Zero without a
 * `SafeAreaProvider` (component tests), as `Toast` reads them.
 */
import { useContext } from 'react';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';

const NONE: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function useInsets(): EdgeInsets {
  return useContext(SafeAreaInsetsContext) ?? NONE;
}
