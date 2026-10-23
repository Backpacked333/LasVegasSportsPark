# competition module

**Owns:** Leagues, seasons, divisions, teams, team entries, roster memberships, fixtures, result revisions, standings projections, brackets, discipline (incidents, decisions, suspensions, appeals), disputes, match readiness, captain workspace

**Specification:** §3.4, §3.5, §3.6 placement inputs, §3.9, §3.11, §3.12, §4.4 Competition/Matches/Discipline

**Migration range:** `packages/db/migrations/0400_competition_*.sql` … `0499`

**Notes:** Registers TEAM_AUTHORITY_IMPL with the kernel. Readiness is derived, never stored as an editable flag (SPK-READY-004).

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
