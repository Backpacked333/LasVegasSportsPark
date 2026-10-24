# @sportspark/mobile

Customer app for iOS and Android: Expo, React Native and Expo Router (spec §2.2, §4.1, SPK-UX-001).
This is the foundation shell that screen groups fill; most screens are placeholders that name their
inventory id (`docs/package-a/screen-and-journey-inventory.md` section 4).

Status legend (§6.7): **Verified** = implemented and asserted by a test here. **Proposed** =
engineering proposal awaiting operator approval. **Pending decision** = needs an operator answer;
owners are in `docs/package-a/decision-register.md`. Nothing in this app has passed native
acceptance (§6.2): a passing test or a successful bundle export is not native acceptance.

## Run against a local API

```bash
pnpm install
# API in development mode (local identity provider, in-process PGlite):
AUTH_LOCAL_SECRET=$(openssl rand -hex 32) pnpm --filter @sportspark/api dev
# The app (Expo dev server; open in a simulator, an emulator or a development build):
SPORTSPARK_API_BASE_URL=http://localhost:3000/v1 pnpm --filter @sportspark/mobile start
```

- An Android emulator reaches the host at `http://10.0.2.2:3000/v1`; a physical device needs the
  computer's LAN address.
- Sign in from Account or Home: development builds offer **Development sign-in**, which asks the
  API's `POST /v1/dev/tokens` for a token for an existing local account id. That route exists only
  when the API runs with `AUTH_MODE=local` outside production. The API has no development seed, so
  the account must already exist in the database you run against.
- `SPORTSPARK_STALE_DATA_THRESHOLD_MINUTES` sets the age after which shown data is called stale.
  The value is pending (DEC-032, DEC-033); unset, the app shows data age but never calls it stale.

## Commands

| Command                                       | What it checks                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm --filter @sportspark/mobile test`       | jest-expo and React Native Testing Library (also run by the root `pnpm test`) |
| `pnpm --filter @sportspark/mobile typecheck`  | TypeScript strict (also run by the root `pnpm typecheck`)                     |
| `pnpm --filter @sportspark/mobile lint`       | Root ESLint config, including React hooks rules                               |
| `pnpm --filter @sportspark/mobile export:ios` | Release bundle export, then `scripts/check-release-bundle.mjs` (CI runs this) |

## What is here and how it is verified

| Item                                                                                                                                                                                                                      | Status                                                                                                    | Evidence                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Five tabs in order Home, Discover, Schedule, Teams, Account, each with an accessible label (SPK-UX-002).                                                                                                                  | **Verified** in jest                                                                                      | `src/navigation/__tests__/navigation.test.tsx`                               |
| Facility pass and notification inbox reachable from Home and from the header of every destination, not as tabs (SPK-UX-002).                                                                                              | **Verified** in jest                                                                                      | same                                                                         |
| Unknown links land on "Link not available" (SCR-C-39, §4.13 safe destinations). Which links are verified is DEC-061.                                                                                                      | **Verified** (fallback only); link verification **Pending decision**                                      | same                                                                         |
| State primitives for SPK-UX-008: `StateView` (loading, empty, error with code and recovery, offline-stale with age, unavailable, pending-decision), `StatusBadge` (glyph and text), `Button`, `ListRow`, `QueryBoundary`. | **Verified** in jest                                                                                      | `src/ui/__tests__/primitives.test.tsx`                                       |
| SCR-C-40 connectivity and stale-data banner: offline with the age of what is shown and the actions that need a connection; "Back online. Refreshing"; stale only with a configured threshold.                             | **Verified** in jest                                                                                      | `src/connectivity/__tests__/ConnectivityBanner.test.tsx`                     |
| Foreground refresh (SPK-UX-001): returning to the app refetches what is on screen (TanStack `focusManager` on `AppState`).                                                                                                | Implemented, not asserted by a test; needs devices (§6.2 "App backgrounding during payment")              | `src/providers/AppProviders.tsx`                                             |
| Session in expo-secure-store (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) behind the `SessionStore` interface; memory store in tests (§4.13).                                                                                       | **Verified** with a mocked module; device lifecycle (reinstall, restore, OS upgrade) needs devices        | `src/session/__tests__/secure-session-store.test.ts`                         |
| Session expiry: an AUTHENTICATION_REQUIRED answer clears the stored session and asks to sign in again.                                                                                                                    | **Verified** in jest                                                                                      | `src/api/__tests__/data-layer.test.tsx`                                      |
| "Update required" covers the app when the API says the build is unsupported (SCR-C-39, SPK-AT-027).                                                                                                                       | **Verified** client side; the API answer (DEC-092) and minimum version (DEC-061) are **Pending decision** | same                                                                         |
| One idempotency key per user intent, reused on retry (`useApiCommand`, §4.9).                                                                                                                                             | **Verified** in jest                                                                                      | same                                                                         |
| SCR-C-06 inbox reads `GET /v1/me/inbox` with all its states (reference screen for screen builders).                                                                                                                       | **Verified** in jest                                                                                      | `src/screens/inbox/__tests__/InboxScreen.test.tsx`                           |
| Development sign-in exists in development builds only and is absent from release bundles.                                                                                                                                 | **Verified** (jest, and the export check fails on a development bundle)                                   | `src/dev/__tests__/dev-sign-in.test.tsx`, `scripts/check-release-bundle.mjs` |
| Managed sign-in, account verification and recovery (SCR-C-01, SCR-C-02).                                                                                                                                                  | **Pending decision** DEC-018 (Technical lead/account owners); the screen shows the pending state          |                                                                              |
| Account deletion and data requests (§4.13).                                                                                                                                                                               | **Pending decision** DEC-059 (Operator/privacy owner); Account shows the pending state                    |                                                                              |
| Bundle identifiers, supported OS versions, minimum app version, privacy declarations, push, deep-link domains (§4.13).                                                                                                    | **Pending decision** DEC-061; not set in `app.config.ts`                                                  |                                                                              |
| Facility pass (SCR-C-05).                                                                                                                                                                                                 | Not built: the API has no read of the customer's own pass                                                 |                                                                              |
| Native acceptance on signed builds and physical devices (§6.2), including VoiceOver, TalkBack and large text.                                                                                                             | **Pending**: not possible in this repository; tracked in `docs/package-a/native-acceptance-matrix.md`     |                                                                              |

## Conventions for screen builders

- **Layout.** A route file under `app/` only re-exports a screen: `export { InboxScreen as default } from '../src/screens/inbox/InboxScreen';`.
  The screen lives in `src/screens/<area>/<Name>Screen.tsx`, its tests in
  `src/screens/<area>/__tests__/<Name>Screen.test.tsx` (never under `app/`: every file there is a
  route). Start each component with a comment naming its SCR id and SPK requirements.
- **Frame.** Wrap the screen in `<Screen>` (connectivity banner, scrolling for large text). Use
  `RequireSession` for anything that needs an account.
- **Reading.** `useApiQuery({ path: '/me/inbox', request: { query: { limit: 50 } } })` is typed from
  the OpenAPI document and returns `updatedAt`. Render it with `QueryBoundary`, which handles
  loading, empty, error, offline with age, and NOT_FOUND or ACCESS_DENIED as "not available".
- **Commands.** `const accept = useApiCommand('post', '/assignments/{id}/accept', { invalidate: [['api', '/me/assignments']] })`,
  then `accept.submit({ path: { id }, body: { expectedRevision } })`. The hook keeps one idempotency
  key per unchanged input, so "Try again" never duplicates an effect. Always send `expectedRevision`
  where the body takes it. Show `accept.error` with `StateView variant="error"`; keep the user's input.
- **Status.** `StatusBadge` with the phrase from `docs/package-a/journeys.md` section 3; never
  colour alone. "Payment processing", "Confirmed, awaiting placement" and "Confirmed" use different
  tones, glyphs and words.
- **Authorization.** Render what the API returns (`availableActions`, scopes) and its answers; never
  hide or show actions from role names. A protected NOT_FOUND is "not available" with no hint that
  the record exists.
- **Privacy.** No child data in logs, analytics or URLs (§4.14); route parameters are opaque ids.
- **Pending values.** A policy value or decision that is pending (decision register) comes from
  configuration or is shown with `StateView variant="pending-decision"`; never hard-code one.
- **Tests.** `createTestApp({ routes, session, reachable, now, config })` from
  `src/testing/test-app.tsx` gives real providers with a fake API
  (`'GET /me/inbox': { status: 200, body }` or a function returning `fakeResponse(...)`), a memory
  session store, manual connectivity (`app.sources.setReachable(false)`) and a fixed clock. Render
  with `render(<Screen />, { wrapper: app.wrapper })` and assert on `app.fake.requests`. Name each
  test after the requirement it proves. Whole-navigation tests use `renderRouter` from
  `expo-router/testing-library` (see `navigation.test.tsx`).

## Dependencies

Expo SDK 57 is used: it is the newest SDK whose release is more than two weeks old. SDK 58 is
published, but its first patch on a final React Native release (58.0.11, with React Native 0.88.0)
is from 2026-10-15, less than two weeks before this foundation was built (2026-10-24); earlier
SDK 58 patches depend on a React Native release candidate. Versions are exact and were published at
least two weeks earlier; the Expo set equals the `bundledNativeModules` of `expo@57.0.27`. Transitive
dependencies were resolved with the same two-week floor. (`npx expo install --check` compares
against later SDK 57 patches published after that floor.)

| Package                               | Version | Published  | Why                                                                                                   |
| ------------------------------------- | ------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `expo`                                | 57.0.27 | 2026-10-06 | SDK, CLI (`expo start`, `expo export`), native module runtime                                         |
| `react`                               | 19.2.3  | 2025-12-11 | Version required by SDK 57                                                                            |
| `react-native`                        | 0.86.3  | 2026-08-24 | Version required by SDK 57                                                                            |
| `expo-router`                         | 57.0.25 | 2026-10-06 | File-based native navigation, tabs and stack (SPK-UX-001/002)                                         |
| `react-native-screens`                | 4.26.2  | 2026-07-16 | Native screens, required by expo-router                                                               |
| `react-native-safe-area-context`      | 5.7.0   | 2026-02-24 | Safe areas, required by expo-router                                                                   |
| `expo-linking`                        | 57.0.12 | 2026-10-06 | Links, required by expo-router                                                                        |
| `expo-constants`                      | 57.0.21 | 2026-10-06 | Reads `app.config.ts` (API base URL, app version)                                                     |
| `@expo/metro-runtime`                 | 57.0.16 | 2026-09-18 | Metro runtime, required by expo-router                                                                |
| `@expo/log-box`                       | 57.0.4  | 2026-08-26 | Error overlay, required by expo-router                                                                |
| `expo-secure-store`                   | 57.0.4  | 2026-09-11 | Platform secure storage for the session (§4.13)                                                       |
| `expo-network`                        | 57.0.2  | 2026-09-11 | Connectivity for SCR-C-40                                                                             |
| `expo-crypto`                         | 57.0.3  | 2026-09-11 | Secure random idempotency keys (React Native has no `crypto`)                                         |
| `@tanstack/react-query`               | 5.104.1 | 2026-10-02 | Data layer: caching, refetch on focus and reconnect, data age                                         |
| `jest` (dev)                          | 29.7.0  | 2023-09-12 | Test runner used by jest-expo                                                                         |
| `jest-expo` (dev)                     | 57.0.5  | 2026-08-26 | Expo's documented Jest preset for SDK 57                                                              |
| `@react-native/jest-preset` (dev)     | 0.86.3  | 2026-08-24 | Required peer of jest-expo 57                                                                         |
| `@testing-library/react-native` (dev) | 13.3.3  | 2025-08-26 | Component tests by role and label (14.x requires a `test-renderer@^1` peer with no published release) |
| `react-test-renderer` (dev)           | 19.2.3  | 2025-12-11 | Renderer for React Native Testing Library 13                                                          |
| `@types/jest` (dev)                   | 29.5.14 | 2024-10-23 | Jest types                                                                                            |
| `@types/react` (dev)                  | 19.2.18 | 2026-07-30 | React types                                                                                           |

`expo-router` brings `react-native-reanimated` and `react-native-worklets` in as peers of optional
features (drawer, `@expo/ui`); pnpm installs them (4.7.1 and 0.13.0, not the SDK 57 versions) and
the app does not import them. Whether native autolinking would include them has not been checked:
there is no native build here. A screen that needs them must add the SDK 57 versions (4.5.1 and
0.10.1) as direct dependencies.

## Team screens

Teams, captain workspace, roster, availability, contributions, roster changes, team entries,
standings and disputes (SCR-C-21 to SCR-C-29) are described, with their status, pending decisions
and API gaps, in [`src/screens/teams/README.md`](src/screens/teams/README.md).
