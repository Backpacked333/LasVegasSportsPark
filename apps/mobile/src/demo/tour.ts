/**
 * The family demo: who it signs in as and the guided tour through the customer app. The parent
 * account and its child come from the development seed (apps/api/src/dev/seed-dev.ts). Tour copy
 * describes each screen and what to try; it does not claim data exists, since a fresh demo
 * database holds only the seeded accounts. Staff roles are demonstrated in the staff dashboard.
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
    body: 'Changes that affect the family come first, then the next activity, then anything the family needs to do.',
  },
  {
    path: '/discover',
    title: 'Discover',
    body: 'Programs, camps and leagues the family can join, with places left and the price before any commitment.',
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
