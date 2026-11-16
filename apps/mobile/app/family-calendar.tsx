// SCR-C-19 Family calendar is the "Everyone" filter of Calendar, SCR-C-18 (PA-11 SPK-UX-002,
// **Proposed**): Calendar has the person filters, week navigation and overlap warnings, so old links
// to /family-calendar open the Calendar tab with "Everyone" selected.
import { Redirect } from 'expo-router';

export default function FamilyCalendarRedirect() {
  return <Redirect href={{ pathname: '/schedule', params: { people: 'everyone' } }} />;
}
