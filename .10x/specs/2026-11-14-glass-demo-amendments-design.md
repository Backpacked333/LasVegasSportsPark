# Glass-forward redesign, demo mode and the ten parity amendments

Feature slug: `glass-demo-amendments`. Approved by the product owner in conversation on 2026-11-14
(scope, sequencing as one pull request, the glass-forward look, real glass on mobile, and the
assumed rules below). Status words follow the repository's §6.7: **Verified**, **Proposed**,
**Pending decision**.

## 1. Goal

One pull request, built on `main` at 51253046 (which contains pull requests 22, 23 and 24), that:

1. carries the redesign of pull request 21 onto current `main` and takes it further
   ("glass-forward");
2. adds demo mode with a sample dataset;
3. implements the ten proposed amendments of `docs/package-a/proposed-specification-amendments.md`
   (PA-01 to PA-10), each behind its own capability switch.

## 2. Decisions taken with the product owner

| Question                    | Answer                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| What is "new functionality" | Demo mode and the ten amendments of pull request 23                             |
| Sequencing                  | Everything in one pull request (the existing draft, number 21)                  |
| How far the glass goes      | Glass-forward: chrome and headline pieces are glass; lists, tables, forms solid |
| Mobile                      | Real glass, with two native packages; not device-tested here                    |
| Facility rules not answered | Use what the review observed; label **Proposed**; off by default, on in demo    |

## 3. The look

Staff dashboard (web):

- A backdrop behind the whole application: soft fields of colour with faint field markings,
  scrolling with the page. Classic: warm white with green and sky tints. Legends: neutral black
  with gold light.
- Glass (liquid glass bodies, `apps/staff/src/ui/glass`): sidebar, header groups, quick
  navigation, sign-in card, phone tab bar, and now page toolbars, stat tiles, hero cards, sheets
  and toasts.
- Solid: anything a person reads at length or types into (lists, tables, forms, long text).
- The rules of pull request 21 stay: content inside glass is flat and at full contrast; no glass
  inside glass; reduced transparency, contrast and motion honoured; every label on glass at 4.5:1
  with fills at default, halved and doubled.

Customer app (mobile): the same palette and type, with glass on the tab bar, headers, hero cards
and sheets through `expo-glass-effect` (iOS 26) and `expo-blur` (elsewhere), and an opaque
fallback where neither is available or the device asks for reduced transparency. **Not verified**
on a device in this work: the product owner tries it on a phone before release.

## 4. Demo mode

- Ported from the unmerged branch `claude/arc-ui-connector-redesign-ys6w22` (one commit): a
  build-time `__DEMO__` flag for the staff dashboard, a role picker in place of sign-in, a banner,
  a tour panel; the customer app's demo sign-in and tour; `pnpm demo`.
- New: a demo dataset created through the modules' own services (never by writing their tables):
  spaces, programs with offerings, sessions and prices, a league with divisions, teams, fixtures,
  results and standings, a full division with a waiting team, bookings with a roster, register
  products and categories, a waiver, message templates and a sequence, a public competition.
- Demo code never ships in a real build: the release-bundle checks fail on demo markers.

## 5. The ten amendments

Each is **Proposed** until its decision record is answered. Each has a capability switch,
enforced on commands, off unless an organization turns it on. The demo database turns all on.

| Id    | Requirement   | Capability            | Decision | Owning modules               |
| ----- | ------------- | --------------------- | -------- | ---------------------------- |
| PA-01 | SPK-REG-011   | `liability_waivers`   | DEC-095  | catalog, enrollment, entry   |
| PA-02 | SPK-PAY-013   | `per_session_pricing` | DEC-096  | catalog, finance             |
| PA-03 | SPK-PAY-014   | `price_tiers_addons`  | DEC-097  | catalog, enrollment, finance |
| PA-04 | SPK-PAY-015   | `member_pricing`      | DEC-098  | catalog, enrollment, finance |
| PA-05 | SPK-COMMS-009 | `message_sequences`   | DEC-099  | communications               |
| PA-06 | SPK-SCHED-010 | `public_schedule`     | DEC-100  | scheduling, competition      |
| PA-07 | SPK-REG-012   | `uniforms`            | DEC-101  | catalog, enrollment, finance |
| PA-08 | SPK-PAY-016   | `open_amount_lines`   | DEC-102  | finance (point of sale)      |
| PA-09 | SPK-COND-005  | `rental_rosters`      | DEC-103  | enrollment (bookings)        |
| PA-10 | SPK-COMP-006  | `team_waitlist`       | DEC-104  | competition                  |

Assumed rules (**Proposed**; each is a value an organization can change where the design makes it
configuration):

- PA-01: a waiver warns and does not block; a new version does not require re-acceptance; no
  periodic renewal; paper acceptance is a staff entry with the date on the paper.
- PA-02: a session counts until it starts; no minimum charge.
- PA-03: tiers and add-ons are set per offering by staff; exactly one tier applies.
- PA-04: membership is checked at the time of the quote and follows the participant.
- PA-05: a sequence produces a schedule; nothing sends without a staff confirmation.
- PA-06: private bookings show as "Reserved"; a competition is private until staff make it
  public; a competition with an under-18 division cannot be made public.
- PA-07: no stock counting; a returning participant who holds the current uniform is not charged
  when the offering says so.
- PA-08: a per-role ceiling from the approved finance policy; above it a second person approves.
- PA-09: a missing waiver is shown and does not block the booking.
- PA-10: staff choose which waiting team gets a freed place; an offer stands for 48 hours.

The technical contract of each amendment (tables, commands, reads, screens, tests) is in
`.10x/decisions/architect/glass-demo-amendments.md`.

## 6. Delivery

- Branch `claude/jolly-johnson-gd61vv`, pull request 21. `main` is merged into it first.
- Work runs in waves of parallel tracks, one per group of owning modules, each in its own git
  worktree, integrated between waves (`.10x/decisions/engineering-manager/`).
- Every requirement gets a test named after it; every integrity rule gets a test that proves the
  database refuses the violation; the three journey tests that record today's gaps
  (`facility-class`, `facility-register`, `facility-league`) gain the new behaviour with the
  capability on and keep today's behaviour with it off.
- Every screen is looked at in a browser in both themes with the demo data.

## 7. Out of scope

- The two needs recorded but not drafted (card surcharge DEC-105, gift cards DEC-106).
- Answering the decision records: this work proposes defaults; the facility decides.
- Device acceptance of the customer app (§6.2) and staff acceptance at the facility (§6.3).
- Vendor selection of any provider (§5.2): every provider stays a port with a fake adapter.
