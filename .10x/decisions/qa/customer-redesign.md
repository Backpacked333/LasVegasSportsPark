# QA: customer-redesign

- **Behaviour frozen.** Requests, idempotency keys, revisions, announcements and states are asserted
  as before; where a fix changed visible words the test asserts the new literal (never a test id or
  a loose pattern) and the commit lists old and new strings. Requirement ids stay in test names.
- **Count.** Finish pass: 174 → 177 suites, 2,084 → 2,150 tests (new suites:
  `eligibility-words.test.ts`, `policy-words.test.ts`, `known-zone.test.tsx`).
- **New checks** (`apps/mobile/src/testing/ui-surfaces.ts`): `codesOutsideSupport(screen)` (no
  internal code shown or spoken outside the support fold: catches text the API builds at run time,
  which the source-level copy guard cannot see); `illustrationsOnScreen(screen)`;
  `mockFontScale(2)` and `truncatedTexts(screen)` (200% text on Home, Explore, Pay, Pass).
- **Browser preview.** Each finish-pass fix was looked at in the screenshot harness (classic and
  Legends, 390×844 and 375×667). A browser render is not native acceptance (§6.2).
- **Not covered** (needs devices): screen reader order and focus, real font scaling, glass, haptics,
  gestures, native pickers, image memory on long lists.
