-- 0017_core_exception_open_rank.sql
-- R4-CARRY-02 (R3-PERFORMANCE-01 part 3, §4.12, §5.10, SPK-UX-006): the Today workspace reads the
-- open exceptions of an organization a bounded keyset page at a time, most severe first, then
-- soonest due, then id (OperationalExceptions.listOpenPage), and counts the rest in one aggregate
-- (OperationalExceptions.summarizeOpen), instead of loading every open exception on each read.
--
-- Severity is text, and its text order ('critical' < 'high' < 'info' < 'warning') is not the
-- severity order, so the rank is stored beside it (derived by the database, never written) and the
-- open-exception index is keyed by it. The index carries the columns the open summary reads
-- (facility, queue, opening time, status), so that count is served from the index.
alter table operational_exceptions
  add column severity_rank smallint not null generated always as (
    case severity
      when 'critical' then 0
      when 'high' then 1
      when 'warning' then 2
      when 'info' then 3
    end
  ) stored;

create index operational_exceptions_open_rank_idx
  on operational_exceptions (organization_id, severity_rank, deadline_at, id)
  include (facility_id, owner_queue, opened_at, status)
  where status in ('open', 'acknowledged');

-- Replaced by the index above: it ordered open exceptions by severity as text, which no read uses.
drop index operational_exceptions_open_idx;
