# finance module

**Owns:** Quotes, orders, order lines, obligations, payment attempts, refund attempts, credits, journal and journal entries (append-only), payment allocations, settlement reconciliation, installments, checkout coordinator

**Specification:** §3.15 (SPK-PAY-001..012), §4.4 Finance/Accounting support, §4.6 payment/refund/checkout machines, §4.7 invariants 5, 6, 7, §4.11

**Migration range:** `packages/db/migrations/0600_finance_*.sql` … `0699`

**Notes:** Provider adapters behind PaymentProviderPort with a deterministic fake; no transaction is held across a provider call.

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
