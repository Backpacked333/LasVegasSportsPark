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
