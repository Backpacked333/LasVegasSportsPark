# Liability waivers on staff screens (SPK-REG-011, proposed amendment PA-01)

**Proposed**, behind the capability `liability_waivers` (DEC-095 pending). Every piece below is
absent, and asks nothing of the API, while the capability is off.

| Where                                   | What                                                                                              | Verified by                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Person record (SCR-S-20), `WaiversCard` | Each waiver as current, lapsed or missing with the facts, the history and the recorded overrides  | `screens/people/__tests__/WaiversCard.test.tsx`               |
| Arrival (SCR-S-28), `WaiverActions`     | Sign on the tablet (digital), record a signed paper with its date, override a block with a reason | `screens/arrival/__tests__/ArrivalWaivers.test.tsx`           |
| Offering setup (SCR-S-14)               | "Requires waiver": the waiver families an offering requires, saved as one command                 | `screens/programs/__tests__/RequiredWaivers.test.tsx`         |
| Rental booking (SCR-S-51)               | Each roster member's waiver (see `screens/package-g/README.md`)                                   | `screens/package-g/bookings/__tests__/BookingRoster.test.tsx` |

- `WaiverAcceptanceForm.tsx` records an acceptance at the desk in one of two ways that are never
  mixed up: "tablet" is a digital acceptance by the named signer; "paper" is a staff entry in the
  staff member's own name with the date on the paper (SPK-REG-009). Staff never sign.
- `waivers.ts` holds the wording: a paper acceptance always reads "Recorded from paper by staff;
  paper dated ...", never as a signature.
- The rule shown on a waiver (warns or blocks, re-acceptance, renewal) is what the approved waiver
  version says; screens label it "Proposed rule, DEC-095 pending" and invent no value.

**Pending:** drafting and approving a waiver version has no dedicated screen; it is a policy
version of kind `waiver` and uses the existing policy version commands. No route or navigation
entry was added by this feature.
