# Track H: glass-forward interface (what was built)

Feature: `glass-demo-amendments` · ADR-001

## Staff dashboard

- Backdrop at the application root (`apps/staff/src/layout/shell.css`, tokens `--backdrop-*` in
  `ui/styles.css`, markings in `public/field-lines.svg` drawn through a mask so the colour is a
  token). The sidebar's own field of colour is kept only for the phone drawer.
- `Glass` (`ui/glass/Glass.tsx`): new `as`, pass-through of labelling attributes, and the `tint`
  material (coloured glass; `--glass-amount` may deepen it and never thins it).
- Kit (`ui/glass/GlassCard.tsx`): `GlassCard` (plain or night), `Toolbar` (hugs its controls;
  `fill` spans the column), `TabTrack` (surface only; scrolls sideways on phones). `Kpi` is a
  glass tile.
- Moved onto glass: six hero cards, seven page toolbars, the tab strips of every area.

## Customer app

- `apps/mobile/src/ui/GlassSurface.tsx`: `glassModeFor`, `GlassProvider`, `GlassSurface`.
  `liquid` (iOS 26, `expo-glass-effect`), `blur` (earlier iOS, `expo-blur`), `solid` (Android,
  web, reduce transparency, tests).
- Tab bar floats on glass where the mode is not `solid`; `Screen` insets its content
  (`BottomBarInsetContext`). `Hero` is coloured glass under `liquid`.

## Deviations from the design

- Web: no sheets or toasts exist in the dashboard, so none were made glass.
- Mobile: headers stay solid, and Android stays solid. A transparent header and Android's
  experimental blur both change screen layout in ways that cannot be checked without devices.
  **Pending decision** for the owner after trying the build on phones.

## Left for integration (files other tracks are editing)

- `apps/staff/src/screens/teams/TeamsScreen.tsx` and `TeamEntryReviewScreen.tsx`: page toolbars
  to move onto `Toolbar`.
- `apps/staff/src/screens/people/PersonRecordScreen.tsx` and `leagues/FixtureScreen.tsx`: tab
  strips to wrap in `TabTrack`.

## Dependencies added

`expo-glass-effect` 57.0.5 and `expo-blur` 57.0.3 in `apps/mobile` (lockfile changed).

## Not verified

- Any phone. Safari and Firefox on real devices (the fallback was checked in Chromium).
