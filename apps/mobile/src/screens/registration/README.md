# Discover, registration and checkout (SCR-C-07 to SCR-C-16)

Customer screens for journey A (discover, register, pay) and the household basket of journey C
(spec §2.2, §3.3, §3.15, §4.8 to §4.11, §4.13 to §4.15; SPK-AT-001, SPK-AT-004, SPK-AT-005,
SPK-AT-006). Screen ids are from `docs/package-a/screen-and-journey-inventory.md` section 4;
status phrases are from `docs/package-a/journeys.md` section 3.

Status legend (§6.7): **Verified** = implemented and asserted by a jest test here, against a fake
API that follows the published OpenAPI contract. **Proposed** = engineering proposal awaiting
operator approval. **Pending decision** = waits on an operator answer
(`docs/package-a/decision-register.md`). No screen here has passed native acceptance on signed
builds or physical devices (§6.2).

## Screens and routes

Route parameters are opaque record ids only (§4.14). Route files under `app/registration/` only
re-export the `*Route` component of the screen.

| Screen                                         | Route                                                         | API                                                                                                                                                               | Status                                                                                            | Tests                                           |
| ---------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| SCR-C-07 Discover                              | `/discover` (tab)                                             | `GET /offerings` (public, child-safe), paged                                                                                                                      | **Verified**                                                                                      | `../discover/__tests__/DiscoverScreen.test.tsx` |
| SCR-C-08 Offering detail                       | `/registration/offering/[offeringId]`                         | `GET /offerings/{id}`, `/offerings/{id}/sessions`, `GET /policy-versions/{id}` (signed in)                                                                        | **Verified**                                                                                      | `__tests__/OfferingDetailScreen.test.tsx`       |
| SCR-C-09 Registration intent chooser           | `/registration/start/[offeringId]`                            | `GET /me`, `GET /people/{id}`, `POST /baskets`, `POST /baskets/{id}/lines`                                                                                        | **Verified** for basket intents; session bookings and joining a team are explained, not built     | `__tests__/RegistrationIntentScreen.test.tsx`   |
| SCR-C-10 Participant and placement information | `/registration/placement/[lineId]?basketId=`                  | `POST /placement-requests`                                                                                                                                        | **Pending decision** DEC-051/DEC-031 for the field list; form **Verified** with configured fields | `__tests__/PlacementInformationScreen.test.tsx` |
| SCR-C-11 Household basket                      | `/registration/basket/[basketId]`                             | `GET /baskets/{id}`, `GET /acknowledgments`, remove line, release, `POST /registration-quotes`, `POST /waitlist-entries`                                          | **Verified**                                                                                      | `__tests__/BasketScreen.test.tsx`               |
| SCR-C-12 Quote review                          | `/registration/quote/[quoteId]`                               | `GET /registration-quotes/{id}`, `GET /credits`, `POST /registration-quotes`                                                                                      | **Verified**                                                                                      | `__tests__/QuoteReviewScreen.test.tsx`          |
| SCR-C-13 Required forms and acknowledgments    | `/registration/forms?basketId=` or `?waitlistEntryId=`        | `GET /acknowledgments`, `GET /policy-versions/{id}`, `POST /acknowledgments`                                                                                      | **Verified**                                                                                      | `__tests__/RequiredFormsScreen.test.tsx`        |
| SCR-C-14 Checkout and payment                  | `/registration/checkout/[quoteId]`                            | `POST /baskets/{id}/hold`, `POST /registration-checkouts`                                                                                                         | **Verified** with the development fake provider; in-app payment **Pending decision** DEC-019      | `__tests__/CheckoutScreen*.test.tsx`            |
| SCR-C-15 Checkout outcome                      | `/registration/outcome/[checkoutId]`                          | `GET /registration-checkouts/{id}`, `GET /operations/{id}`, `GET /enrollments/{id}`, `GET /placement-requests/{id}`, `POST /registration-checkouts/{id}/payments` | **Verified**                                                                                      | `__tests__/CheckoutOutcomeScreen.test.tsx`      |
| SCR-C-16 Waitlist status and offer             | `/registration/waitlist/[entryId]`, `/registration/waitlists` | `GET /waitlist-entries/{id}`, accept, decline, withdraw                                                                                                           | **Verified**                                                                                      | `__tests__/WaitlistScreen.test.tsx`             |

`__tests__/registration-routes.test.tsx` renders the real Expo Router tree and checks that every
route above resolves to its screen.

## Behaviour asserted by the tests (Verified)

- **One idempotency key per intent** (§4.9): every command goes through `useApiCommand`; a retry
  of the same input reuses the key (basket lines, checkout), a new input gets a new key. Bodies
  carry `expectedRevision` wherever the API takes it (basket lines, remove, hold, release, waitlist
  accept, decline and withdraw).
- **No client prices** (SPK-PAY-001): quote and checkout bodies carry ids, codes and a provider
  token only; every amount shown is the API's integer minor units (`formatMinorUnits`).
- **Payment uncertainty** (SPK-PAY-007, SPK-UX-001): a checkout request that gets no answer reads
  "Payment outcome being confirmed. Do not pay again.", hides the Pay button, and is re-sent with
  the same key when the app returns to the foreground, when the connection returns, or on "Check
  now". The outcome screen re-reads an in-flight checkout every 5 seconds (display refresh, not a
  policy) and on foreground; "Confirmed" appears only for enrollments the API reports confirmed.
- **Final place and late payment** (SPK-AT-005, SPK-AT-006): CAPACITY_UNAVAILABLE on hold charges
  nothing and offers the waitlist per line; holds and offers show only the server's expiry, with an
  informational countdown that re-reads the record when it lapses.
- **Two guardians, one entitlement** (SPK-AT-004): DUPLICATE_ENTITLEMENT is shown with the API's
  message only; nothing names the other registrant or payer.
- **Signer rules** (SPK-REG-009): the app never sends `signedByPersonId`; the API records the
  signed-in customer. Children the account may not complete forms for read "Needs a guardian who
  can complete forms".
- **Not available** (§4.10): NOT_FOUND, ACCESS_DENIED and PARTICIPANT_AUTHORITY_REQUIRED read as
  not available, never as "exists but denied".
- **Offline** (§4.15): cached data stays with its age; commands are disabled and input is kept.
- **Release builds**: the development payment method (`src/features/registration/dev`) is required
  only under `__DEV__`; `scripts/check-release-bundle.mjs` fails a release bundle that contains it.

## Proposed (engineering choices awaiting approval)

- Baskets are opened with the proposed default all-or-nothing fulfillment; partial fulfillment is
  never offered (DEC-026, Product and operations).
- The device remembers the ids of the basket, quote and checkout in progress and of waitlist
  entries joined here, in the platform secure store, scoped to the account
  (`src/features/registration/progress.tsx`), because the API has no customer list of them.
- Intents per offering kind mirror the API's `INTENT_OFFERING_KINDS` so the chooser offers only
  intents the API accepts; the API still evaluates every line.

## Pending decisions shown as pending

| Decision                                                      | Owner                                          | Where                                                         |
| ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| DEC-019 payment processor (in-app payment)                    | Technical lead/account owners                  | SCR-C-14 pay step, SCR-C-15 retry and provider action         |
| DEC-051, DEC-031 placement fields and model                   | Product and operations; Operator/privacy owner | SCR-C-10 (fields come from `SPORTSPARK_PLACEMENT_FIELDS`)     |
| DEC-076, DEC-082 rentals and pickup sessions                  | Product owner                                  | SCR-C-07 (no filter; listed only when the API publishes them) |
| DEC-006, DEC-026 to DEC-030 holds, waitlist, approval, basket | Product and operations                         | Only server values are shown (expiry, approval flags)         |
| DEC-007, DEC-057 prices, taxes, discounts                     | Finance                                        | SCR-C-12 shows the API's prices and its stated defaults       |

## Configuration

| Variable                       | Meaning                                                                                                    | Default                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `SPORTSPARK_ORGANIZATION_SLUG` | Organization whose public catalog a signed-out visitor browses (deployment)                                | unset: signed-out Discover asks to sign in |
| `SPORTSPARK_PLACEMENT_FIELDS`  | Comma-separated approved placement fields: `availability`, `declaredLevel`, `positionPreferences`, `notes` | unset: pending DEC-051                     |

## Not built here

- Trial, makeup and pickup session bookings (their own commands), and joining a known team (needs
  the team's invitation, SCR-C-17).
- Completing a provider's customer action (`action_required`) and in-app card entry: DEC-019.
