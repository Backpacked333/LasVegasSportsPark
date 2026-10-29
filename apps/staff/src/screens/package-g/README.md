# Package G staff screens (SCR-S-51 to SCR-S-57)

Conditional capabilities (§1.6, §3.16, §6.5). Whether the complex uses each one is **Pending
decision** DEC-016 and its own record (DEC-076, DEC-077, DEC-072, DEC-074, DEC-079, DEC-080,
DEC-081; Product owner); every per-organization switch starts off, and only a system administrator
changes one (K-12). Status legend as in `apps/staff/README.md`.

| Screen                             | Directory             | Route (owns `/*` below it)    | Area           | Capability         | State                                         |
| ---------------------------------- | --------------------- | ----------------------------- | -------------- | ------------------ | --------------------------------------------- |
| SCR-S-51 Rentals                   | `rentals/`            | `/schedule/rentals`           | Schedule       | `rentals`          | Placeholder, **Verified** in jsdom; not built |
| SCR-S-52 Parties                   | `parties/`            | `/schedule/parties`           | Schedule       | `parties`          | Placeholder, **Verified** in jsdom; not built |
| SCR-S-53 Memberships               | `memberships/`        | `/finance/memberships`        | Finance        | `memberships`      | Placeholder, **Verified** in jsdom; not built |
| SCR-S-54 Session packages          | `session-packages/`   | `/finance/session-packages`   | Finance        | `session_packages` | Placeholder, **Verified** in jsdom; not built |
| SCR-S-55 Point of sale             | `point-of-sale/`      | `/finance/point-of-sale`      | Finance        | `point_of_sale`    | Placeholder, **Verified** in jsdom; not built |
| SCR-S-56 Access hardware           | `access-hardware/`    | `/admin/access-hardware`      | Administration | `access_hardware`  | Placeholder, **Verified** in jsdom; not built |
| SCR-S-57 Accounting export batches | `accounting-exports/` | `/finance/accounting-exports` | Finance        | `accounting`       | Placeholder, **Verified** in jsdom; not built |

## For the builder of one screen

- Replace only your directory: `<Name>Screen.tsx`, `meta.ts` (title, path, purpose, what stays
  pending) and `__tests__/`. Routes are registered once (`routes.tsx` for Finance and
  Administration, `../schedule/ScheduleArea.tsx` for Schedule) with `/*`, so nested pages go in your
  screen with its own `<Routes>`; the area navigation entries already point at your path.
- Keep the screen behind `<CapabilityGate capability="...">` (`src/ui/CapabilityGate.tsx`). Reads,
  cancellations, retirements, reversals and settlements are never gated by the API; use
  `whenOff="notice"` where the screen lists existing records the API keeps readable.
- A command refused while the switch is off answers ACCESS_DENIED with
  `details.code: 'CAPABILITY_DISABLED'`; `StateView variant="error"` (and every feature's
  `CommandError` that falls through to it) renders it as "turned off" and the switches are re-read.
- Paged staff lists (`GET /bookings`, `/package-entitlements`, `/pos-products`, `/access-devices`,
  `/accounting-export-batches`, ...) use `useApiPages` and `LoadMore`.
- Test with `mePermissions({ enabled: ['point_of_sale'] })` from `src/testing/test-app.tsx`; the
  default is every switch off.
