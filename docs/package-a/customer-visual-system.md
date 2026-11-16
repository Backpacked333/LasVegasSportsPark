# Customer visual system (customer app redesign)

Status legend: **Verified** = implemented and tested in this repository today (file cited).
**Proposed** = an engineering proposal awaiting the product owner's or operator's approval.
**Pending decision** = needs an answer from the owner named; no value is invented in the meantime.
A browser render is not native acceptance (§6.2): what is **Verified** here is verified in Jest and,
where said, looked at in the browser preview, never on a phone.

Last updated 2026-11-16. Decision records: ADR-008 (visual system v2, **Proposed**), ADR-001 (glass
layering), PA-11 / DEC-107 (customer destinations and plain words, **Proposed**). Code:
`apps/mobile/src/ui`, `apps/mobile/src/copy`, `apps/mobile/src/artwork`. How a screen builder uses
it: `apps/mobile/README.md`, "Visual system" and "Conventions for screen builders".

## 1. What the redesign set out to do

The product owner asked on 2026-11-16 for a premium consumer feel: big imagery, cards, a few clear
actions per screen, sheets and smooth motion, plain words, easy to find things (ADR-008 context).
The specification bounds it: SPK-UX-008 (every state defined), SPK-UX-009 (VoiceOver, TalkBack, text
scaling, focus order, non-colour status), SPK-UX-010 (soccer identity, clear hierarchy, restrained
animation, simple choices), SPK-SCHED-008 (facility time), §4.10 (codes available, not prominent).

## 2. The system

| Part               | What it is                                                                                                                                                                                           | Status                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Themes and tokens  | Classic (warm white, pitch green) and Legends (black, one gold accent) with the same token names; elevation, scrim, skeleton, tonal, toast and avatar tones; type, spacing, radius and motion tokens | **Verified** (`src/ui/theme.ts`, `src/ui/__tests__/theme.test.tsx`: every text pairing 4.5:1 by calculation) |
| Component library  | One set of components in `src/ui` used by every customer screen; the five feature kits were removed                                                                                                  | **Verified** (no screen imports a kit; component tests in `src/ui/__tests__`)                                |
| Imagery            | Bundled webp art behind `Artwork` (decorative, hidden from screen readers), photographic activity art, illustrated empty states; byte budgets enforced                                               | **Verified** (`src/artwork/manifest.ts`, `src/artwork/__tests__`)                                            |
| Text over pictures | Only on `MediaScrim`: a gradient from `scrimStart` into `scrimEnd`, words on `scrimEnd` (4.5:1 over any pixel by calculation); below the picture from font scale 1.3                                 | **Verified** (`MediaCard.test.tsx`, `HomeSurfaces.test.tsx`); look on devices **not verified**               |
| Motion             | Durations 0/120/220/320 ms, press scale 0.97, springs; everything through `useMotion()`, nothing moves with reduced motion (screen transitions included)                                             | **Verified** in Jest; feel on devices **not verified**                                                       |
| Sheets             | `@gorhom/bottom-sheet` behind `Sheet` on devices, `Modal` in tests and on the web; focus to the title on open and back to the trigger on close                                                       | **Verified** in Jest (`Sheet.test.tsx`, Calendar's answer sheet); gestures **not verified**                  |
| Haptics            | Selection, impact, success and warning through an injected service; never the only feedback                                                                                                          | **Verified** (recorder in tests); feel **not verified**                                                      |
| Glass              | ADR-001: liquid on iOS 26, blur on earlier iOS, solid on Android, the web and with reduce transparency; chrome only, never over images                                                               | **Verified** (rule tests); look **not verified**; glass on Android **Pending decision** (README)             |
| Copy guard         | A TypeScript-AST test over every screen's customer text: no internal word, no `SCR-`/`SPK-`/`DEC-`/`POL-`/`PA-`/`§`; its list of exceptions is empty                                                 | **Verified** (`src/copy/__tests__/customer-words.test.ts`)                                                   |
| Run-time codes     | Text the API builds for staff (eligibility reasons, policy defaults) is shown in customer words by code; its own words stay in "Details for support"                                                 | **Verified** (`eligibility-words.test.ts`, `policy-words.test.ts`, `codesOutsideSupport` on Review)          |
| Facility time      | A time on the facility's clock with its zone named: the record's zone, else the zone the app already holds from a cached answer, else the device's; never a fixed UTC                                | **Verified** (`known-zone.test.tsx`)                                                                         |
| One offline notice | The screen's banner says "You are offline"; a section inside it says only its own age and needs on one quiet line                                                                                    | **Verified** (`StateView.test.tsx` and the screen tests)                                                     |
| Large text         | No line limits on critical text; Home, Explore, Pay and the Pass tested at 200%                                                                                                                      | **Verified** in Jest (`mockFontScale(2)`, `truncatedTexts`); on devices **not verified**                     |

## 3. Decisions taken in the finish pass (2026-11-16)

Each is **Verified** by the tests named in the commit that made it; each is also a **Proposed**
design choice the owner may change.

- **Pass reference.** Groups of four in a monospaced face (Menlo / the platform monospace) so l, I
  and 1 and O and 0 look different, digits in the floodlight colour, words on solid plates of the
  card's colour so the pitch lines never cross them. The stored value is unchanged; screen readers
  hear it character by character.
- **Policy terms on Review.** One plain sentence per kind of standard term ("If the facility
  cancels, you get your money back."); the API's text with POL- and DEC- codes in the fold.
- **Eligibility on Who.** One sentence per reason code ("Ages 5 to 12. Dev is 31."), a sentence per
  severity for codes not listed, no staff-override alternative; the API's words in the fold.
- **Pay step.** No repeated heading, "Place held until …" once, the pay-at-desk message under the
  amount (first screen at 375×667), no disabled "Pay" button when paying in the app is not
  available (DEC-019).
- **Headings.** The screen's title is not repeated as its first heading.
- **Empty states.** Illustrated everywhere with a fitting picture; `success` is for outcomes only;
  one empty state per page.
- **Explore with no results.** The answer comes right under the search, above the filters.
- **Calendar rows.** The start drawn large on the left; the line under the title says the end; the
  row's spoken name keeps the whole range.

## 4. Open items

| Item                                                                                                                                                                                     | Status                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Native acceptance: VoiceOver and TalkBack order and focus, Dynamic Type and Android font scale, glass, haptics, sheet gestures, native date and time pickers, image memory on long lists | **Not verified**; needs signed builds on devices (§6.2, `native-acceptance-matrix.md`)       |
| The tab labels Explore, Calendar and You, the vocabulary list, codes in the support fold                                                                                                 | **Pending decision** DEC-107 (PA-11; product owner)                                          |
| Paying in the app (the pay-at-desk message stands in)                                                                                                                                    | **Pending decision** DEC-019 (technical lead/account owners)                                 |
| The scannable pass symbol                                                                                                                                                                | **Pending decision** DEC-023                                                                 |
| Records with no facility of their own (amount due, receipts, the pass) carry no zone; with no other answer cached the device's zone is named                                             | **Proposed** API change: state the facility zone on money and pass records                   |
| Paged lists inside card sections (payments, receipts, registrations, waitlists, bookings, class packs, memberships, invitations) render pages in the scroll view                         | **Proposed** follow-up: move them to `Screen` list or sections mode (FlatList / SectionList) |
| Glass on Android                                                                                                                                                                         | **Pending decision** (README, "Glass")                                                       |
