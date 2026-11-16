# ADR-001: Glass-forward layering on web and mobile

**Status:** Accepted
**Date:** 2026-11-14
**Feature:** glass-demo-amendments
**Author:** Architect and staff engineer

## Context

The product owner asked for a glass interface, rejected a first redesign as not clean enough, and
then chose "glass-forward": more glass than navigation alone, without making dense content hard to
read. SPK-UX-010 asks for strong readability in busy facilities; SPK-UX-009 sets the contrast and
motion floor. On the web the bend of liquid glass renders only in Chromium; on phones it needs
native code.

## Decision

Three layers in both apps: a backdrop; content (lists, tables, forms, long text) that is solid;
and glass for chrome and for the headline pieces of a screen (toolbars, stat tiles, hero cards,
sheets, toasts). Content inside a glass body is flat; a glass body never holds another.

- Web: the existing `Glass` component (SVG displacement through `backdrop-filter`) with the CSS
  frost fallback, extended with a `GlassCard`-style use for headline pieces. The backdrop moves to
  the application root so every glass body has something behind it.
- Mobile: one `GlassSurface` primitive that picks `expo-glass-effect` where the system offers it,
  `expo-blur` otherwise, and an opaque themed surface when neither is available or reduced
  transparency is on. Screens never import the native packages directly.

## Alternatives Considered

| Alternative              | Pros                          | Cons                                            | Why Not                           |
| ------------------------ | ----------------------------- | ----------------------------------------------- | --------------------------------- |
| Glass on navigation only | Calmest, already built        | The owner asked for more                        | Rejected by the owner             |
| Glass on every surface   | Most dramatic                 | Text over a busy backdrop fails contrast        | Breaks SPK-UX-009 and SPK-UX-010  |
| CSS blur only (no bend)  | Works in every engine         | Reads as an older style; not what was asked     | Kept only as the fallback         |
| Skia shaders on mobile   | Real refraction on all phones | Heavy native dependency, cannot be checked here | Too much unverifiable native code |

## Consequences

### Positive

- One rule decides whether a new surface is glass, so screens stay consistent.
- Native packages are behind one primitive: removing or replacing them touches one file.

### Negative

- More glass bodies per screen cost paint time; stat rows are capped and off-screen bodies drop
  their filter.
- Two new native dependencies in the customer app.

### Risks

- Mobile glass is not device-tested in this work. Mitigation: opaque fallback is the default path
  in tests; the README lists what the owner must check on a phone.
- Contrast on glass over arbitrary content. Mitigation: the measured contrast check from pull
  request 21 runs on every screen with glass headline pieces.

## Dependencies

- Depends on the tokens of `apps/staff/src/ui/styles.css` and `apps/mobile/src/ui/theme.ts`.
- Constrains every new screen of the ten amendments to use the shared primitives.
