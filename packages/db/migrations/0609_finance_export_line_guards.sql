-- 0609_finance_export_line_guards.sql
-- INTEGRITY-03 (SPK-PAY-010, SPK-PAY-011, §4.7 invariant 9): an exported batch never changes and
-- states the ledger as booked. 0608 made a batch's checksum and line count immutable and its lines
-- unchangeable, but the set of lines under a batch could still grow, in any status, and a line's
-- account, amounts and currency were free columns. Enforced here:
--   * a line is added only to a `prepared` batch, with a line number within the batch's line count
--     (line numbers are unique per batch, so a batch never holds more lines than it states);
--   * a line copies its journal entry: ledger account, debit, credit and currency are the entry's;
--   * at commit, a new batch holds exactly `line_count` lines (deferred constraint trigger), so a
--     batch is complete in the transaction that prepares it and can never take a line later.

create or replace function accounting_export_lines_insert_guard() returns trigger
language plpgsql as $$
declare
  batch_status text;
  batch_lines integer;
  entry record;
begin
  select status, line_count into batch_status, batch_lines from accounting_export_batches
   where organization_id = new.organization_id and id = new.batch_id for share;
  if batch_status is distinct from 'prepared' then
    raise exception 'accounting batch % is % and takes no export line', new.batch_id,
      coalesce(batch_status, 'missing')
      using errcode = 'check_violation', constraint = 'accounting_export_lines_prepared_batch';
  end if;
  if new.line_number > batch_lines then
    raise exception 'accounting batch % states % lines; line % is beyond it', new.batch_id,
      batch_lines, new.line_number
      using errcode = 'check_violation', constraint = 'accounting_export_lines_within_count';
  end if;
  select account_code, debit_minor, credit_minor, currency into entry from journal_entries
   where organization_id = new.organization_id and id = new.journal_entry_id;
  if entry.account_code is distinct from new.ledger_account
     or entry.debit_minor is distinct from new.debit_minor
     or entry.credit_minor is distinct from new.credit_minor
     or entry.currency is distinct from new.currency then
    raise exception 'accounting export line % does not copy journal entry %', new.id,
      new.journal_entry_id
      using errcode = 'check_violation', constraint = 'accounting_export_lines_copy_entry';
  end if;
  return new;
end
$$;
create trigger accounting_export_lines_insert_guard before insert on accounting_export_lines
  for each row execute function accounting_export_lines_insert_guard();

create or replace function accounting_export_batches_complete() returns trigger
language plpgsql as $$
declare
  lines integer;
  stated integer;
begin
  select line_count into stated from accounting_export_batches
   where organization_id = new.organization_id and id = new.id;
  select count(*) into lines from accounting_export_lines
   where organization_id = new.organization_id and batch_id = new.id;
  if lines <> stated then
    raise exception 'accounting batch % states % lines but holds %', new.id, stated, lines
      using errcode = 'check_violation', constraint = 'accounting_export_batches_complete';
  end if;
  return null;
end
$$;
create constraint trigger accounting_export_batches_complete after insert on accounting_export_batches
  deferrable initially deferred for each row execute function accounting_export_batches_complete();
