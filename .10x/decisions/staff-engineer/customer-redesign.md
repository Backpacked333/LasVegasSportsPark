# Cross-cutting: customer-redesign

- **Guards that keep the redesign honest**: the copy guard (source), `codesOutsideSupport` (run
  time), the colour-literal test, the theme contrast test, the release-bundle check (no gallery,
  demo code or browser-preview storage in native bundles).
- **Rules for new screens** are in `apps/mobile/README.md`, "Conventions for screen builders":
  customer words, `pending.ts`, `CommandError`, `SupportDetails`, one heading per idea, illustrated
  empty states, `MediaScrim`, zone helpers, `useMotion()`, `returnFocusTo` on sheets.
- **Shared-file changes in the finish pass were additive**: `Section` title optional, `StatTile`
  `plain`, `ListRow` `spokenDetail` and first-row divider, `SwitchRow` thumb, `MediaScrim`,
  `offline-banner.ts`, test helpers in `src/testing/ui-surfaces.ts`.
