-- 0614_finance_export_line_ledger_guards.sql
-- R2-SCHEMA-02 (SPK-PAY-010, SPK-PAY-011, §4.7 invariant 5 and 9), completing the stage-5
-- INTEGRITY-03 guard of 0609. At-most-once export (0608) rests on the partial unique index
-- accounting_export_lines_live_entry_idx (organization_id, journal_entry_id) WHERE live, and 0608
-- says a line is live "while the batch may still be (or was) accepted". A line inserted with
-- live = false into a prepared batch escaped that index while its batch could still be submitted
-- and accepted, so one journal entry could be exported in two accepted batches. A line's posted_at
-- and the batch period were also free, so a batch did not provably state the ledger as booked.
-- accounting_export_lines_insert_guard now also refuses, at insert:
--   * a line that is not live (accounting_export_lines_live_at_insert): a line only stops being
--     live through the 0608 update guard, once its batch is rejected or canceled;
--   * a posted_at other than the posting time of the entry's journal
--     (accounting_export_lines_posted_as_booked);
--   * an entry whose journal was posted outside the batch's [period_start, period_end)
--     (accounting_export_lines_within_period), the window the export service selects from.
-- Everything 0609 enforced is kept, in the same order.

create or replace function accounting_export_lines_insert_guard() returns trigger
language plpgsql as $$
declare
  batch record;
  entry record;
begin
  select status, line_count, period_start, period_end into batch from accounting_export_batches
   where organization_id = new.organization_id and id = new.batch_id for share;
  if batch.status is distinct from 'prepared' then
    raise exception 'accounting batch % is % and takes no export line', new.batch_id,
      coalesce(batch.status, 'missing')
      using errcode = 'check_violation', constraint = 'accounting_export_lines_prepared_batch';
  end if;
  if new.line_number > batch.line_count then
    raise exception 'accounting batch % states % lines; line % is beyond it', new.batch_id,
      batch.line_count, new.line_number
      using errcode = 'check_violation', constraint = 'accounting_export_lines_within_count';
  end if;
  if new.live is distinct from true then
    raise exception 'accounting export line % is live when it is added; it stops being live only when its batch is rejected or canceled',
      new.id
      using errcode = 'check_violation', constraint = 'accounting_export_lines_live_at_insert';
  end if;
  select e.account_code, e.debit_minor, e.credit_minor, e.currency, j.posted_at into entry
    from journal_entries e
    join journals j on j.organization_id = e.organization_id and j.id = e.journal_id
   where e.organization_id = new.organization_id and e.id = new.journal_entry_id;
  if entry.account_code is distinct from new.ledger_account
     or entry.debit_minor is distinct from new.debit_minor
     or entry.credit_minor is distinct from new.credit_minor
     or entry.currency is distinct from new.currency then
    raise exception 'accounting export line % does not copy journal entry %', new.id,
      new.journal_entry_id
      using errcode = 'check_violation', constraint = 'accounting_export_lines_copy_entry';
  end if;
  if entry.posted_at is distinct from new.posted_at then
    raise exception 'accounting export line % states posted_at % but journal entry % was posted at %',
      new.id, new.posted_at, new.journal_entry_id, entry.posted_at
      using errcode = 'check_violation', constraint = 'accounting_export_lines_posted_as_booked';
  end if;
  if not (entry.posted_at >= batch.period_start and entry.posted_at < batch.period_end) then
    raise exception 'journal entry % was posted at %, outside accounting batch % period [%, %)',
      new.journal_entry_id, entry.posted_at, new.batch_id, batch.period_start, batch.period_end
      using errcode = 'check_violation', constraint = 'accounting_export_lines_within_period';
  end if;
  return new;
end
$$;
