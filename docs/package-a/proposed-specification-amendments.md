# Proposed specification amendments (legacy parity)

Status of this document: every requirement text below is **Proposed**. None is part of the master specification until the product owner accepts it (DEC-024 governs changes to the baseline), and no behaviour that relies on one ships before then. Statements about what the code does today are **Verified** by the test or inspection named beside them (2026-11-13). Every value a requirement leaves open is **Pending decision** and names the questionnaire rows (`operator-questionnaire.md`) and the decision record (`decision-register.md` section 12) that settle it.

## 1. Why these exist

The facility's current system was reviewed read-only. Ten things the facility depends on are absent from the master specification or only implied by it. Seven are ordinary features of the current system (PA-01 to PA-07). Three exist today only as workarounds, where staff bend a feature to a purpose it was not built for (PA-08 to PA-10); for those the amendment specifies the purpose, not the workaround.

"Observed" below means seen in the facility's current system during that review and recorded in the third column of the questionnaire. It is evidence of how the facility works today, not of what it wants; the facility confirms or corrects it by answering.

## 2. How to accept one

**Proposed** procedure, consistent with `decision-register.md` rule 10.1:

1. The product owner accepts, edits or rejects each amendment separately and the outcome is written on its decision record.
2. An accepted amendment is added to the master specification under the section and identifier given here, in the same pull request that updates `requirement-cross-reference.md`.
3. The identifiers below are reserved by this document and are not reused if an amendment is rejected.

## 3. Summary

| Id    | Proposed requirement | Section | Need                                        | Today (**Verified**)                                                   | Questionnaire rows | Decision |
| ----- | -------------------- | ------- | ------------------------------------------- | ---------------------------------------------------------------------- | ------------------ | -------- |
| PA-01 | SPK-REG-011          | §3.3    | Liability waiver                            | Versioned forms and acknowledgements; no waiver, no paper date         | J1 to J5           | DEC-095  |
| PA-02 | SPK-PAY-013          | §3.15   | Class price by sessions remaining           | Full term price always (`facility-class.spec.ts`)                      | G2                 | DEC-096  |
| PA-03 | SPK-PAY-014          | §3.15   | Camp price tiers and add-ons                | Absent                                                                 | G3                 | DEC-097  |
| PA-04 | SPK-PAY-015          | §3.15   | Member and non-member price on one offering | Absent                                                                 | G3, G8             | DEC-098  |
| PA-05 | SPK-COMMS-009        | §3.18   | Season email templates and sequences        | Staff-composed messages only; no template, no sequence                 | K1 to K3           | DEC-099  |
| PA-06 | SPK-SCHED-010        | §3.7    | Lobby and public schedule views             | Absent; standings refuse anonymous readers (`facility-league.spec.ts`) | N1 to N4, F14      | DEC-100  |
| PA-07 | SPK-REG-012          | §3.3    | Uniform purchase during registration        | Jersey numbers on rosters only                                         | H5, H6             | DEC-101  |
| PA-08 | SPK-PAY-016          | §3.16   | Open-amount register line                   | Refused (`facility-register.spec.ts`)                                  | H2, H9, G12        | DEC-102  |
| PA-09 | SPK-COND-005         | §3.16   | Rental-group rosters with waivers           | Absent                                                                 | D18, J1, I2        | DEC-103  |
| PA-10 | SPK-COMP-006         | §3.4    | Team waiting list                           | Absent; a full division refuses the team (`facility-league.spec.ts`)   | D10                | DEC-104  |

## 4. Amendments

### PA-01. Liability waiver

**SPK-REG-011** (**Proposed**)

A liability waiver is a versioned document that a person, or a guardian on a child's behalf, accepts before participating. The system must:

- Record each acceptance with the person covered, the person who accepted, the waiver version, the time, and whether it was accepted digitally or recorded from paper.
- Record a paper acceptance only as a staff entry that names the staff member and the date on the paper; it must never appear as a digital signature by the customer (SPK-REG-009: staff must not falsely sign a guardian acknowledgment).
- Evaluate, for any activity that requires a waiver, whether the participant holds an acceptance that is current under the approved renewal rule.
- Show a missing or lapsed waiver wherever the participant is registered, rostered, checked in or added to a rental group, and block or warn according to the approved rule, with a recorded override where one is permitted.
- Keep earlier versions and acceptances when the wording changes.

Observed: one waiver at version 4; signed once and not asked again when the wording changes; an alert at check-in but nothing blocked; customer records can carry a paper-waiver date.

Open values (**Pending decision**, DEC-095): who must sign (J1); how often and whether a new version requires re-acceptance (J2); block or warn, and who may override (J3); whether paper is still collected (J4); other forms (J5).

Today (**Verified** by inspection): the catalog has policy kind `form` with versions and the enrolment flow records acknowledgements against a version. Nothing distinguishes a waiver from any other form, nothing records a paper acceptance, and nothing evaluates currency outside a registration.

### PA-02. Class price by sessions remaining

**SPK-PAY-013** (**Proposed**)

An offering may be priced per session. For such an offering the price of joining is the per-session price multiplied by the number of sessions the participant can still attend, counted at the time of the quote from the offering's scheduled sessions. The quote must show the per-session price, the count and the product, and must remain reproducible later from stored facts (SPK-PAY-002). A cancelled session and a session added after purchase are handled by the approved refund and credit policy, not by silently changing a paid price.

Observed: a class listing shows "24.00 per class × 10 classes = 240".

Open values (**Pending decision**, DEC-096): which programs use the rule (G2); the cut-off after which a session no longer counts (start of the session, or earlier); whether a minimum charge applies.

Today (**Verified**, `facility-class.spec.ts`): a child joining after three of ten sessions is quoted the full term price.

### PA-03. Camp price tiers and add-ons

**SPK-PAY-014** (**Proposed**)

An offering may define:

- Price tiers selected by stored facts about the purchase: the date of purchase against a deadline, and the number of days or sessions chosen. Exactly one tier applies to a line and the quote names it.
- Optional add-ons (for example early drop-off, late pick-up) that are priced separately, selected per participant and per day, limited by their own capacity where they have one, and shown as their own lines on the quote, the receipt and the attendance list for the day.

An add-on is refunded, transferred and reported with the registration it belongs to.

Observed: a camp description lists a three-day price and early care and after-care at a daily price, all as prose; a day rate at the register.

Open values (**Pending decision**, DEC-097): the tiers, deadlines and prices (G1, G3); which add-ons exist and their capacity.

Today (**Verified** by inspection): no tier and no add-on exists in the catalog, the enrolment module or the contracts.

### PA-04. Member and non-member price on one offering

**SPK-PAY-015** (**Proposed**)

An offering may carry a price that applies only to a participant who holds a named membership entitlement that is active on the reference date. The quote must state which price applied and why. A membership that lapses, is suspended or is refunded after purchase does not change a price already paid unless the approved policy says so (SPK-COND-001 continues to apply: a membership grants only what its entitlement states).

Observed: a camp description lists a member price and a non-member price; one annual membership exists with renewal processing switched on.

Open values (**Pending decision**, DEC-098): what the membership costs and grants (G8); which offerings carry a member price (G3); the reference date (purchase, or first session); whether the member price follows the child or the paying adult.

Today (**Verified** by inspection): memberships exist as entitlements; no price rule reads one.

### PA-05. Season email templates and sequences

**SPK-COMMS-009** (**Proposed**)

Staff may keep reusable message templates and arrange them into a sequence attached to a kind of season or program. When a season is created from that kind, the sequence produces a dated schedule of messages relative to the season's own dates (for example registration opening, the week before the first session, each week of play). For each scheduled message staff must be able to preview the text with the season's real details filled in, preview the recipients (SPK-COMMS-006), edit or skip it, and see afterwards what was sent to whom. A sequence never sends to people the season's audience rules exclude, and it honours the separation of operational and promotional messages (SPK-COMMS-007).

Observed: 182 templates named by season and week; managers hold the template and broadcast permissions; game and membership reminders two days ahead.

Open values (**Pending decision**, DEC-099): the set of messages per program (K1); who sends and on which days (K2); which reminders are automatic (K3).

Today (**Verified** by inspection): staff compose a message, preview its recipients and send it, and the system sends its own schedule, competition and reminder notices. The communications module stores no reusable template and has no sequence.

### PA-06. Lobby and public schedule views

**SPK-SCHED-010** (**Proposed**)

The system must offer read-only views that need no sign-in:

- A facility schedule for a day, by field and time.
- For a competition the operator has made public: fixtures, results, standings and, in a tournament, the bracket.
- A lobby display of the same information that advances by itself, shows the time it was last updated, and keeps showing the last schedule it received while its connection is down.

A public view must show only what the approved publication policy allows. In every case a private booking appears as occupied time without the renter's name, and no child's name, photograph or contact detail appears. A public view exposes no identifier that can be used to read a private record.

Observed: public league pages and a daily game schedule are switched on; a rolling lobby schedule (time, title, field, type) is in use; renter names are visible to anyone on the public calendar today.

Open values (**Pending decision**, DEC-100): what is public and whether youth competitions differ (N2, N3); the wording shown for private bookings (N1); the number of screens and what they show (N4); live tournament views (F14).

Today (**Verified**, `facility-league.spec.ts` and inspection): standings answer 401 without sign-in. The routes that work without sign-in are the published offering list with each offering's sessions (child-safe fields, §4.14), private calendar feeds addressed by a revocable token (SPK-COMMS-008), provider callbacks and service health. None shows a facility schedule by field, a fixture, a result or a standing.

### PA-07. Uniform purchase during registration

**SPK-REG-012** (**Proposed**)

An offering may require or offer a uniform. During registration the customer chooses what the offering asks for (size, and a number where the competition uses them), the uniform is a line on the same quote and receipt, and staff can see for each team or class what has been ordered, what is paid and what has been handed over. A returning participant who already holds the current uniform is not charged again where the approved rule says so. Whether stock is counted is a configuration of the product, not an assumption.

Observed: kits are ordered through an outside shop by an emailed link; a customer tag records "jersey yes/no"; teams exist whose only purpose is to carry a jersey price.

Open values (**Pending decision**, DEC-101): whether the shop is a separate business and whether ordering should move into registration at all (H6); whether stock is counted (H5); prices and the returning-player rule (G1).

Today (**Verified** by inspection): a roster member has a jersey number and a rule set can restrict the numbers allowed (SPK-COMP-005). No uniform product, size, order or hand-over record exists.

### PA-08. Open-amount register line

**SPK-PAY-016** (**Proposed**)

A permitted staff member may add to a register sale a line whose amount they enter, with a required category from an approved list and a required description. The category determines the accounting mapping and tax treatment; the amount is positive and limited by an approved ceiling per role, above which a second approval is recorded. The line appears on the receipt and in reports under its category, and is returned through the same return workflow as any other line. A discount or refund is never entered as a negative line (SPK-PAY-003, SPK-PAY-008 govern those).

Observed: five 1.00 items rung by quantity for special rentals, deposits and coach tips; discounts and vouchers rung as negative-priced items.

Open values (**Pending decision**, DEC-102): who may use it and the ceiling (H2); the categories, including tips and deposits (H9, G12).

Today (**Verified**, `facility-register.spec.ts`): a sale line is a product and a quantity; a line with an amount is refused, and a product cannot have a negative price.

### PA-09. Rental-group rosters with waivers

**SPK-COND-005** (**Proposed**)

A rental booking, or a standing series of them, may have a group roster: the people the renter brings. The renter, or staff, can invite people to the roster; each person accepts the waiver (SPK-REG-011) for themselves or their child; and staff can see before and during the booking who is on the roster and whose waiver is missing. Being on a rental roster grants nothing else: it is not a team entry, not a registration, and does not appear in competition records or league reports.

Observed: a league named as a rental waiver list holds rental groups as teams so that their players can sign the waiver; club practices appear as rental events.

Open values (**Pending decision**, DEC-103): whether rental players must sign at all (J1, D18); whether a missing waiver blocks the booking or is only shown; how regular renters are billed (I2).

Today (**Verified** by inspection): a booking has a booker and a guest count. It has no list of people.

### PA-10. Team waiting list

**SPK-COMP-006** (**Proposed**)

When a division or season has no free place, a team entry may wait. A waiting entry keeps its order, holds no place and owes nothing. When a place opens, staff offer it to the waiting entry they choose, with the list order shown; the offer has an expiry, and accepting it moves the entry into the ordinary approval and payment path (SPK-COMP-004). A captain can see that the team is waiting and can withdraw. Waiting entries are excluded from schedules, standings and season counts.

Observed: a season named for open play "plus waiting list teams" is created each quarter to hold teams that want a league place.

Open values (**Pending decision**, DEC-104): whether this is in fact how waiting teams are tracked (D10); whether offers follow strict order; how long an offer stands; whether waiting carries over to the next season.

Today (**Verified**, `facility-league.spec.ts`): approving a team into a full division is refused with the capacity and the number occupied; the entry stays "applied" with no order and no offer. Individual waiting lists with timed offers exist for registrations (SPK-REG-008) and are not reused for teams.

## 5. Found in the same review, not drafted

Two further needs have no requirement and no amendment here, because their shape depends on the payment provider and on answers the facility has not given. They are recorded so they are not lost (**Pending decision**).

| Need                         | Observed                          | Questionnaire rows | Decision |
| ---------------------------- | --------------------------------- | ------------------ | -------- |
| A surcharge on card payments | A 3% surcharge is switched on     | G9                 | DEC-105  |
| Gift cards                   | Switched on; no evidence of sales | G14                | DEC-106  |
