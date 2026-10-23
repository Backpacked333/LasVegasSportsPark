# migration module

**Owns:** External mappings, import batches, import rows and exceptions, authority assignments, reconciliation reports

**Specification:** §5.3..§5.8, §4.4 Migration, §4.7 invariant 11

**Migration range:** `packages/db/migrations/1200_migration_*.sql` … `1299`

**Notes:** Reimport never charges or notifies (§5.4).

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
