-- 1306_reporting_team_entry_withdrawals.sql
-- Reporting module (R3-REPORTING-08; SPK-REPORT-005 MET-079 / MET-080, metric dictionary G3,
-- SPK-REPORT-007 "a report rerun with the same as-of instant returns the same numbers"): an
-- approved team entry may later be withdrawn (TeamEntryMachine approved → withdrawn), and the
-- competition module stamps the withdrawal (`team_entries.withdrawn_at`, check
-- `team_entries_withdrawal_fact`) while keeping the approval instant. The retention cohorts
-- qualified entries by their current status, so a withdrawal recorded after a stored run's as-of
-- instant changed a rerun at that instant. The view gains `withdrawn_at`, so the cohorts qualify
-- an entry approved by the as-of instant and not withdrawn by then.
--
-- Migration 1300 is applied and immutable; `create or replace view` keeps the view's columns and
-- its read-only trigger and only appends a column. Every base row still passes through (no
-- `where` clause), so `status` keeps its typed states.

create or replace view reporting_team_entries_v as
  select te.id as team_entry_id, te.organization_id, te.season_id, te.division_id, te.team_id,
         d.facility_id, te.status, te.approved_at, s.status as season_status,
         s.starts_on::text as season_starts_on, s.ends_on::text as season_ends_on,
         (rs.content ->> 'rosterMin')::integer as roster_min,
         te.withdrawn_at
  from team_entries te
  left join divisions d on d.organization_id = te.organization_id and d.id = te.division_id
  join seasons s on s.organization_id = te.organization_id and s.id = te.season_id
  join rule_sets rs on rs.organization_id = s.organization_id and rs.id = s.rule_set_id;
