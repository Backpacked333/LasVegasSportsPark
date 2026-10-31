-- 0206_catalog_program_source.sql
-- Catalog module, CAT-03 (§5.3, §5.4, SPK-AT-024; IF-40 import provenance): a program is created
-- by staff or by the migration import of one batch. Only the in-process import command sets
-- 'import' (with the id the migration module reserved); no HTTP request can set it.

alter table programs add column source text not null default 'staff';
alter table programs add constraint programs_source_check check (source in ('staff', 'import'));
