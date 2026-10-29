-- 1008_communications_person_merges.sql
-- Communications module (COM-05): person merge follow-up (SPK-IAM-007, SPK-COMMS-003,
-- SPK-COMMS-007, §4.2). The module rewrites no person id: the survivor's inbox and preference reads
-- include the merged person's rows (identity's personIdsResolvingTo). Disagreeing explicit
-- preferences of the two persons resolve to the most protective choice (opted out) until the
-- survivor chooses again. This table records each merge followed, once per merge id (a replayed
-- event finds it and does nothing): the survivor's stored preference revisions at that moment, so
-- a later choice of the survivor's own is recognised and wins, and the conflicts that raised the
-- `communications.merged_preference_conflict` exception. Append-only.

create table communication_merge_follow_ups (
  organization_id uuid not null references organizations(id),
  merge_id uuid not null,
  survivor_person_id uuid not null,
  merged_person_id uuid not null,
  survivor_preferences jsonb not null,
  conflicts jsonb not null,
  followed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, merge_id),
  foreign key (organization_id, survivor_person_id) references persons (organization_id, id),
  foreign key (organization_id, merged_person_id) references persons (organization_id, id),
  check (survivor_person_id <> merged_person_id)
);
create index communication_merge_follow_ups_survivor_idx
  on communication_merge_follow_ups (organization_id, survivor_person_id, followed_at desc);
create trigger communication_merge_follow_ups_append_only
  before update or delete on communication_merge_follow_ups
  for each row execute function forbid_mutation();
