-- 0304_scheduling_event_sport.sql
-- Scheduling module (SPK-SCHED-001 "compatible activity formats", SPK-UX-010 soccer, indoor
-- soccer and basketball each read at a glance on the schedule).
--
-- An event and a series may name the sport they are played as. The value is a slug from the
-- scheduling policy's sport vocabulary (an engineering placeholder until the operator decides which
-- sports are offered, §6.6 "Actual facilities, spaces, subdivisions, hours"); the database checks
-- its shape, the service checks the vocabulary and the resources' compatible sports. A resource may
-- list the sports it supports; an empty list supports every sport, as with compatible formats.
--
-- Existing rows keep `sport = null` (not stated), never a guessed value.

alter table events
  add column sport text null
    constraint events_sport_slug check (sport ~ '^[a-z][a-z0-9_]{0,39}$');

alter table event_series
  add column sport text null
    constraint event_series_sport_slug check (sport ~ '^[a-z][a-z0-9_]{0,39}$');

alter table resources
  add column compatible_sports text[] not null default '{}'
    constraint resources_compatible_sports_slug check (
      array_position(compatible_sports, null) is null
      and array_to_string(compatible_sports, ',')
        ~ '^([a-z][a-z0-9_]{0,39}(,[a-z][a-z0-9_]{0,39})*)?$'
    );
