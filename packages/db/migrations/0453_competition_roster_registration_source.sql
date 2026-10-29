-- 0453_competition_roster_registration_source.sql
-- SPK-AT-002, SPK-REG-007, §4.11 step 8: a paid and approved join_team registration places the
-- player on the team's roster when the enrollment is confirmed (enrollment calls competition's
-- RosterPort.addRegisteredMember in the confirming transaction). The membership records that
-- source. Migration 0400 is applied and immutable, so its inline source check is replaced here.
alter table roster_memberships drop constraint roster_memberships_source_check;
alter table roster_memberships
  add constraint roster_memberships_source_check
  check (source in ('invitation', 'join_request', 'captain', 'staff', 'renewal', 'registration'));
