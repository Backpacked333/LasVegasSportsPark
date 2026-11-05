-- R4-LIFECYCLES-REVISIONS-01 (§5.4 "ambiguous relationships and balances enter review queues";
-- §4.6 ImportExceptionMachine open → decided | withdrawn, both final; §4.7 invariant 12 no lost
-- required follow-up): a problem that re-validation withdrew and that comes back — the legacy
-- authority assignment that cleared it ended, or the owning module refuses the row at apply —
-- gets a fresh open exception in its owner's review queue.
--
-- 1200 allowed one exception per (organization, row, kind) for good. A withdrawn exception is
-- final (import_exceptions_guard), so a recurring problem stayed tied to the withdrawn row:
-- nothing counted it as open, no review owner saw it, no Today card was raised, and neither the
-- review gate nor the apply's card held the batch back.
--
-- The rule is now one live exception per (organization, row, kind): at most one that is open or
-- decided. A decided exception stays the single authority for its kind (the planner reads the
-- decisions); any number of withdrawn ones stay as history, never deleted or reopened.
-- Applied migrations are immutable: this file changes 1200's table.
alter table import_exceptions drop constraint import_exceptions_row_kind_unique;

create unique index import_exceptions_row_kind_live_unique
  on import_exceptions (organization_id, row_id, kind)
  where status <> 'withdrawn';
