-- 0018_core_organization_default_currency.sql
-- Organization default currency (SPK-PAY-001 "integer minor units with an explicit currency";
-- §2.1 configuration; park UI redesign gap "organization default currency"). Screens that show a
-- money figure before any record names a currency (an empty finance overview, a new POS
-- register, a report with no rows) read it instead of assuming one. It is configuration, not a
-- decided value: the column is null until a system administrator sets it, and nothing here infers
-- one. Every money record keeps its own currency; this default never converts or relabels one.
alter table organizations
  add column default_currency text
    constraint organizations_default_currency_iso check (default_currency ~ '^[A-Z]{3}$');
