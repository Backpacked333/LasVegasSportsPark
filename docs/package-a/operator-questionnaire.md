# Operator questionnaire: what the pilot needs from the complex

Status legend: **Verified** = implemented and tested in this repository today (file cited); **Proposed** = an engineering suggestion awaiting the named owner; **Pending decision** = needs the owner's answer (owner role from spec §6.6). "No answer yet" never becomes "not applicable" (§6.6).

Prepared 2026-11-09. This is the operator questionnaire that spec §6.7 names as "the mechanism for collecting business evidence". It does not replace the specification or the [decision register](decision-register.md); it asks, in plain language, only the questions the Package F pilot needs (one adult league and one youth program, **Proposed** in §6.5, to be confirmed as DEC-046). The register holds 94 records; this document asks about the subset of them that the pilot cannot start without, plus the outside accounts that take the longest to obtain. Nothing here is an operator fact, and every answer column is empty.

## How to use this document

1. Start section 1 today. Those items depend on other organizations and take weeks.
2. Answer sections 2 to 7 in any order. Each row has one question. Where a starting suggestion exists you can write "agreed" or correct it; where it says "none", only the complex can answer.
3. Write the answer, who decided and the date it takes effect. An engineer copies each answer onto its record in the decision register and enters it in the product (the last column says where). No answer needs a code change unless the row says so.

Starting suggestions come from three places, named in each row: the specification's own proposal (**Proposed**), a value that already exists in code as an engineering placeholder (**Verified** as code, not as policy; decision register section 3, item 9), or nothing. Prices, taxes, refund amounts, retention periods and legal wording have no suggestion, because §1.4 and §4.14 say engineering must not invent them.

## 1. Start now: accounts and documents that take weeks

Spec §5.12 requires that the complex controls each production account (DEC-069, **Proposed**: the complex holds every account and engineers get delegated access).

| #   | What is needed                                                                                                            | Why it takes time                                                              | Blocks                                               | Record           | Answer |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------- | ------ |
| 1.1 | The legal entity that takes payments: registered name, tax identifier, bank account, and the person responsible for it    | A card processor reviews the business before it pays out                       | Every paid registration (Package D gate)             | DEC-019, DEC-069 | [ ]    |
| 1.2 | App store publisher accounts in the complex's name, for iOS and for Android                                               | Organization enrolment includes identity and business checks                   | Any build a customer can install (§6.2)              | DEC-069, DEC-061 | [ ]    |
| 1.3 | A domain or subdomain the complex controls, with someone who can change its records                                       | Needed for the staff site, the service address and links that open the app     | Verified links (§4.13), email sending                | DEC-069, DEC-021 | [ ]    |
| 1.4 | A text-message sender registration, with the consent wording customers agree to                                           | Carriers review business text senders before delivery                          | Text notices only; email and push do not wait for it | DEC-020, DEC-062 | [ ]    |
| 1.5 | Waiver, liability, privacy and terms wording, reviewed by the complex's adviser                                           | The product stores children's information and takes payments (§4.14)           | Registration forms and both store listings           | DEC-012, DEC-060 | [ ]    |
| 1.6 | Access to exports from the system in use today (the specification names DaySmart as the system being replaced, §1.2)      | Export formats and permissions must be confirmed with that system's own vendor | Import rehearsal and cutover (Package F)             | DEC-014          | [ ]    |
| 1.7 | The name, logo files, colours and photographs the customer app and receipts should carry (no app icon exists in the repo) | Store listings need final artwork                                              | Store submission                                     | DEC-061          | [ ]    |

## 2. People and scope

| #   | Question                                                                                    | Starting suggestion                                                                                   | Record  | Where the answer goes                                    | Answer |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------- | ------ |
| 2.1 | Who accepts each stage of the work and says "go live"? What are the budget and the dates?   | None                                                                                                  | DEC-017 | Owner of every row in the release evidence ledger        | [ ]    |
| 2.2 | Which adult league and which youth program run the pilot, and in which season?              | **Proposed** (§6.5): one complete adult-league workflow and one complete youth-program workflow       | DEC-046 | Cutover runbook; which capability switches are turned on | [ ]    |
| 2.3 | Who is the contact for operations, for leagues, for youth programs and for finance?         | None                                                                                                  | DEC-017 | Named owner on each decision record                      | [ ]    |
| 2.4 | Who answers staff and customers during the pilot, and during which hours?                   | None for coverage; the §5.9 reliability targets are planning values only                              | DEC-015 | Recovery runbook section 9; exception queues             | [ ]    |
| 2.5 | Which staff use the dashboard, in which roles? Which roles must sign in with a second step? | **Proposed** (the register): system administrator, finance operator and general manager use two steps | DEC-091 | Staff memberships; the identity service's sign-in policy | [ ]    |
| 2.6 | Which optional areas does the complex use at all, and which are in the pilot?               | All off, which is how the code starts (**Verified**: `packages/contracts/src/capabilities.ts`)        | DEC-016 | Capability switches in Administration, each one audited  | [ ]    |

Optional areas in 2.6, the fifteen switches of `packages/contracts/src/capabilities.ts`: memberships, installments, session packages, supervised pickup, rentals, parties, tournaments, point of sale, door or turnstile hardware, accounting export, pickup sessions, youth progression, the assistant, advanced fairness and retention tools.

## 3. The building

The full answer sheet is [facility-inventory.md](facility-inventory.md), which is empty today (DEC-001, owner Operations). The questions below are what it asks.

| #   | Question                                                                                           | Starting suggestion                                                                                                                         | Answer |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 3.1 | List every field, court and room: name, indoor or outdoor, surface, size                           | None                                                                                                                                        | [ ]    |
| 3.2 | Which of them divide, and into what (halves, thirds)? Can a half be booked while the other is not? | None. The product already prevents a whole field and its part from being booked together (**Verified**: SPK-SCHED-002 exclusion constraint) | [ ]    |
| 3.3 | Opening hours by day, holidays, and any standing closures                                          | None                                                                                                                                        | [ ]    |
| 3.4 | Minutes needed before and after a booking for setup and cleanup, by space                          | None                                                                                                                                        | [ ]    |
| 3.5 | Which sports and formats run in which space                                                        | Placeholder list in code: soccer, indoor soccer, futsal, basketball, other (`scheduling.policy.ts`)                                         | [ ]    |
| 3.6 | The time zone the building runs on                                                                 | None (the development seed uses UTC unless told otherwise)                                                                                  | [ ]    |

## 4. Adult leagues

Owner: league manager (DEC-002, DEC-010, DEC-065). The suggestions are the placeholders in `apps/api/src/modules/competition/competition.policy.ts`; correct every one that differs from how the complex plays.

| #   | Question                                                                    | Starting suggestion (placeholder in code)                                                          | Answer |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| 4.1 | For each format played: players on the field, smallest and largest roster   | 11-a-side 11 on the field, roster 11 to 22; boarded indoor 6, roster 6 to 16; futsal 5; 7-a-side 7 | [ ]    |
| 4.2 | Match length and number of periods, by format                               | 90, 50, 40 and 60 minutes in the same order, two periods each                                      | [ ]    |
| 4.3 | Fewest players a team may start with, and minutes of grace before a forfeit | 7, 4, 3 and 5 players; 15 minutes for 11-a-side, 10 for the others                                 | [ ]    |
| 4.4 | Points for a win, a draw and a loss; the score recorded for a forfeit       | 3, 1, 0; forfeit recorded 3 to 0 (5 to 0 in futsal)                                                | [ ]    |
| 4.5 | The order of tie-breaks in the table                                        | Points, head-to-head, goal difference, goals scored, fair play, drawing of lots                    | [ ]    |
| 4.6 | Cards: how many cautions bring a suspension, and how long; a red card       | 3 to 5 cautions by format bring one match; a red card brings one match                             | [ ]    |
| 4.7 | How long a team has to protest a result, and who rules on it                | 48 hours; ruling authority has no suggestion                                                       | [ ]    |
| 4.8 | Who may publish a result as official                                        | Officials and the league manager submit; the league manager approves; captains do not confirm      | [ ]    |
| 4.9 | Does a team pay as one (the captain), or does each player pay a share?      | None. Both models exist behind team obligations and contribution requests (DEC-008, with Finance)  | [ ]    |

## 5. Youth programs and families

Owners: program manager (DEC-003) and the operator's privacy owner (DEC-004, DEC-005).

| #   | Question                                                                                            | Starting suggestion                                                                                       | Answer |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| 5.1 | Age bands, and the date a child's age is measured on                                                | None                                                                                                      | [ ]    |
| 5.2 | Largest group size and children per coach, by program                                               | None. The product computes coaches needed from the ratio given (**Verified**: `catalog.policy.ts`)        | [ ]    |
| 5.3 | Are trial sessions offered? Are missed sessions made up, and with what limit?                       | None                                                                                                      | [ ]    |
| 5.4 | At what age does a person manage their own account?                                                 | 18 (placeholder in code: `identity.shared.ts`)                                                            | [ ]    |
| 5.5 | How does the complex confirm that an adult is a child's guardian? May a child hold an account?      | None                                                                                                      | [ ]    |
| 5.6 | How long does an invitation to another adult stay open?                                             | 72 hours for family invitations, 7 days for team invitations (placeholders in code)                       | [ ]    |
| 5.7 | Is pickup controlled (only named adults may collect a child)? What is done when the system is down? | None. Supervised pickup is an optional area and is off (DEC-075); the outage procedure is empty (DEC-005) | [ ]    |

## 6. Registration and money

Owners: program manager for 6.1 to 6.3 (DEC-006); Finance for the rest (DEC-007 to DEC-009).

| #    | Question                                                                                     | Starting suggestion                                                                              | Answer |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| 6.1  | When a program is full, in what order are waiting customers offered a place?                 | None                                                                                             | [ ]    |
| 6.2  | How long does a customer have to accept an offered place?                                    | 48 hours (placeholder in code: `enrollment.policy.ts`)                                           | [ ]    |
| 6.3  | How long is a place held while a customer pays? Which programs need staff approval first?    | 10 minutes (placeholder in code); approval has no suggestion                                     | [ ]    |
| 6.4  | The price of each league and program in the pilot, and any early or sibling discounts        | None                                                                                             | [ ]    |
| 6.5  | Which taxes and fees appear on a receipt, and on what                                        | None. Nothing is added unless Finance approves it as a policy (**Verified**: `tax_fee` policies) | [ ]    |
| 6.6  | How a fraction of a cent is rounded                                                          | Half away from zero (placeholder in code: `packages/contracts/src/money.ts`)                     | [ ]    |
| 6.7  | May a customer pay in installments? On what schedule?                                        | None; installments are an optional area and are off (DEC-073)                                    | [ ]    |
| 6.8  | When is a refund due, and how much: before the season, after it starts, for a medical reason | None                                                                                             | [ ]    |
| 6.9  | Is credit given instead of a refund? Does it expire?                                         | None                                                                                             | [ ]    |
| 6.10 | Is cash accepted at the desk? Who counts and signs for it?                                   | None. Cash tenders and register sessions exist (**Verified**: finance module)                    | [ ]    |

## 7. Communications and what is public

Owner: the operator's privacy owner (DEC-012, DEC-062).

| #   | Question                                                                                         | Starting suggestion                                                                             | Answer |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------ |
| 7.1 | May anyone see schedules, results and standings without signing in? Rosters?                     | None. Nothing is public today; §4.14 requires child information to stay out of public schedules | [ ]    |
| 7.2 | What may a captain see about teammates, and a coach about players and their families?            | None                                                                                            | [ ]    |
| 7.3 | Which notices go by push, by email and by text: schedule changes, payment reminders, promotions? | None. In-app notices for essential changes are always on (**Verified**: communications)         | [ ]    |
| 7.4 | Languages customers should be served in                                                          | None. The product is English only today; no translation mechanism exists                        | [ ]    |

## 8. Devices and people for acceptance

Spec §6.2 and §6.3 require acceptance on the actual devices by the actual people. Nothing has been tested on a device (every row of [native-acceptance-matrix.md](native-acceptance-matrix.md) is pending).

| #   | What is needed                                                                                               | Answer |
| --- | ------------------------------------------------------------------------------------------------------------ | ------ |
| 8.1 | The front-desk equipment in use: computers, tablets, scanner, receipt printer, card reader (make and model)  | [ ]    |
| 8.2 | Two or three staff members for half a day each to carry out the eleven §6.3 tasks on that equipment          | [ ]    |
| 8.3 | Two or three team captains and two or three parents willing to register, pay and check in on their own phone | [ ]    |

## 9. Not asked here

The remaining records of the decision register are not needed to start the pilot: the reliability targets (DEC-035 to DEC-044), reporting methods (DEC-085, DEC-086), tournaments, rentals, parties and the other optional areas beyond 2.6, and the engineering records (DEC-024, DEC-025, DEC-092, DEC-093). They stay **Pending decision** with their owners.
