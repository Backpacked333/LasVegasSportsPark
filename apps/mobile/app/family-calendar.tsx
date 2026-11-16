// Route file only: the screen lives in src/screens/family-calendar/FamilyCalendarScreen.tsx (SCR-C-19).
// PA-11 (**Proposed**) folds this screen into Calendar as its "Everyone" filter. Until Calendar has
// the person filters, week navigation and overlap warnings, this route keeps rendering the family
// calendar itself, so existing links lose nothing.
export { FamilyCalendarScreen as default } from '../src/screens/family-calendar/FamilyCalendarScreen';
