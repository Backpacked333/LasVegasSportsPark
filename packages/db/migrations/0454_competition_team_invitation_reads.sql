-- 0454_competition_team_invitation_reads.sql
-- CMP-03 and CMP-07 (SPK-CAP-001, §4.6, §4.10, §4.12): team invitations are read and declined by
-- their recipient and expired by a background sweep. Migration 0400 is applied and immutable.
--
-- 1. A declined invitation always records when it was declined, and only a declined one does
--    (the TeamInvitationMachine 'decline' transition writes both in one statement).
-- 2. GET /v1/me/team-invitations finds the invitations addressed to a person, or to one of their
--    verified contact points, without scanning the organization.
-- 3. The expiry sweep (competition.expire_team_invitations) finds pending invitations past their
--    expiry in order.
alter table team_invitations
  add constraint team_invitations_declined_fact check ((status = 'declined') = (declined_at is not null));

create index team_invitations_recipient_idx on team_invitations (organization_id, recipient_person_id, status)
  where recipient_person_id is not null;
create index team_invitations_contact_idx on team_invitations (organization_id, recipient_contact_kind, recipient_contact_value, status)
  where recipient_contact_kind is not null;
create index team_invitations_pending_expiry_idx on team_invitations (organization_id, expires_at)
  where status = 'pending';
