# ADR-008: Customer visual system v2

**Status:** Proposed (requested by the product owner on 2026-11-16)
**Date:** 2026-11-16
**Feature:** customer-app-redesign
**Author:** Architect and staff engineer

## Context

The product owner finds the customer app (`apps/mobile`) dated, wordy and hard to navigate, and on
2026-11-16 asked for a premium consumer feel: big imagery, cards, a few clear actions per screen,
sheets and smooth motion, for parents and adult players equally. Inspection of the app on that day
(**Verified**): no imagery; screens built mostly from paragraphs and label/value lines; no motion,
sheets, pickers, skeletons, pull to refresh or long-list virtualisation; five feature folders with
their own copies of sections, fields and choices.

The specification constrains the answer: SPK-UX-009 (VoiceOver, TalkBack, text scaling, focus
order, non-colour status), SPK-UX-010 (soccer identity, clear hierarchy, readability in busy
facilities, restrained animation, simple customer choices), SPK-UX-008 (every state defined) and
§6.2 (a simulator or browser render is not native acceptance). ADR-001 already decides where glass
goes; this record decides the rest of the customer visual system. The navigation and wording
changes that touch requirement text are proposed separately as PA-11 (DEC-107).

## Decision

One visual system in `apps/mobile/src/ui`, used by every screen; screens do not import the native
UI libraries directly.

- **Elevation.** Four levels (`card`, `raised`, `sheet`, `bar`). On the classic theme a level is a
  shadow; on Legends (dark) it is a lighter surface and a hairline border, because shadows do not
  show on black. Glass stays as ADR-001 decides (chrome and headline pieces only).
- **Motion.** Durations of 0, 120, 220 and 320 ms, standard easings and springs, and a press scale
  of 0.97: short and purposeful, as SPK-UX-010 asks. Every animated component reads `useMotion()`
  (`src/ui/motion.tsx`). It follows the device's reduce-motion setting; with reduced motion every
  duration is 0 and nothing moves. Without a `MotionProvider` (every screen test) motion counts as
  reduced, the same rule as `GlassProvider`, so tests never depend on an animation.
- **Sheets.** `@gorhom/bottom-sheet` behind one `Sheet` component for in-screen choices (filters,
  pickers, short confirmations). Route-level sheets (the pass, a notice) use the native stack's
  form sheet. In tests and on the web the same component renders through React Native's `Modal`,
  so content stays queryable. Focus moves into a sheet and back to its trigger.
- **Imagery.** Photographic activity images and illustrated empty states, bundled in the app as
  compressed webp with byte budgets enforced by a test, drawn through `expo-image` behind one
  `Artwork` component that is always hidden from screen readers. Text over an image only sits on a
  scrim token whose contrast is computed against pure white and pure black. No faces, logos or
  text in the artwork.
- **Haptics.** Selection, light and medium impact, success and warning, through an injected
  `haptics` service (`src/providers/haptics.ts`): expo-haptics on devices, silent on the web, a
  recorder in tests. The operating system's haptics setting applies. A haptic is never the only
  feedback: every event that plays one also changes the screen or is announced (SPK-UX-009).
- **Libraries.** Exact versions that Expo SDK 57 bundles, each with a row in the mobile README:
  `react-native-reanimated`, `react-native-worklets`, `react-native-gesture-handler`, `expo-image`,
  `expo-linear-gradient`, `react-native-svg`, `expo-haptics`,
  `@react-native-community/datetimepicker`, and `@gorhom/bottom-sheet` 5.x (not part of the SDK;
  chosen for peer ranges that accept the installed reanimated and gesture-handler).
- **Browser preview.** A development-only web build (`pnpm demo --web`) and a screenshot harness
  (`apps/mobile/scripts/screenshots.mjs`) let the redesign be reviewed and compared before and
  after. Its storage stand-ins (`*.web.ts`, marked "Browser preview storage") and the design
  system gallery are refused in native bundles by `scripts/check-release-bundle.mjs`.

## Alternatives Considered

| Alternative                            | Pros                            | Cons                                                         | Why Not                                |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| Restyle the existing components only   | No new native dependencies      | No sheets, pickers or motion; text-heavy screens remain      | Does not meet what the owner asked for |
| A third-party component kit            | Many components at once         | Its look and accessibility rules replace ours; large surface | Conflicts with ADR-001 and SPK-UX-009  |
| React Native's `Modal` for every sheet | No dependency                   | No drag, snap points or keyboard handling                    | Kept only as the test and web path     |
| Remote images from a content service   | Images change without a release | Network, caching and moderation questions; offline gaps      | Bundled images work offline (§4.15)    |
| Native screenshots in a simulator      | Closer to the shipped app       | No simulator in this environment                             | Browser preview now; devices at §6.2   |

## Consequences

### Positive

- One set of components, tokens and motion rules: screens look and behave alike, and accessibility
  is solved once per component.
- Reduced motion and reduced transparency are defaults in tests, so behaviour tests stay
  deterministic while the visual system grows.
- Before-and-after screenshots give the owner something to judge on every phase.

### Negative

- Eight new native dependencies (plus one JavaScript-only library) in the customer app; a native
  build is needed before any of them can be checked on a device.
- Bundled images add to the app size (budgeted at 5 MB in total).
- The web build is a second runtime to keep booting; it is development-only and may differ from
  native rendering.

### Risks

- Native behaviour (gestures, sheets, haptics, reanimated worklets) is not verified here: only Jest
  renders with the libraries' own mocks and a browser render. Mitigation: the mobile README lists
  what must be checked on devices; §6.2 acceptance stays with signed builds.
- Text over imagery failing contrast. Mitigation: only on the scrim token, contrast computed on
  white and black in the theme test, titles move below the image at large text sizes.
- Bottom-sheet peer ranges drifting with later SDKs. Mitigation: versions pinned exactly; route
  sheets use the native stack's form sheet.

## Dependencies

- Depends on ADR-001 (glass layering) and on the tokens of `apps/mobile/src/ui/theme.ts`.
- Paired with PA-11 (DEC-107) for the navigation labels and customer wording; the visual system
  does not depend on PA-11 being accepted.
- Constrains every customer screen rebuilt in the redesign to use the shared components.
