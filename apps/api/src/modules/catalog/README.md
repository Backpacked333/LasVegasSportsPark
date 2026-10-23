# catalog module

**Owns:** Programs, offerings, sessions, entitlement definitions, policy versions, acknowledgments, publication state, versioned price rules

**Specification:** §3.2 (SPK-CAT-001..004), §3.15 price rules (SPK-PAY-001..003), §4.4 Catalog/Policies

**Migration range:** `packages/db/migrations/0200_catalog_*.sql` … `0299`

**Notes:** Exposes OfferingLookupPort for enrollment and finance.

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
