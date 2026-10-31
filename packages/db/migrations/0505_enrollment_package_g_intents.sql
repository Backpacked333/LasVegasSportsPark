-- 0505_enrollment_package_g_intents.sql
-- Enrollment module, ENR-10: the Package G foundation (§3.16 rentals, parties, memberships,
-- session packages; §6.5 Package G). Whether the complex uses any of them is pending (DEC-016 and
-- DEC-072, DEC-074, DEC-076, DEC-077, DEC-082); every command that creates a new commitment checks
-- the organization's capability switch (migration 0011, default off). This migration only adds
-- the vocabulary: a membership, a session package purchase and a party request are registration
-- intents of applications, enrollments, basket lines and waitlist entries (RegistrationIntent in
-- packages/contracts). A rental or party request becomes a basket line only through its booking
-- (ENR-13, SPK-COND-003); the database cannot see that rule, the basket service enforces it.

alter table applications drop constraint applications_intent_check;
alter table applications add constraint applications_intent_check check (intent in (
  'individual_league', 'join_team', 'create_team_entry', 'youth', 'trial', 'makeup', 'pickup',
  'rental_request', 'membership', 'package_purchase', 'party_request'
));

alter table enrollments drop constraint enrollments_intent_check;
alter table enrollments add constraint enrollments_intent_check check (intent in (
  'individual_league', 'join_team', 'create_team_entry', 'youth', 'trial', 'makeup', 'pickup',
  'rental_request', 'membership', 'package_purchase', 'party_request'
));

alter table basket_lines drop constraint basket_lines_intent_check;
alter table basket_lines add constraint basket_lines_intent_check check (intent in (
  'individual_league', 'join_team', 'create_team_entry', 'youth', 'trial', 'makeup', 'pickup',
  'rental_request', 'membership', 'package_purchase', 'party_request'
));

alter table waitlist_entries drop constraint waitlist_entries_intent_check;
alter table waitlist_entries add constraint waitlist_entries_intent_check check (intent in (
  'individual_league', 'join_team', 'create_team_entry', 'youth', 'trial', 'makeup', 'pickup',
  'rental_request', 'membership', 'package_purchase', 'party_request'
));

-- A membership or session package is one entitlement per line (ENR-10): quantity 1.
alter table basket_lines add constraint basket_lines_package_g_single
  check (intent not in ('membership', 'package_purchase') or quantity = 1);
