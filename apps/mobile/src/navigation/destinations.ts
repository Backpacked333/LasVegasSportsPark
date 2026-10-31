/**
 * The five primary destinations (SPK-UX-002) in tab order. The facility pass and the notification
 * inbox are deliberately not tabs: they are reachable from Home and from the header of every
 * destination (QuickAccess).
 */
export interface Destination {
  /** Route file name under app/(tabs)/. */
  name: 'index' | 'discover' | 'schedule' | 'teams' | 'account';
  title: string;
  /** Screen id in docs/package-a/screen-and-journey-inventory.md. */
  screenId: string;
  /** Read by VoiceOver and TalkBack on the tab button. */
  accessibilityLabel: string;
  /** Decorative glyph; hidden from screen readers. */
  glyph: string;
}

export const DESTINATIONS: readonly Destination[] = [
  {
    name: 'index',
    title: 'Home',
    screenId: 'SCR-C-03',
    accessibilityLabel: 'Home: next activity, required actions and urgent changes',
    glyph: '⌂',
  },
  {
    name: 'discover',
    title: 'Discover',
    screenId: 'SCR-C-07',
    accessibilityLabel: 'Discover: leagues, programs, camps and other activities',
    glyph: '◎',
  },
  {
    name: 'schedule',
    title: 'Schedule',
    screenId: 'SCR-C-18',
    accessibilityLabel: 'Schedule: your and your family’s activities',
    glyph: '▦',
  },
  {
    name: 'teams',
    title: 'Teams',
    screenId: 'SCR-C-21',
    accessibilityLabel: 'Teams: team workspaces, fixtures and standings',
    glyph: '◆',
  },
  {
    name: 'account',
    title: 'Account',
    screenId: 'SCR-C-30',
    accessibilityLabel: 'Account: family, enrollments, payments and preferences',
    glyph: '●',
  },
];
