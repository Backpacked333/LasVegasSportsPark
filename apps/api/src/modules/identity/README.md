# identity module

**Owns:** Accounts, people, contact points, households, relationships, access grants, invitations, disputed-access reviews, duplicate review

**Specification:** §3.1 (SPK-IAM-001..007), §4.4 Identity, §4.5, §4.14

**Migration range:** `packages/db/migrations/0100_identity_*.sql` … `0199`

**Notes:** Registers PRINCIPAL_RESOLVER_IMPL and RELATIONSHIP_AUTHORITY_IMPL with the kernel.

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
