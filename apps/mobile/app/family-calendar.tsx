// SCR-C-19 Family calendar becomes the "Everyone" filter of Calendar (PA-11 SPK-UX-002,
// **Proposed**): old links to /family-calendar open the Calendar tab with that filter. The screen
// itself stays in src/screens/family-calendar/FamilyCalendarScreen.tsx until Calendar is rebuilt.
import { Redirect } from 'expo-router';

export default function FamilyCalendarRedirect() {
  return <Redirect href={{ pathname: '/schedule', params: { people: 'everyone' } }} />;
}
