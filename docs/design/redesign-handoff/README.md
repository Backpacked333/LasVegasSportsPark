# Handoff: Sportspark redesign — parent app + staff app

## Start here (paste this into Claude Code)

> Read `design_handoff_sportspark/README.md`, then `BUILD_PLAN.md`. Implement the phases in order in this repo (`Backpacked333/LasVegasSportsPark`). For every screen, open its HTML design in `designs/` for exact layout, copy and values, follow `INTERACTIONS.md` for behaviour, and `SCREENS.md` for the designer's notes. Reuse the existing components and theme in `apps/mobile/src/ui` and `apps/staff/src/ui` — extend them, don't fork a parallel system. Endpoints tagged ◷ don't exist yet: add them to the API (or stub them behind an interface) and list what you added at the end of each phase.

## Overview

A redesign of the two front-ends of the Las Vegas Sportspark platform:

- **Parent app** (`apps/mobile`): a parent manages several children's leagues, classes and camps: what's on today, answering for games, paying, signing forms, registering, the facility pass, messages.
- **Staff app** (`apps/staff`): the front desk, managers, coaches, referees and field crew run the day: readiness, schedule, registrations, arrival check-in, money, people, incidents.

Direction: **refine the current system** (ADR-008 customer visual system v2, classic theme), not a new brand. Primary audience is parents.

## About the design files

Everything in `designs/` is a **design reference built in HTML**. It shows the intended look and behaviour; it is not production code. Recreate these screens in the existing apps with their own patterns (React Native in `apps/mobile`, React web in `apps/staff`). Don't ship or port the HTML.

How to view: open any `designs/*.dc.html` file in a browser (it needs `support.js` next to it, which is included). Each board is a pan-and-zoom canvas. Screens carry id badges (`1b`, `3g`…), grouped in rounds with the newest round at the top. A link like `Mobile Redesign.dc.html#3g` jumps to a screen.

| File                                   | What it is                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `designs/Mobile Redesign.dc.html`      | Every parent-app screen, rounds 1–5 (33 screens)                                              |
| `designs/Staff Redesign.dc.html`       | Every staff screen, rounds 1–5 (24 screens)                                                   |
| `designs/Parent App Prototype.dc.html` | Clickable prototype of the main parent flows (Home, pay, sign, answer, Calendar, Teams, Pass) |
| `designs/Interaction Spec.dc.html`     | The interaction spec as a page (same content as `INTERACTIONS.md`)                            |
| `SCREENS.md`                           | Generated inventory: every screen id, title, frame size and behaviour notes                   |
| `INTERACTIONS.md`                      | Per-control spec: gesture → result → API → edge cases, global rules, key flows                |
| `BUILD_PLAN.md`                        | Phased build order, with acceptance checks and screens not yet designed                       |

## Fidelity

**High-fidelity.** Colours, type, spacing, radii, copy and states are final. Match them closely using the codebase's existing primitives. Exceptions:

- People photos in `designs/assets/people/` are **stock placeholders** (Pexels). In the product they're user-uploaded profile photos with an initials fallback.
- Anything shown in purple `#5B3FA8` or tagged "Proposed" / ◷ depends on a product or API decision (see "Open decisions").
- The current Home recreation (Mobile `1a`) shows today's main branch for comparison; don't build it.

## Platforms and frame sizes

- Parent app: phone, designed at **390×844** (iPhone 14/15). Tab bar: Home · Explore · Calendar · Teams · You.
- Staff, desktop: **1440** wide (office). Left glass rail 84px + content.
- Staff, tablet: **1180×820** (front desk, landscape). The same rail; controls used at scan time are 52–56px.
- Staff, phone: **390×844** (coach / manager on the field). A floating glass tab bar.
  All staff layouts are one responsive app: the rail collapses to the phone tab bar under 600px.

## Design tokens

Fonts: **Archivo** 400/500/600/700/800 everywhere (Google Fonts). Icons: Material Symbols. The parent app uses _Outlined_ and staff uses _Rounded_; pick one for both (see open decisions).

Colour roles

| Token      | Hex                                                | Use                                                       |
| ---------- | -------------------------------------------------- | --------------------------------------------------------- |
| pitch      | `#0A7040`                                          | primary action, selected, links (hover `#085A33`)         |
| pitch-deep | `#0A5C35` / `#06512E`                              | text on pitch tints                                       |
| pitch-tint | `#E2F0E7` / `#E3F1E8`                              | secondary buttons, success bg                             |
| floodlight | `#C6F36B`                                          | "now", live pill, active tab pill, accents on night       |
| night      | `#0C2219`                                          | price bar, pass, scanner, coach headers, toasts `#1B2420` |
| night-2    | `#122C21` / `#16352A` / `#24473A` / `#2F5444`      | surfaces and borders on night                             |
| night-text | `#E8F0EB`, muted `#9DB3A7`                         | text on night                                             |
| sand       | `#F5F5F2`                                          | page background                                           |
| surface    | `#FFFFFF`                                          | cards                                                     |
| sunk       | `#EFEFEB` / `#ECECE7` / `#F9F9F7`                  | segmented tracks, table heads                             |
| ink        | `#111614`                                          | primary text                                              |
| ink-2      | `#39423E`                                          | body secondary                                            |
| muted      | `#5F6965`                                          | captions, meta                                            |
| faint      | `#A9B1AD`                                          | disabled, placeholders                                    |
| line       | `#E9E8E3`, strong `#DBD9D3`, row divider `#F0EFEB` | borders                                                   |
| proposed   | `#5B3FA8` on `#EEE8FA`                             | anything not in the API yet                               |

Status tones: always **glyph + word**, never colour alone.

| Tone                   | Glyph | Text                       | Bg                                       |
| ---------------------- | ----- | -------------------------- | ---------------------------------------- |
| success                | ✓     | `#0A5C35`                  | `#E3F1E8`                                |
| warning / needs action | ▲     | `#8A5300`                  | `#FDF0D5` (border `#F0D9A6`)             |
| error / blocked / full | ✕     | `#B3261E` (deep `#8E1D17`) | `#FBE3E0` / `#FBF1EF` (border `#F3C9C3`) |
| info                   | ℹ     | `#1A4FD6`                  | `#E4EBFD`                                |
| neutral                | ●     | `#4A5651`                  | `#EEF0EE`                                |
| pending / proposed     | ◷     | `#5B3FA8`                  | `#EEE8FA`                                |

Person colours (each child keeps one everywhere: chip, calendar stripe, avatar ring, initials fallback): Maya pink `#B0306B` (initials bg `#F8DDE8`, text `#8E2152`), Leo blue `#1D409E`, plus `#E08A1E`, `#0E8A8A`, `#5B3FA8` for new children. Activity stripes: league `#0B6B3A`, class `#2D5BD8`, rental `#B07A12`, waitlist `#5B3FA8`.

Type scale (parent app): title 26–34/700 (−0.5px tracking), section 19/600, card title 17/700, body 15/400–600, caption 13/400, tab label 11/700. Staff is denser: page title 26–30/700 (−0.02em), body 14, meta 12–13.

Radius: cards 20–24 · sheets 28 (top) · tiles/inputs 14–16 · small icon tiles 10–12 · buttons, chips and avatars fully round (999). Staff rail 26, staff cards 20.

Shadows: card `0 2px 4px #0C22190F, 0 8px 20px #0C221914`; quiet card `0 1px 2px #0C22190F, 0 2px 8px #0C22190A`; sheet `0 -8px 32px #0C22191A`; staff glass rail `0 0 0 1px rgba(0,0,0,.12), 0 8px 28px rgba(16,24,20,.14), inset 1.5px 1.5px 0 -.5px rgba(255,255,255,.96)` with `backdrop-filter: blur(24px) saturate(1.5)` on `rgba(255,255,255,.28)`.

Spacing: 4-pt base. Screen gutter 20 (parent) / 14–16 (staff phone) / 24–28 (staff desktop). Card padding 14–16. Gaps 6 / 8 / 10 / 12 / 14 / 20.

Hit targets: 44px minimum on phones; 52–56px for desk-tablet controls used while scanning; primary CTAs 52–56px tall.

Motion: sheets slide up 320ms ease-out; toasts 220ms; filter changes cross-fade 200ms; paid / done rows flash green for 3s, then leave the list. Honour reduce-motion (fade only).

## Global behaviour (short; full rules in `INTERACTIONS.md`)

- Writes are **optimistic with Undo** (5s toast). On failure: revert, and say what didn't save, with Try again.
- **Money is never optimistic.** Spinner, sheet locked, idempotency key on every payment POST.
- Loading uses skeletons in the final layout. Errors give a plain sentence, the next step, and a small code (`SPK-PAY-003`).
- **Offline:** amber banner showing the time of the last good data. Reads come from cache. Writes are disabled with a reason, except check-ins and attendance, which queue on the device with a visible count.
- Times are always in the facility's time zone. Every push or email deep-links to its exact screen.

## State and data (summary)

- Parent app: session/household (people, the selected child filter, remembered per device), today's events, to-dos (fees, forms, invites), the attendance intent per person/event, quotes/payments, notifications, waitlist offers, a cached pass token (signed, refreshed daily, works offline).
- Staff app: facility and role, today's sessions with readiness checks (ref / forms / field), bookings, registrations queue, arrival scans and the offline check-in queue, attendance per session, tasks/incidents.
- Existing APIs read on main: `GET /v1/offerings`, `GET /v1/offering-availability`, `POST /v1/discounts/evaluate`, `POST /v1/registration-quotes`. Everything else is ◷ and is listed per control in `INTERACTIONS.md`.

## Repo mapping

See the project's `github.md` mapping. Key files: `apps/mobile/src/ui/theme.ts`, `src/ui/*` (MediaCard, ListRow, Card, StatusBadge, AppHeader), `src/navigation/TabsNavigator.tsx`, `src/screens/home/*`, `src/features/registration/CampWeeks.tsx`; `apps/staff/src/ui/styles.css`, `src/ui/glass/glass.css`, `src/layout/Shell.tsx` and `AreaNav.tsx`, `src/screens/today/*`, `src/screens/arrival/arrival.css`, `src/screens/workspace/WorkspaceTabBar.tsx`. Visual-system docs: `docs/package-a/customer-visual-system.md`, `.10x/adrs/008-customer-visual-system-v2.md`.

## Assets

- `designs/apps/mobile/assets/artwork/*.webp`, `designs/apps/staff/public/field-lines.svg`: copied from the repo; use the originals.
- `designs/assets/people/*.jpg`: stock placeholders for profile photos. Don't ship them.

## Open decisions (block the ◷ items)

1. "Maybe" as an attendance answer (DEC-021).
2. Instalment plans on fees.
3. Apple / Google Wallet passes (DEC-023).
4. Auto-offering a waitlist place to the next family.
5. Slot holds (15 min) and prices on the staff side.
6. A "players needed" field per game (drives "enough to play").
7. One icon set for both apps (Outlined vs Rounded).
8. A messaging API (team threads, SMS fallback).
