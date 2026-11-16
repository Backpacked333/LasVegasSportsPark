# Architect: index

## Discovered architecture [DISCOVERED]

- Modular monolith: NestJS API (`apps/api`), one directory per domain module, each the only writer
  of its tables; shared kernel for authorization, idempotency, audit, outbox and inbox.
- PostgreSQL through Kysely; SQL migrations numbered by module range, immutable once applied;
  integrity enforced by constraints and triggers.
- Contracts as zod schemas feeding an OpenAPI document and a generated typed client used by the
  staff dashboard (React, Vite) and the customer app (Expo).
- Providers (identity, payments, messaging, hardware) are ports with fake adapters; none selected.
- Conditional capabilities per organization (DEC-016).

## Features

- `customer-redesign`: `customer-redesign.md` (ADR-008, PA-11; customer app visual system v2).
- `glass-demo-amendments`: see `glass-demo-amendments.md`, ADR-001 to ADR-007.
