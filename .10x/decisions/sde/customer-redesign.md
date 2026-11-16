# Implementation: customer-redesign, finish pass (7a), 2026-11-16

Screenshot review fixes, most severe first (commits on `claude/jolly-johnson-gd61vv`):

1. Review's policy defaults in customer words, codes in the fold (`policy-words.ts`); render check
   `codesOutsideSupport`.
2. Who step eligibility by reason code (`eligibility-words.ts`), staff override dropped, API words
   in the fold; a sentence per severity for unknown codes.
3. Avatar initials ignore brackets and punctuation ("You (Dev)" → "D").
4. Pass reference: groups of four, monospaced face, digits in floodlight, solid plates under words.
5. Times on the facility clock (`useKnownFacilityZone`; Pay and Review read their activities).
6. Tab labels: 15 pt line, 60 pt row.
7. Legends Home: night band always.
8. `MediaScrim` gradient shared by MediaCard and Home's band.
9. Pay step: no repeated heading, hold time once, pay-at-desk under the amount, no disabled Pay.
10. Forms step shows "Step 3 of 5" without forms too.
11. Double titles removed (Rentals and parties, Memberships, Class packs, Your share, Account
    setup, Required forms).
12. One offline notice (`OfflineBannerContext`, quiet line in `StateView`).
13. Illustrated, fitting empty states; one for Invitations.
14. Explore: no-results answer under the search.
15. Switch thumb, first-row divider, team standing row, "You're registered", Calendar "Until …",
    AvatarStack overlap, gallery scrim sample, amount-due repeats.

Part B: stack transitions follow reduced motion; `Artwork` memory cache, downscaling and
`recyclingKey`; Calendar's answer sheet returns focus; 200% text tests. Not done (**Proposed**):
moving the paged lists inside card sections to `Screen` list mode.
