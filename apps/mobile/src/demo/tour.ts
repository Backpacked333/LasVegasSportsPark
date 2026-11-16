/**
 * The family demo: who it signs in as and the guided tour through the customer app. The parent
 * account and its child come from the development seed (apps/api/src/dev/seed-dev.ts); what the
 * tour describes (a class today, a team, an amount owed, a waiver to accept, an invitation to a
 * rental roster, classes and a camp to register for) comes from the demo dataset `pnpm demo`
 * seeds on top of it (apps/api/src/dev/seed-demo.ts, ADR-007). Staff roles are demonstrated in
 * the staff dashboard.
 *
 * A step opens a screen of the app by its route. The class and camp steps open Discover and say
 * which offering to open, because an offering's route carries an id that differs per database.
 */
export interface TourStep {
  /** Expo Router path the step opens. */
  path: string;
  title: string;
  body: string;
}

export const DEMO_PARENT_SUBJECT = 'dev-parent';

export const FAMILY_TOUR: readonly TourStep[] = [
  {
    path: '/',
    title: 'Home',
    body: 'Changes that affect the family come first, then the next activity, then anything the family needs to do. Today that is a class, an amount owed and a waiver to accept.',
  },
  {
    path: '/discover',
    title: 'Discover',
    body: 'Programs, camps and leagues the family can join, with places left and the price before any commitment.',
  },
  {
    path: '/discover',
    title: 'Class prices explained',
    body: 'Open Skills academy: the price is per class, for the classes still to come. Open Futsal club to see the member price beside the standard one.',
  },
  {
    path: '/discover',
    title: 'Camp by the week or by the day',
    body: 'Open Holiday camp week and start a registration: choose the full week or single days, then lunch, early drop-off and a jersey size. Each choice is its own line on the price.',
  },
  {
    path: '/forms',
    title: 'Accept a waiver',
    body: 'The liability waiver for the child has not been accepted yet. Read it and accept it here; the front desk then sees it as accepted.',
  },
  {
    path: '/schedule',
    title: 'Family schedule',
    body: 'Everyone in the household on one calendar, with moved or canceled sessions marked.',
  },
  {
    path: '/teams',
    title: 'Teams',
    body: 'Team fixtures, standings and availability. Captains also see roster tools here.',
  },
  {
    path: '/booking-roster-invitations',
    title: 'Rental roster invitation',
    body: 'A friend rented a field and invited you to the roster. Accept or decline; accepting asks for your own waiver.',
  },
  {
    path: '/public/schedule',
    title: 'Public schedule and standings',
    body: "Today's schedule by field, as anyone sees it without signing in. The signed-out Discover screen links to it and to the public league standings.",
  },
  {
    path: '/pass',
    title: 'Facility pass',
    body: 'The code staff scan at the gate. It is saved on the phone, so it works without a connection.',
  },
  {
    path: '/payments',
    title: 'Payments',
    body: 'What is owed and what was paid. A payment the bank has not confirmed stays marked as being checked, never as failed or paid.',
  },
  {
    path: '/family',
    title: 'Family and permissions',
    body: 'Who is in the household and who may register, pay or pick up each child.',
  },
  {
    path: '/account',
    title: 'Account',
    body: 'Enrollments, credits, forms, support and preferences live here.',
  },
];
