-- 1103_support_timeline_backfill.sql
-- SUP-03 (SPK-SUPPORT-001 timeline, §4.12 "events are durable facts consumers may replay",
-- SPK-AT-023): the timeline reference index is filled by outbox handlers, so events committed
-- before support indexed them (before the module was deployed, or while its handler was dead
-- lettered) are missing. The periodic job `support.backfill_timeline` replays each organization's
-- committed events of the indexed types from the kernel's outbox history (OutboxHistory.page) and
-- indexes them; the source-event key of timeline_references makes re-indexing a no-op.
--
-- One cursor per organization: the last replayed event in (occurred_at, id) order, and the instant
-- the replay caught up with the history (completed_at). The job advances the cursor in the
-- transaction that indexes the event, so an interrupted run resumes exactly after the last
-- indexed event.
create table support_timeline_backfill_cursors (
  organization_id uuid primary key references organizations(id),
  last_occurred_at timestamptz,
  last_event_id uuid,
  completed_at timestamptz,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The keyset position is both columns or neither (not started).
  check ((last_occurred_at is null) = (last_event_id is null))
);
create index support_timeline_backfill_open_idx on support_timeline_backfill_cursors (organization_id)
  where completed_at is null;
create trigger support_timeline_backfill_cursors_touch before update on support_timeline_backfill_cursors
  for each row execute function touch_updated_at();
create trigger support_timeline_backfill_cursors_no_delete before delete on support_timeline_backfill_cursors
  for each row execute function forbid_mutation();

-- Every organization that exists when support's timeline index is deployed is replayed once.
-- Organizations created afterwards are indexed by the live handlers from their first event; a
-- replay is requested again through TimelineBackfillService.request.
insert into support_timeline_backfill_cursors (organization_id)
  select id from organizations
  on conflict (organization_id) do nothing;

-- The timeline pages each indexed source with its own keyset (record type, people in scope,
-- occurred_at desc, id desc).
create index timeline_references_source_idx
  on timeline_references (organization_id, record_type, person_id, occurred_at desc, id desc);
