# Architecture: customer-redesign

Decision record: ADR-008 (customer visual system v2, **Proposed**); wording PA-11 (DEC-107,
**Proposed**). Builds on ADR-001 (glass layering).

- **One library.** `apps/mobile/src/ui` is the only place screens get components, tokens, motion,
  sheets, images and haptics from. The five feature kits were removed; no screen imports a native UI
  library directly.
- **Defaults that keep tests deterministic.** Without a `MotionProvider` motion counts as reduced;
  without a `GlassProvider` glass is solid; sheets render through `Modal` under Jest and on the web.
- **Codes stay out of sight, not out of reach.** Identifiers and API staff wording live in
  `SupportDetails`; the screens show customer words chosen by code (`eligibility-words.ts`,
  `policy-words.ts`, `src/copy/pending.ts`). §4.10 asks for codes to be available, not prominent.
- **Facility time without new reads.** `useKnownFacilityZone` (`src/features/today/known-zone.ts`)
  takes the zone any cached answer stated, only when all agree, else the device's; a record's own
  zone always wins. **Proposed** API change: state the facility zone on money and pass records,
  which carry none today.
- **One offline notice.** `Screen` provides `OfflineBannerContext`; `StateView` reads it so a
  section under the banner says only its own age and needs.
- **Lists.** Explore, Calendar, Teams and the inbox use `Screen` list or sections mode. **Proposed**:
  the paged lists inside card sections follow (a layout change: they sit in sections and behind
  `CapabilityGate`).
