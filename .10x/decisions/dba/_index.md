# DBA: index

## Features

- `glass-demo-amendments`: written when its phase completes.

## Discovered [DISCOVERED]

- Highest migration per range on `main` at 51253046: core 0019, identity 0181, catalog 0210,
  scheduling 0304, competition 0466, enrollment 0520, finance 0686, workforce 0780, entry 0880,
  facilities 0909, communications 1012, support 1180, migration 1281, reporting 1309,
  automation 1480. Files run in name order; a new file must sort after what it depends on.
- Append-only tables use the `forbid_mutation` trigger; references between tenant tables are
  composite with `organization_id`.
