# Status

## Feature: `customer-redesign` (customer app visual system v2)

Branch: `claude/jolly-johnson-gd61vv`. Part 1 merged as pull request 26; part 2 (journeys, copy
guard, finish) is on the branch. Decision records: ADR-008 and PA-11 (DEC-107), both **Proposed**.

| Phase                        | State    | Notes                                                                |
| ---------------------------- | -------- | -------------------------------------------------------------------- |
| Part 1: tokens, library, art | Complete | Merged (PR 26)                                                       |
| 6a Copy guard                | Complete | `src/copy`; the exceptions list is empty                             |
| 5A/5B Journeys J1 to J7      | Complete | Every customer screen on `src/ui`; no kit left                       |
| 3.3 + 6b Clean-up            | Complete | One `CommandError`, plain pending words, old button variants removed |
| 7a Finish                    | Complete | Screenshot review fixes, motion, images, focus, 200% text, docs      |
| 7b Screenshots to the owner  | Next     | Full run, both themes and sizes, before/after sheet                  |

Finish pass (7a), 2026-11-16: the fifteen problems of the screenshot review fixed (see
`decisions/sde/customer-redesign.md`); 177 suites, 2,150 tests; both exports pass the release
bundle check. Design doc: `docs/package-a/customer-visual-system.md`.

Blockers: none in the code. Owner decisions and device checks: DEC-107 (labels and wording),
DEC-019 (paying in the app), DEC-023 (pass symbol); every customer screen on phones (VoiceOver,
TalkBack, large text, glass, haptics, sheets, pickers). Nothing was run on a device.

---

## Feature: `glass-demo-amendments`

Feature: `glass-demo-amendments` · Branch: `claude/jolly-johnson-gd61vv` · Pull request: 21

| Phase            | State    | Notes                                                       |
| ---------------- | -------- | ----------------------------------------------------------- |
| 0 Brainstorming  | Complete | Design approved by the owner 2026-11-14; spec in `specs/`   |
| 1 Strategy       | Complete | `decisions/cto`, `decisions/product-manager`                |
| 2 Design         | Complete | ADR-001 to ADR-007; `decisions/architect`, `staff-engineer` |
| 3 Planning       | Complete | `decisions/engineering-manager`, `senior-engineer`          |
| 4 Implementation | Complete | Six tracks, demo dataset and tours merged                   |
| 5 Verification   | Complete | QA and security reviews; findings fixed or recorded         |
| 6 Delivery       | Complete | Deploy, rollback, operations notes; PR 21 updated           |

## Tasks

| Wave | Track | What                                        | State  |
| ---- | ----- | ------------------------------------------- | ------ |
| 0    | —     | Merge `main`; capabilities; shell conflicts | Done   |
| 1    | A     | PA-02 per-session price, PA-04 member price | Merged |
| 1    | B     | PA-01 waivers, PA-09 rental rosters         | Merged |
| 1    | C     | PA-10 team waiting list, PA-06 public views | Merged |
| 1    | H     | Glass-forward staff interface               | Done   |
| 2    | D     | PA-03 tiers and add-ons, PA-07 uniforms     | Merged |
| 2    | E     | PA-05 message templates and sequences       | Merged |
| 2    | F     | PA-08 open-amount register line             | Merged |
| 2    | H     | Mobile glass (not device-tested)            | Done   |
| 3    | G     | Demo mode, dataset, tours                   | Merged |
| 4    | —     | Verification and delivery                   | Done   |

## Blockers

None in the code. Before release, decisions and checks only the owner can make:

- Try the customer app on phones (iOS 26, an earlier iPhone, Android): glass, the floating tab
  bar, and every new customer screen. Nothing was run on a device.
- Set `TRUST_PROXY` on the API and the worker before any deployment (production refuses to start
  without it).
- The ten features are **Proposed** amendments: each stays off until its decision record
  (DEC-095 to DEC-104) is made and a system administrator turns it on.
