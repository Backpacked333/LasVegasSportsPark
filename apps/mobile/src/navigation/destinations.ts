/**
 * The five primary destinations (SPK-UX-002) in tab order. The facility pass and the notification
 * inbox are deliberately not tabs: they are reachable from Home and from the header of every
 * destination (HeaderActions), and so is a cart in progress.
 *
 * Labels Home, Explore, Calendar, Teams and You are PA-11 (DEC-107, **Proposed**): the amended
 * SPK-UX-002 wording. Only the labels change; the route names stay (`discover`, `schedule`,
 * `account`), so links, the demo tour and every pathname keep working whichever way PA-11 is
 * decided.
 */
export interface Destination {
  /** Route file name under app/(tabs)/. */
  name: 'index' | 'discover' | 'schedule' | 'teams' | 'account';
  title: string;
  /** Screen id in docs/package-a/screen-and-journey-inventory.md. */
  screenId: string;
  /** Read by VoiceOver and TalkBack on the tab button. */
  accessibilityLabel: string;
  /** Decorative Material Symbols icon of the tab; hidden from screen readers. */
  icon: string;
}

export const DESTINATIONS: readonly Destination[] = [
  {
    name: 'index',
    title: 'Home',
    screenId: 'SCR-C-03',
    accessibilityLabel: 'Home: next activity, required actions and urgent changes',
    icon: 'home',
  },
  {
    name: 'discover',
    title: 'Explore',
    screenId: 'SCR-C-07',
    accessibilityLabel: 'Explore: leagues, programs, camps and other activities',
    icon: 'explore',
  },
  {
    name: 'schedule',
    title: 'Calendar',
    screenId: 'SCR-C-18',
    accessibilityLabel: 'Calendar: your and your family’s activities, week by week',
    icon: 'calendar_month',
  },
  {
    name: 'teams',
    title: 'Teams',
    screenId: 'SCR-C-21',
    accessibilityLabel: 'Teams: your teams, games and standings',
    icon: 'groups',
  },
  {
    name: 'account',
    title: 'You',
    screenId: 'SCR-C-30',
    accessibilityLabel: 'You: family, registrations, payments, forms and settings',
    icon: 'account_circle',
  },
];
