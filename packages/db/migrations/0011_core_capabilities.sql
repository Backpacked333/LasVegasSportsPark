-- §1.6 conditional capabilities, §6.5 Package G (K-12, IF-30): a per-organization switch per
-- capability of the catalogue (packages/contracts/src/capabilities.ts). No row means disabled.
-- Whether the complex uses each capability is pending: DEC-016 decides applicability for all of
-- them and most have their own Register E record (DEC-072 to DEC-082). A change names one of
-- those applicability references (enforced here, not only in the service), is made by a system
-- administrator, audited, and kept in the append-only history below.
create table organization_capabilities (
  organization_id uuid not null references organizations (id),
  capability text not null check (capability in (
    'memberships',
    'session_packages',
    'rentals',
    'parties',
    'tournaments',
    'point_of_sale',
    'access_hardware',
    'accounting',
    'youth_progression',
    'pickup_sessions',
    'assistant',
    'installments',
    'supervised_pickup',
    'advanced_fairness',
    'retention_tools'
  )),
  enabled boolean not null,
  decision_reference text not null check (decision_reference ~ '^DEC-[0-9]{3}$'),
  reason text not null check (length(reason) between 1 and 2000),
  -- Principal snapshot of the administrator (kernel tables cannot reference identity's persons).
  changed_by jsonb not null,
  changed_at timestamptz not null,
  revision integer not null default 1 check (revision >= 1),
  primary key (organization_id, capability),
  constraint organization_capabilities_applicability check (
    decision_reference = 'DEC-016'
      or (capability = 'memberships' and decision_reference = 'DEC-072')
      or (capability = 'session_packages' and decision_reference = 'DEC-074')
      or (capability = 'rentals' and decision_reference = 'DEC-076')
      or (capability = 'parties' and decision_reference = 'DEC-077')
      or (capability = 'tournaments' and decision_reference = 'DEC-078')
      or (capability = 'point_of_sale' and decision_reference = 'DEC-079')
      or (capability = 'access_hardware' and decision_reference = 'DEC-080')
      or (capability = 'accounting' and decision_reference = 'DEC-081')
      or (capability = 'pickup_sessions' and decision_reference = 'DEC-082')
      or (capability = 'installments' and decision_reference = 'DEC-073')
      or (capability = 'supervised_pickup' and decision_reference = 'DEC-075')
  )
);

create table organization_capability_changes (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  capability text not null,
  enabled boolean not null,
  decision_reference text not null check (decision_reference ~ '^DEC-[0-9]{3}$'),
  reason text not null check (length(reason) between 1 and 2000),
  changed_by jsonb not null,
  changed_at timestamptz not null,
  -- The switch's revision this change produced.
  revision integer not null check (revision >= 1),
  correlation_id text,
  unique (organization_id, id),
  unique (organization_id, capability, revision),
  foreign key (organization_id, capability)
    references organization_capabilities (organization_id, capability)
);
create index organization_capability_changes_time_idx
  on organization_capability_changes (organization_id, capability, changed_at desc);
create trigger organization_capability_changes_append_only
  before update or delete on organization_capability_changes
  for each row execute function forbid_mutation();
