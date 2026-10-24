# @sportspark/staff

Staff dashboard and the coach and referee workspace: React, Vite and React Router (spec §2.3, §2.4,
§4.1, SPK-UX-005 to SPK-UX-007). This is the foundation shell that screen groups fill; areas other
than Today and the workspace are placeholders naming their inventory ids
(`docs/package-a/screen-and-journey-inventory.md` sections 5 and 6).

Status legend (§6.7): **Verified** = implemented and asserted by a test here. **Proposed** =
engineering proposal awaiting operator approval. **Pending decision** = needs an operator answer;
owners are in `docs/package-a/decision-register.md`. Staff acceptance on the actual workstation,
tablet and scanner configurations (§6.3) has not happened; jsdom tests are not staff acceptance.

## Run against a local API

```bash
pnpm install
AUTH_LOCAL_SECRET=$(openssl rand -hex 32) pnpm --filter @sportspark/api dev   # API on :3000
pnpm --filter @sportspark/staff dev                                            # http://localhost:5173
```

- The development server proxies `/v1` to `SPORTSPARK_API_ORIGIN` (default `http://localhost:3000`),
  so the browser talks to one origin and the API needs no CORS configuration. `VITE_API_BASE_URL`
  points the build at another API base URL.
- Development builds offer **Development sign-in** (`POST /v1/dev/tokens` with an existing local
  account id; the route exists only when the API runs with `AUTH_MODE=local` outside production).
  The API has no development seed, so the account and its staff membership must already exist.
- `VITE_STALE_DATA_THRESHOLD_MINUTES` sets when shown data is called stale; pending DEC-032/DEC-033,
  unset by default.
- `VITE_OFFLINE_ROSTER_MAX_AGE_MINUTES` sets the maximum roster age for queuing offline arrival and
  attendance observations; pending DEC-033, unset by default (see `src/features/operations/README.md`).

## Commands

| Command                                     | What it checks                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm --filter @sportspark/staff test`      | vitest, jsdom, Testing Library (also a project of the root `pnpm test`)                       |
| `pnpm --filter @sportspark/staff typecheck` | TypeScript strict (also run by the root `pnpm typecheck`)                                     |
| `pnpm --filter @sportspark/staff lint`      | Root ESLint config, including React hooks rules                                               |
| `pnpm --filter @sportspark/staff build`     | Typecheck, `vite build`, then `scripts/check-release-bundle.mjs` (no development sign-in; CI) |

## What is here and how it is verified

| Item                                                                                                                                                                                       | Status                                                                                                  | Evidence                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| The fourteen SPK-UX-005 areas in specification order, then "My assignments"; Today is the operating home (`/` redirects there); keyboard navigation, skip link, `aria-current`.            | **Verified** in jsdom                                                                                   | `src/__tests__/shell.test.tsx`                             |
| "Visibility depends on permissions": every area is listed because the API publishes no per-principal list of permitted areas or actions; areas render ACCESS_DENIED as "not available".    | **Proposed** handling of an API gap                                                                     | `src/navigation/areas.ts`                                  |
| Facility switcher limited to `GET /v1/me` `principal.facilityIds` (empty = whole organization, names from the Today feed); the choice filters Today.                                       | **Verified** in jsdom                                                                                   | `src/__tests__/shell.test.tsx`                             |
| SCR-S-01 Today shell: each issue's title, severity as text, affected record, owner queue, age, deadline, next actions; sources the viewer may not read listed as not available.            | **Verified** in jsdom                                                                                   | `src/screens/today/__tests__/TodayScreen.test.tsx`         |
| SCR-W-01 My assignments, phone-width layout (one column below 768 px); "Accept" only where the API lists it, with `expectedRevision` and an idempotency key; STALE_REVISION offers Reload. | **Verified** in jsdom (behaviour); the phone layout is CSS and needs real devices (SPK-UX-007, §6.3)    | `src/screens/workspace/__tests__/WorkspaceScreen.test.tsx` |
| State primitives (same variants and wording as the customer app) and `StatusBadge` (glyph and text).                                                                                       | **Verified** in jsdom                                                                                   | `src/ui/__tests__/primitives.test.tsx`                     |
| Keyboard alternative to drag (SPK-UX-009): `ReorderableList` with Move buttons, Alt+Arrow keys and announcements. No screen uses drag yet.                                                 | **Verified** in jsdom                                                                                   | same                                                       |
| Offline banner with the age of what is shown and the actions unavailable offline (SCR-W-10, §4.15).                                                                                        | **Verified** in jsdom; the offline queue is in `src/features/operations/README.md`                      | `src/__tests__/shell.test.tsx`                             |
| Session in `sessionStorage` behind `SessionStore`; AUTHENTICATION_REQUIRED ends it; "Update required" replaces the dashboard.                                                              | **Verified** in jsdom. How a production staff session is held depends on DEC-018 (**Pending decision**) | same                                                       |
| Development sign-in only in development builds.                                                                                                                                            | **Verified** (jsdom, and the build check)                                                               | `scripts/check-release-bundle.mjs`                         |
| Managed staff sign-in with multifactor authentication for privileged staff (§4.14).                                                                                                        | **Pending decision** DEC-018 (Technical lead/account owners); the sign-in page shows the pending state  |                                                            |
| Hosting and the production origin (CORS or a same-origin proxy).                                                                                                                           | **Pending decision** DEC-021                                                                            |                                                            |
| Schedule (SCR-S-03 to SCR-S-07) and Facilities (SCR-S-41, SCR-S-42) screens; SCR-S-51 and SCR-S-52 shown as pending decisions; details in `src/screens/schedule/README.md`.                | **Verified** in jsdom                                                                                   | `src/screens/*/__tests__`                                  |

## Today, People and families, support cases (SCR-S-01, SCR-S-02, SCR-S-20 to SCR-S-23, SCR-S-49, SCR-S-50)

Routes: `/today`, `/today/exceptions/:exceptionId`, `/people`, `/people/:personId`,
`/people/:personId/relationships`, `/people/access-reviews` (`/new`, `/:reviewId`),
`/people/duplicates`, `/admin/cases` (`/new`, `/:caseId`, linked from Administration). Tests live in
`src/screens/{today,people,support}/__tests__/`. Shared pieces: `src/ui/FormFields.tsx` (labelled
fields), `src/ui/CommandFeedback.tsx` (command outcome states), `src/ui/RecordRef.tsx`,
`src/ui/time.ts`, `src/api/useOperation.ts` (polls `GET /v1/operations/{id}`),
`src/api/server-defaults.ts`, `src/features/people/`.

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status                                                                                           | Evidence                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| SCR-S-01: issues with severity text, affected record, owner, age, deadline, next actions and resolution history; money-moved-but-not-fulfilled financial issues pinned first; Acknowledge only where `nextActions` lists it, with `expectedRevision` and one key per intent; only current and upcoming activities (`GET /v1/events` from now to the end of the facility day, facility-local time); field status (`GET /v1/facilities/{id}/operating-status`).                                | **Verified** in jsdom                                                                            | `src/screens/today/__tests__/TodayScreen.test.tsx`            |
| SCR-S-01 expected arrivals: shown as not available (no API read).                                                                                                                                                                                                                                                                                                                                                                                                                            | **Proposed** handling of an API gap                                                              | same                                                          |
| SCR-S-02: acknowledge, resolve, close as the API lists them; resolve and close need a note; STALE_REVISION offers Reload and keeps the note; a retry reuses the idempotency key; the affected payment attempt, checkout or maintenance task shows its own state, and a record in recovery says so; offline read-only; protected NOT_FOUND not available.                                                                                                                                     | **Verified** in jsdom                                                                            | `src/screens/today/__tests__/ExceptionDetailScreen.test.tsx`  |
| SCR-S-50: optional panel, closed by default; "turned off" when the API answers INTEGRATION_UNAVAILABLE with `details.reason: 'disabled'`; evidence with freshness and missing evidence; recommendations show the command they would run; approve, reject (reason) and apply are separate commands with `expectedRevision`. Whether the assistant is used is DEC-016.                                                                                                                         | **Verified** in jsdom; DEC-016 **Pending decision**                                              | `src/screens/today/__tests__/AssistantPanel.test.tsx`         |
| SCR-S-20: person record, contact points and the scoped timeline with paging; sources not readable listed as not available; a child minimized as the API returns it. Search by name or contact is not available (no API search); lookup by reference, validated before any request. Lookup latency target DEC-036.                                                                                                                                                                            | **Verified** in jsdom; search **Proposed** handling of an API gap                                | `src/screens/people/__tests__/PersonRecordScreen.test.tsx`    |
| SCR-S-21: relationships with each permission chosen on its own (none pre-selected), grants shown and revoked individually with a reason and `expectedRevision`, households (grouping only), invitations with their full record and the API's own expiry; no changes offline (§4.15). The existing relationships, grants, households and invitations of a person cannot be listed (no API read); the people a person may view come from the timeline scope. Guardian verification is DEC-004. | **Verified** in jsdom; list **Proposed** handling of an API gap; DEC-004 **Pending decision**    | `src/screens/people/__tests__/RelationshipsScreen.test.tsx`   |
| SCR-S-22: open a review (reason and owner required, evidence references only), the review with parties, evidence and decision history, decisions with `expectedRevision`, a restriction's end chosen explicitly. Open reviews cannot be listed (no API read); escalated reviews come from support cases with an `access_review` origin.                                                                                                                                                      | **Verified** in jsdom; queue **Proposed** handling of an API gap                                 | `src/screens/people/__tests__/AccessReviewScreen.test.tsx`    |
| SCR-S-23: flag a pair (score left to the API), compare both records, merge with an explicit survivor and reason, follow the merge operation (`recovery_required` shown), dismiss. Candidates cannot be listed or re-read (no API read). Migration duplicates are DEC-014, DEC-067, DEC-068.                                                                                                                                                                                                  | **Verified** in jsdom; queue **Proposed** handling of an API gap; migration **Pending decision** | `src/screens/people/__tests__/DuplicateReviewScreen.test.tsx` |
| SCR-S-49: case queue with status, category, facility and "assigned to me" filters and paging; open a case (category required); the case with related records' own state, origin exception status, history, linked actions (unknown outcome says not to repeat it); status changes exactly the API's `allowedEvents`, resolve with a resolution, notes (history only), owner, linking a command by its operation. The refund and resend helpers are not built here.                           | **Verified** in jsdom                                                                            | `src/screens/support/__tests__/SupportCaseScreen.test.tsx`    |

## Conventions for screen builders

- **Layout.** One directory per screen under `src/screens/<area>/`, the screen in
  `<Name>Screen.tsx`, tests in `__tests__/<Name>Screen.test.tsx`. Register the route in
  `src/App.tsx` under the area's path from `src/navigation/areas.ts`. Start each component with a
  comment naming its SCR id and SPK requirements.
- **Reading.** `useApiQuery({ path: '/today', request: { query: { facilityId } } })`, typed from the
  OpenAPI document; render through `QueryBoundary` for loading, empty, error, offline with age and
  "not available". Use `useApp().facilityId` for the selected facility.
- **Commands.** `useApiCommand('post', '/assignments/{id}/accept', { invalidate: [['api', '/me/assignments']] })`
  and `submit({ path, body: { expectedRevision, reason, policyReferences } })`. One idempotency key
  per unchanged input; show `error` with `StateView variant="error"` and keep the form input.
- **Authorization.** Offer an action only when the API says it is available (`availableActions`,
  `nextActions`, sources marked `ok`); never from role names. ACCESS_DENIED and protected NOT_FOUND
  render as "not available".
- **Drag.** Any drag interaction must also work with `ReorderableList` or equivalent buttons and
  keys (SPK-UX-009).
- **Status.** `StatusBadge` with the staff label from `docs/package-a/journeys.md` section 3 (machine
  state names), never colour alone.
- **Privacy.** No child data in logs, analytics or URLs; route parameters are opaque ids.
- **Pending values.** A pending policy value comes from configuration or shows
  `StateView variant="pending-decision"`.
- **Tests.** `createTestApp({ routes, session, online, now, config })` from
  `src/testing/test-app.tsx`; `render(app.at('/today'))` renders the whole dashboard at a path with a
  fake API (`GET /me` and `GET /today` have defaults; override with `routes`), memory session,
  manual connectivity (`act(() => app.connectivity.set(false))`) and a fixed clock. Assert on
  `app.fake.requests`. Use `userEvent` for keyboard and pointer input.

## Dependencies

Exact versions published at least two weeks before 2026-10-24; transitive dependencies resolved with
the same floor. React matches the customer app (19.2.3, the version Expo SDK 57 requires), so React
Router 7 is used (React Router 8 requires React 19.2.7 or later).

| Package                             | Version | Published  | Why                                                                         |
| ----------------------------------- | ------- | ---------- | --------------------------------------------------------------------------- |
| `react`, `react-dom`                | 19.2.3  | 2025-12-11 | UI; same React as the customer app                                          |
| `react-router`                      | 7.18.4  | 2026-09-15 | Routing for the fourteen areas and the workspace                            |
| `@tanstack/react-query`             | 5.104.1 | 2026-10-02 | Data layer shared in design with the customer app                           |
| `vite` (dev)                        | 8.3.4   | 2026-10-08 | Development server with the `/v1` proxy, production build                   |
| `@vitejs/plugin-react` (dev)        | 6.1.2   | 2026-10-05 | React transform and fast refresh for `vite` (not used by the tests)         |
| `jsdom` (dev)                       | 29.1.1  | 2026-04-30 | DOM for tests (30.x needs Node 22.22.2; CI runs 22.22.0)                    |
| `@testing-library/react` (dev)      | 16.3.3  | 2026-08-27 | Component tests by role and label                                           |
| `@testing-library/dom` (dev)        | 10.4.2  | 2026-09-13 | Peer of `@testing-library/react`                                            |
| `@testing-library/user-event` (dev) | 14.6.7  | 2026-09-02 | Keyboard and pointer input in tests                                         |
| `@testing-library/jest-dom` (dev)   | 7.0.1   | 2026-08-09 | DOM matchers (types adapted to vitest 5 in `src/testing/jest-dom-types.ts`) |
| `@types/react` (dev)                | 19.2.18 | 2026-07-30 | React types                                                                 |
| `@types/react-dom` (dev)            | 19.2.7  | 2026-09-03 | React DOM types                                                             |

The root `vitest` (5.0.5) runs these tests as the `staff` project; the root also gained
`eslint-plugin-react-hooks` 7.1.1 (2026-04-17) for the React hooks lint rules.
