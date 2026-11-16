# Customer app artwork

The bundled images of the customer app (ADR-008, "Imagery"; **Proposed**). They ship inside the
app as compressed webp so every screen that uses them works offline (§4.15). Code reaches them only
through `src/artwork/manifest.ts` (static `require` maps that Metro bundles) and
`src/artwork/artworkFor.ts` (which activity image an offering or item shows, and which Home band an
hour shows). They are drawn through the shared `Artwork` component, which hides them from screen
readers: an image is decoration, and its meaning is always in the text beside it (SPK-UX-009).

## Provenance and licence

All images are generated artwork made for this product and licensed for use in it. They show no
real people (no customer, member of staff or other person is depicted) and contain no identifiable
faces, logos, text or brands.

## Art direction

- **Activity photographs, onboarding and Home band:** photographic, at a Las Vegas outdoor sports
  park at dusk or night under floodlights, with pitch green and lime accents. People are seen from
  behind, cropped or out of focus. The subject is centred so the 1:1 crop works.
- **Illustrations:** soft clay-style 3D on a transparent background, readable on both the light and
  the dark (Legends) page.
- Text over an image sits only on the scrim token (ADR-008); no image carries text of its own.

## Files, sizes and budgets

KB means 1,024 bytes. The whole folder must stay within **5 MB** (about 4.0 MB at the time of
writing).

| Group                     | File                               | Size (px) | Budget each |
| ------------------------- | ---------------------------------- | --------- | ----------- |
| Activity, wide (16:9)     | `<activity>-wide.webp`             | 1280×720  | 160 KB      |
| Activity, square (1:1)    | `<activity>-square.webp`           | 640×640   | 45 KB       |
| Illustration (4:3, alpha) | `<name>.webp`                      | 800×600   | 90 KB       |
| Onboarding (3:4)          | `onboarding-<page>.webp`           | 1080×1440 | 200 KB      |
| Home band (21:9)          | `home-day.webp`, `home-night.webp` | 1470×630  | 120 KB      |

### Activities

Each has a wide and a square crop. `artworkFor` chooses among them by offering kind, then format,
activity type or name (futsal or indoor, basketball), then age band (8 or under, 17 or under), then
sport, with `park` last (see the comment in `src/artwork/artworkFor.ts`).

| Key             | Subject                                |
| --------------- | -------------------------------------- |
| `soccer-league` | An adult league game                   |
| `soccer-youth`  | A youth game                           |
| `kids-class`    | Young children at a skills class       |
| `futsal-indoor` | An indoor court                        |
| `basketball`    | An outdoor basketball court            |
| `camp`          | A summer camp group                    |
| `party`         | A birthday party at the park           |
| `rental-field`  | An empty, lit field                    |
| `pickup`        | A casual pickup game                   |
| `coaching`      | A coach with a player                  |
| `membership`    | Park life                              |
| `trial`         | A tryout                               |
| `team`          | A team huddle                          |
| `park`          | A wide view of the park (the fallback) |

### Illustrations

`empty-home`, `empty-calendar`, `empty-teams`, `empty-cart`, `empty-inbox`, `empty-search`,
`empty-family`, `empty-payments` (the empty state of each screen), `offline` (no connection) and
`success` (a completed action).

### Onboarding and Home

`onboarding-welcome`, `onboarding-family` and `onboarding-pass` illustrate the three onboarding
pages. `home-day` and `home-night` are the band at the top of Home: day from 06:00 to 17:59 in the
facility's time zone, night otherwise (`homeBandFor`). The destination names Home, Explore,
Calendar and Teams follow PA-11, which is **Pending decision** (DEC-107).

## Replacing an image

1. Keep the file name: the manifest requires each file by its literal name.
2. Keep the pixel size of its group (table above) and the art direction, including no faces,
   logos, text or brands. Illustrations keep their transparent background.
3. Export as webp and compress until the file is within its budget.
4. Run `pnpm exec jest src/artwork` from `apps/mobile`. The test
   (`src/artwork/__tests__/artwork-manifest.test.ts`) checks that every file the manifest requires
   exists, starts with the RIFF/WEBP signature, has the size of its group, has an alpha channel if
   it is an illustration, fits its budget, and that the folder holds no other image and stays
   within 5 MB.

Adding an image means adding its key to `src/artwork/manifest.ts` and its row to the test's
expectations and to this file.

## Verification status

- **Verified:** the files, sizes and budgets above, by the Jest test; Metro resolves the manifest's
  static requires and copies all 43 images when it bundles the manifest for iOS. An app export
  carries an image only once a screen imports it.
- **Not verified here:** how the images look on device screens of each size and in each theme;
  that waits for native acceptance with signed builds (§6.2).
