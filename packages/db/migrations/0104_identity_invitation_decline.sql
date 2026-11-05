-- 0104_identity_invitation_decline.sql
-- ID-03 (SPK-IAM-004, §4.6, §4.10): a recipient can decline a pending invitation. `declined` is a
-- terminal state of the invitation lifecycle (InvitationMachine pending --decline--> declined;
-- state set Proposed, DEC-093). Who declined and when are recorded together, with an optional
-- reason. Migration 0100 is applied and immutable, so its inline status check is replaced here.
alter table invitations drop constraint invitations_status_check;
alter table invitations
  add constraint invitations_status_check
  check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired'));

alter table invitations add column declined_at timestamptz;
alter table invitations add column declined_by_person_id uuid;
alter table invitations add column decline_reason text;

alter table invitations
  add constraint invitations_declined_by_fk
    foreign key (organization_id, declined_by_person_id) references persons (organization_id, id),
  add constraint invitations_decline_reason_check
    check (decline_reason is null or (status = 'declined' and length(decline_reason) between 1 and 2000)),
  add constraint invitations_declined_check
    check ((status = 'declined') = (declined_at is not null and declined_by_person_id is not null));

-- GET /v1/me/invitations?direction=sent (keyset created_at desc) and the received list's match on
-- a recipient's verified contact points.
create index invitations_inviter_idx
  on invitations (organization_id, invited_by_person_id, created_at desc);
create index invitations_recipient_contact_idx
  on invitations (organization_id, recipient_contact_kind, recipient_contact_value)
  where status = 'pending';
