-- 0470_competition_public_visibility.sql
-- Public competition views (SPK-SCHED-010, proposed amendment PA-06; capability `public_schedule`,
-- DEC-100). A competition is private until a permitted staff member makes it public; only then
-- are its fixtures, results, standings and bracket readable without sign-in. A public answer is
-- addressed by random public codes (one per competition, one per season), never by record ids.
-- The code of a competition is issued when it is first made public and kept afterwards, so a
-- link that was shared works again if the competition is made public again.
alter table competitions
  add column public_visibility text not null default 'private'
    constraint competitions_public_visibility_check check (public_visibility in ('private', 'public')),
  add column public_code text
    constraint competitions_public_code_shape check (public_code ~ '^[a-z0-9]{16,40}$'),
  add column public_changed_at timestamptz,
  add column public_changed_by jsonb,
  add constraint competitions_public_needs_code
    check (public_visibility = 'private' or public_code is not null),
  add constraint competitions_public_change_fact
    check ((public_changed_at is null) = (public_changed_by is null)),
  add constraint competitions_public_needs_change_fact
    check (public_visibility = 'private' or public_changed_at is not null);
create unique index competitions_public_code_idx on competitions (public_code)
  where public_code is not null;

alter table seasons
  add column public_code text
    constraint seasons_public_code_shape check (public_code ~ '^[a-z0-9]{16,40}$');
create unique index seasons_public_code_idx on seasons (public_code)
  where public_code is not null;
