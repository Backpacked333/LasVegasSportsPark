-- SPK-IAM-004 (accepting an invitation grants only the authorized scope), §4.5 and SPK-IAM-001
-- (a household never determines authority): the people an invitation covers are fixed when it is
-- issued. Acceptance grants only to these subjects, minus any that have since left the scope, and
-- never to a child added to a household after the invitation was issued. The snapshot records
-- what the inviter was authorized for, so it is append-only.
create table invitation_subjects (
  organization_id uuid not null references organizations(id),
  invitation_id uuid not null,
  person_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, invitation_id, person_id),
  foreign key (organization_id, invitation_id) references invitations (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id)
);
create index invitation_subjects_person_idx on invitation_subjects (organization_id, person_id);
create trigger invitation_subjects_append_only before update or delete on invitation_subjects
  for each row execute function forbid_mutation();

-- Invitations still pending when this migration runs get the snapshot their scope gives today: a
-- person scope is exact, a household scope takes its current active child members.
insert into invitation_subjects (organization_id, invitation_id, person_id)
select i.organization_id, i.id, i.scope_person_id
  from invitations i
 where i.status = 'pending' and i.scope_type = 'person'
union
select i.organization_id, i.id, p.id
  from invitations i
  join household_memberships hm
    on hm.organization_id = i.organization_id and hm.household_id = i.scope_household_id
  join persons p
    on p.organization_id = hm.organization_id and p.id = hm.person_id
 where i.status = 'pending' and i.scope_type = 'household'
   and p.kind = 'child' and p.status = 'active';
