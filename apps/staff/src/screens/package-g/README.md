# Package G staff screens (SCR-S-51 to SCR-S-57)

Conditional capabilities (§1.6, §3.16, §6.5). Whether the complex uses each one is **Pending
decision** DEC-016 and its own record (DEC-076, DEC-077, DEC-072, DEC-074, DEC-079, DEC-080,
DEC-081; Product owner); every per-organization switch starts off, and only a system administrator
changes one (K-12). Status legend as in `apps/staff/README.md`.

| Screen                             | Directory             | Route (owns `/*` below it)    | Area           | Capability         | State                                     |
| ---------------------------------- | --------------------- | ----------------------------- | -------------- | ------------------ | ----------------------------------------- |
| SCR-S-51 Rentals                   | `rentals/`            | `/schedule/rentals`           | Schedule       | `rentals`          | Built, **Verified**; see `participation/` |
| SCR-S-52 Parties                   | `parties/`            | `/schedule/parties`           | Schedule       | `parties`          | Built, **Verified**; see `participation/` |
| SCR-S-53 Memberships               | `memberships/`        | `/finance/memberships`        | Finance        | `memberships`      | Built, **Verified**; see `participation/` |
| SCR-S-54 Session packages          | `session-packages/`   | `/finance/session-packages`   | Finance        | `session_packages` | Built, **Verified**; see `participation/` |
| SCR-S-55 Point of sale             | `point-of-sale/`      | `/finance/point-of-sale`      | Finance        | `point_of_sale`    | Built, **Verified** in jsdom (1)          |
| SCR-S-56 Access hardware           | `access-hardware/`    | `/admin/access-hardware`      | Administration | `access_hardware`  | Built, **Verified** in jsdom (1)          |
| SCR-S-57 Accounting export batches | `accounting-exports/` | `/finance/accounting-exports` | Finance        | `accounting`       | Built, **Verified** in jsdom (1)          |

(1) Built screens, their pages, API operations, states and what stays pending (DEC-019, DEC-057,
POL-018; DEC-023, DEC-032, POL-043; DEC-022): `src/features/pos-access-accounting/README.md`.

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

## Rental group roster (SPK-COND-005, proposed amendment PA-09)

**Proposed**, behind the capability `rental_rosters` (DEC-103 pending). `bookings/BookingRoster.tsx`
is a panel of the rental booking detail (SCR-S-51): who is on the roster, who is invited, who was
removed, and each member's liability waiver (current, lapsed, missing, not evaluated), with adding
a person by reference, inviting a contact (the invitation code is shown once, because no messaging
channel is approved: DEC-012, DEC-062) and removing with a reason. It says that a missing waiver
does not block the booking and that being on the roster grants nothing else. Somebody who is only
invited is listed by the contact the invitation went to, or as "Invited person", with no name and
no waiver until they join (security review M-1). Absent, and asking
nothing of the API, while the capability is off and on a party. **Verified**
`bookings/__tests__/BookingRoster.test.tsx`. No route or navigation entry was added.

## Open-amount lines at the register (SPK-PAY-016, proposed amendment PA-08)

**Proposed**, behind the capability `open_amount_lines` (DEC-102 pending: the categories, the
ceilings, who may enter and who may approve). `point-of-sale/OpenAmount.tsx` adds to SCR-S-55:
"Other amount" on an open sale (what it is for, an amount, a reason category; the form names the
decision while the API applies its proposed default, and says before sending when the amount,
with the other amounts the viewer already entered on the sale, is above the viewer's ceiling: the
ceiling counts everything one person enters on one sale, security review M-4); the approval step (the sale offers no tender, the page says who
approves and that the sale cannot finish before, and a permitted second person approves with a
reason; the person who entered the line is told another person approves it); the line on the sale,
its ticket (removal only) and its receipt by its description and category; and the session's
open-amount lines listed apart from its sales. With the switch off none of this is offered and the
API is not asked for it; a line that already exists is still shown, removable and payable.
**Verified** in jsdom `point-of-sale/__tests__/OpenAmount.test.tsx`. No route or navigation entry
was added. Not looked at in a browser in this work.
