> **Repository note.** This is the repository copy of the master specification as supplied on October 23, 2026. It is the source of truth for product and engineering requirements in this repository. The "original platform specification" it references (a `.docx` on the author's machine) is **not** in this repository; see `docs/package-a/requirement-cross-reference.md` for how legacy requirement identifiers are tracked until it is added. The text below is reproduced verbatim.

# Sportspark — Complete Product and Engineering Specification

**Version:** 2.0 — proposed master specification  
**Prepared:** October 22, 2026  
**Product:** Soccer and indoor-soccer facility operating platform  
**Initial customer:** Your own complex  
**Customer platforms:** Native iOS and Android applications  
**Operating platform:** Desktop and tablet staff dashboard  
**Business priority:** Adult leagues and youth programs equally  
**Long-term direction:** Support additional facilities and, subsequently, independent operators

---

## 1. Product contract

### 1.1 Purpose

Build the complete system through which the complex manages its customers, families, teams, programs, fields, staff, officials, money, communications, and daily operations.

The platform must connect the entire participation journey:

**Discover → register → pay → join → prepare → arrive → participate → receive results or feedback → return.**

Every customer-facing action must have a corresponding staff workflow. Every consequential staff action must produce a clear, consistent customer outcome.

The product must support both:

- An adult organizing a team, collecting contributions, managing player availability, and competing across seasons.
- A parent managing several children, programs, schedules, payments, permissions, and pickup arrangements.

The operating dashboard must make those experiences dependable through shared records, controlled scheduling, financial reconciliation, and actionable exception handling.

### 1.2 Competitive objective

The ambition is to replace DaySmart for the complex’s agreed operating scope and deliver a substantially better experience.

Success means measurable improvements in:

- Customer registration effort.
- Captain administration.
- Family coordination.
- Season scheduling.
- Match readiness.
- Field utilization.
- Staff exception resolution.
- Financial clarity.
- Repeat participation.
- Reliability during busy operating periods.

Feature availability alone does not establish superiority. The product must demonstrate better outcomes through realistic, repeatable tasks.

The comparison program must use current, verified competitor workflows. Unsupported claims about competitor limitations must not enter product requirements or marketing.

### 1.3 Source and precedence

This specification consolidates:

1. The [original platform specification](/Users/roysalman/Downloads/Sports_Complex_Platform_Specification.docx).
2. Your subsequent product decisions.
3. The soccer-specific additions developed in this conversation.
4. The documented capabilities and limitations of the current local implementation.

When they conflict, the latest explicit product decisions govern.

In particular:

- Native iOS and Android replace the original mobile-web-first direction.
- Soccer and indoor soccer become the primary domain.
- Adult leagues and youth programs receive equal product priority.
- The platform serves your complex first.
- Future commercial expansion must be accommodated without making SaaS administration a prerequisite for operating your facility.

### 1.4 Current implementation boundary

The existing application is a persistent local demonstration.

It provides a useful foundation for customer navigation, staff screens, shared records, basic registration, scheduling, attendance, results, and simulated financial corrections.

It does **not** establish production readiness.

The production specification must replace or extend the demo’s simplified:

- Authentication and staff roles.
- Family permissions.
- Resource model.
- Enrollment lifecycle.
- Pricing and payments.
- Competition rules.
- Communications.
- Data migrations.
- Reliability and recovery controls.

Synthetic names, prices, capacities, refund behavior, and competition settings are examples, not approved policies.

### 1.5 Requirement conventions

New requirements in this document use `SPK-<DOMAIN>-###`.

Existing requirement identifiers from the original specification remain valid. Implementation work must maintain a cross-reference between those requirements and this expanded specification rather than renumbering or silently dropping them.

Each requirement must be tracked through:

**Specified → implemented → verified → operator accepted → released.**

Each implementation ticket must identify:

- Requirement IDs.
- Applicable policy decisions.
- Customer and staff behavior.
- Permissions.
- Failure and recovery behavior.
- Acceptance evidence.
- Release dependency.

A visible screen is not evidence that its underlying workflow is complete.

### 1.6 Scope categories

| Category                 | Treatment                                                                      |
| ------------------------ | ------------------------------------------------------------------------------ |
| Core platform            | Required for the complete operating product                                    |
| Soccer differentiators   | Included in the product scope; delivered in dependency order                   |
| Conditional operations   | Fully specified, enabled when the complex uses them                            |
| Advanced assistance      | Included in the long-term product design; cannot replace core workflows        |
| Future commercialization | Architecture accommodates it; commercial administration follows facility proof |

Conditional capabilities include memberships, installments, packages, supervised pickup, rentals, parties, tournaments, point of sale, access hardware, and accounting integrations.

An applicable capability cannot be omitted from a migrated operation without an explicit, approved operating arrangement.

### 1.7 Boundaries

The initial product does not become:

- A general accounting system.
- A payroll processor.
- A public social network.
- A medical assessment system.
- A biometric identification system.
- A marketplace moving money between independent facility operators.

Approved integrations may connect those specialist functions.

Referee fees, coach hours, and operational financial records may be calculated and approved within the platform without claiming to replace payroll or accounting.

---

## 2. Users, experiences, and interface contract

### 2.1 User roles

| Role                 | Primary responsibilities                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| Adult player         | Register, join teams, pay, RSVP, attend, view results                       |
| Parent or guardian   | Manage authorized children, registration, schedules, forms, payments        |
| Team captain         | Manage a season entry, invitations, availability, contribution requests     |
| Coach or instructor  | Manage assigned sessions, attendance, permitted communications, assessments |
| Referee or official  | Accept assignments, submit match reports and results                        |
| Front desk           | Assisted registration, arrival, attendance support, customer lookup         |
| League manager       | Divisions, entries, rosters, fixtures, results, disputes                    |
| Program manager      | Youth offerings, sessions, capacities, placements, progression              |
| Scheduler            | Field inventory, reservations, closures, schedule publication               |
| Finance operator     | Obligations, receipts, adjustments, reconciliation, approved refunds        |
| Facilities operator  | Maintenance, equipment, closures, inspection tasks                          |
| General manager      | Operating overview, exceptions, staffing, performance                       |
| System administrator | Accounts, permissions, integrations, configuration                          |
| Support operator     | Scoped customer assistance and operational troubleshooting                  |

A person may hold several roles. Their access depends on the specific action and scope, not merely a role label.

### 2.2 Customer mobile application

**SPK-UX-001 — Native customer experience**

The customer product must ship as installable iOS and Android applications.

An Expo web build may remain available for development. It is not a substitute for native acceptance or an additional customer website requirement.

The app must support:

- Native navigation and back behavior.
- Secure session storage.
- Push notification registration and preferences.
- Verified links into relevant activities and operations.
- Native sharing.
- Camera scanning where applicable.
- Accessible text scaling and screen-reader behavior.
- Foreground refresh after interrupted registration or payment.
- Clear connectivity and stale-data states.

**SPK-UX-002 — Primary navigation**

Use five main destinations:

| Destination | Contents                                                              |
| ----------- | --------------------------------------------------------------------- |
| Home        | Next activity, required actions, urgent changes, quick access to pass |
| Discover    | Leagues, programs, camps, trials, pickup, available rentals           |
| Schedule    | Personal and authorized family activities                             |
| Teams       | Team workspaces, fixtures, availability, standings                    |
| Account     | Family, enrollments, payments, credits, forms, preferences, support   |

The facility pass and notification inbox must remain easily accessible without requiring a permanent navigation tab.

**SPK-UX-003 — Home prioritization**

The home screen must prioritize:

1. Urgent changes affecting the user.
2. The next scheduled activity.
3. Actions required before participation.
4. Outstanding invitations or offers.
5. Relevant results and follow-up.
6. Renewal opportunities.

Marketing content must not obscure today’s activity or an unresolved registration.

Each action must identify the participant and relevant team or program.

**SPK-UX-004 — Next-activity card**

Show:

- Participant.
- Activity or fixture.
- Opponent where relevant.
- Facility and pitch.
- Start time.
- Arrival guidance when configured.
- Current status.
- RSVP where relevant.
- Material changes.
- Required action.

“Payment processing,” “awaiting placement,” and “confirmed” must not look interchangeable.

### 2.3 Staff dashboard

**SPK-UX-005 — Navigation**

The dashboard must provide:

- Today.
- Schedule.
- Leagues and tournaments.
- Programs and camps.
- Teams and placement.
- People and families.
- Registrations and waitlists.
- Arrival and attendance.
- Staff and officials.
- Finance.
- Communications.
- Facilities and maintenance.
- Reports.
- Administration.

Visibility depends on permissions.

**SPK-UX-006 — Today workspace**

The operating home must show:

- Current and upcoming activities.
- Field status.
- Expected arrivals.
- Match-readiness issues.
- Uncovered assignments.
- Registration and placement exceptions.
- Financial exceptions requiring action.
- Failed urgent communications.
- Maintenance affecting operations.
- Unresolved incidents within the viewer’s scope.

Every issue must have:

- A meaningful title.
- Severity.
- Affected activity or record.
- Owner or responsible queue.
- Age and deadline where applicable.
- Next permitted action.
- Resolution history.

Closing an issue must not falsely mark an underlying payment, booking, or delivery problem as resolved.

### 2.4 Coach and referee experience

**SPK-UX-007**

Provide an assignment-focused workspace within the responsive staff application.

It must work on phones for use beside a field.

Initial delivery does not require a separate coach or referee native app. The shared API and role model must allow that surface later.

The workspace must expose only:

- Assigned activities.
- Relevant participant information.
- Assignment acceptance.
- Attendance or match reporting.
- Permitted communication.
- Approved hours or fee records.

### 2.5 Interface quality

**SPK-UX-008**

Every consequential screen must define:

- Loading.
- Empty.
- Ready.
- Validation failure.
- Permission restriction.
- Stale version.
- Offline or unavailable.
- Processing.
- Success.
- Partial completion where explicitly permitted.
- Recovery required.

Recoverable failures must preserve valid user input.

**SPK-UX-009**

Staff must have keyboard alternatives to drag interactions.

Customer apps must support VoiceOver, TalkBack, text scaling, appropriate focus order, and non-color status indicators.

Accessibility acceptance must include complete journeys rather than only automated scans.

**SPK-UX-010**

Design direction:

- Soccer-specific visual identity.
- Clear information hierarchy.
- Strong readability in busy facilities.
- Restrained animation.
- Dense but understandable staff views.
- Simple customer choices.
- Consistent terminology across app, dashboard, receipts, and messages.

Decorative effects must not delay common operating tasks.

---

## 3. Functional specification

### 3.1 Identity, families, and permissions

**SPK-IAM-001 — Separate identities**

Represent these separately:

- Person.
- Login account.
- Household.
- Guardian relationship.
- Participant.
- Payer.
- Pickup delegate.
- Staff assignment.
- Team role.

Sharing an address, email, surname, or household does not automatically establish authority.

**SPK-IAM-002 — Verified access**

Existing private records become visible only after verified account access and the required relationship checks.

A registration entered by staff must later be claimable by the correct verified customer without creating another participant.

**SPK-IAM-003 — Action-specific grants**

Guardian permissions must independently control:

- Viewing.
- Registering.
- Paying.
- Receiving operational messages.
- Completing applicable forms.
- Collecting a child.

One permission must not silently imply another.

**SPK-IAM-004 — Invitations**

Invitations must record:

- Inviting actor.
- Recipient.
- Scope.
- Requested permissions.
- Expiry.
- Acceptance.
- Revocation.

Accepting an invitation grants only the authorized scope.

**SPK-IAM-005 — Disputed access**

Provide a restricted review workflow for contradictory or disputed access requests.

The workflow must support:

- Temporary restrictions.
- Evidence references.
- Review ownership.
- Decision history.
- Effective dates.
- Escalation.

The application must not infer a resolution from family membership.

**SPK-IAM-006 — Revocation**

Revocation must affect new protected requests, exports, private feed retrieval, and protected messages still awaiting platform dispatch.

Previously downloaded or delivered information cannot be guaranteed recalled.

**SPK-IAM-007 — Duplicates**

Duplicate detection produces review candidates.

Merging must preserve participation, financial ownership, source identifiers, and history without importing unverified permissions.

**Acceptance examples**

- Two guardians can register the same child, but cannot create duplicate equivalent enrollments.
- A guardian who can view schedules cannot collect the child without pickup permission.
- A coach who is also a parent receives each permission only in its proper scope.
- Account recovery does not grant new family access.

### 3.2 Catalog, offerings, and publication

**SPK-CAT-001**

Separate reusable program definitions from dated offerings and individual sessions.

An offering must specify:

- Name and description.
- Activity type.
- Format.
- Location.
- Dates and registration window.
- Eligibility.
- Participation entitlement.
- Capacity units.
- Price and obligations.
- Required forms.
- Cancellation policy.
- Responsible manager.
- Publication state.

**SPK-CAT-002**

Support:

- Season participation.
- Term programs.
- Camps.
- Individual sessions.
- Trials.
- Makeups.
- Pickup sessions.
- Private or small-group coaching.
- Rentals when applicable.
- Packages and memberships when applicable.

**SPK-CAT-003**

Copying an offering or season creates a draft.

It must not copy payments, attendance, accepted enrollments, results, or permissions.

**SPK-CAT-004**

Publication must validate required configuration. Registration opening and schedule publication are distinct actions.

Pausing registration preserves existing participation.

### 3.3 Registration, baskets, and capacity

**SPK-REG-001**

Support distinct registration intents:

- Individual league entry.
- Joining a known team.
- Creating a team entry.
- Youth enrollment.
- Trial.
- Makeup.
- Pickup.
- Rental request.

**SPK-REG-002**

Evaluate eligibility using versioned policies and the configured reference date.

Show understandable reasons and permitted alternatives.

Overrides require specific authority, reason, and audit history.

**SPK-REG-003**

Keep independent records for:

- Application approval.
- Enrollment.
- Placement.
- Financial obligation.
- Event participation eligibility.

A future installment does not automatically mean an enrollment is unconfirmed.

**SPK-REG-004 — Household basket**

Support multiple authorized participants and offerings in one purchase.

Each line retains its own:

- Participant.
- Entitlement.
- Eligibility result.
- Price.
- Policy.
- Enrollment outcome.

Proposed default: all-or-nothing household fulfillment.

Partial fulfillment may be supported only when the applicable configuration permits it and the customer explicitly accepts that behavior.

**SPK-REG-005 — Capacity**

Capacity may be measured in:

- Team entries.
- Roster places.
- Offering seats.
- Session seats.
- Camp-group places.
- Rental resources.
- Multiple simultaneous constraints.

Capacity must include active holds and accepted commitments.

**SPK-REG-006 — Holds**

Use a server-owned, expiring hold.

Proposed starting duration: ten minutes, subject to operator confirmation and payment-method testing.

A hold must have one terminal outcome: committed, released, or expired.

A client countdown is informational; the server controls expiry.

**SPK-REG-007 — Approval**

Proposed default: obtain required human approval before capturing a new payment.

Approval does not promise capacity unless the approved policy explicitly reserves it.

Deposit-before-approval workflows require separate consent, rejection handling, and refund rules.

**SPK-REG-008 — Waitlists**

A waitlist record must include:

- Participant.
- Offering.
- Priority basis.
- Relevant preferences.
- Status.
- Offer history.

An offer reserves a defined place until expiry.

Acceptance consumes it once. Expiration releases it according to the configured priority policy.

Late payments must not displace a valid waitlist offer.

**SPK-REG-009 — Assisted registration**

Staff use the same eligibility, pricing, capacity, and financial commands as customers.

Record the staff actor separately from the participant, payer, and form signer.

Staff must not falsely sign a guardian acknowledgment.

**SPK-REG-010 — Cancellation and transfer**

Before commitment, show:

- Existing participation.
- Proposed participation.
- Affected dates.
- Capacity implications.
- Refund, credit, or additional charge.
- Required approval.

A transfer must preserve historical attendance and connect the old and new enrollments.

### 3.4 Soccer competition model

**SPK-COMP-001**

Represent separately:

- Competition.
- Season.
- Division.
- Continuing team identity.
- Season team entry.
- Effective roster membership.
- Fixture.
- Official result.
- Standings revision.
- Bracket progression.

Renewal creates new season records without rewriting prior seasons.

**SPK-COMP-002 — Soccer formats**

Support configurable definitions for:

- Outdoor soccer.
- Boarded indoor soccer.
- Futsal.
- Other small-sided formats used by the complex.

Do not hard-code a universal indoor-soccer rule set.

A competition rule set must define applicable:

- Players on field.
- Roster limits.
- Match length and periods.
- Minimum players.
- Substitution rules.
- Eligibility reference dates.
- Multi-team restrictions.
- Scoring.
- Draws.
- Overtime or shootouts.
- Cards and suspensions.
- Forfeits.
- Abandonment.
- Tiebreakers.
- Protest deadlines.
- Result approval.

Irrelevant fields remain disabled for that format.

**SPK-COMP-003 — Division management**

Support divisions by approved combinations of:

- Age.
- Playing level.
- Competition category.
- Season.
- Location.
- Format.

Placement and eligibility must use documented criteria rather than informal labels alone.

**SPK-COMP-004 — Team entry**

Team-entry approval, financial status, roster completion, and competition eligibility remain distinct.

Staff must see what is missing and who can resolve it.

**SPK-COMP-005 — Rosters**

Roster changes must preserve effective dates.

A player removed today must remain visible in the historical record of a match played last week.

Joining, transfer, guest-player, and substitute rules must respect competition restrictions.

### 3.5 Captain workspace

**SPK-CAP-001**

Captains must be able to:

- Create or renew an authorized team entry.
- Invite players.
- Review permitted join requests.
- View roster readiness.
- Request player availability.
- See upcoming games.
- Request permitted contributions.
- Initiate approved roster changes.
- Contact the operating team.

**SPK-CAP-002 — Privacy**

Captains may see actionable readiness indicators without seeing private family details, payment instruments, sensitive notes, or unrelated purchases.

A contribution request does not grant authority over the payer’s account.

**SPK-CAP-003 — Availability**

RSVP states must distinguish:

- Available.
- Unavailable.
- Tentative, if enabled.
- No response.

RSVP is not attendance or eligibility.

**SPK-CAP-004 — Substitutes**

Substitute requests must check:

- Competition eligibility.
- Effective roster rules.
- Conflicting participation.
- Suspension status.
- Required approvals.
- Capacity where applicable.

A captain cannot bypass eligibility by labeling someone a guest.

**SPK-CAP-005 — Renewal**

Renewal may prefill approved team details and suggest prior players.

It must re-evaluate prices, eligibility, permissions, and roster acceptance.

No automatic charge follows from prior participation.

### 3.6 Free agents, pickup, and placement

**SPK-PLACE-001**

Individual registrants may provide approved placement information:

- Availability.
- Preferred competition.
- Age eligibility.
- Experience or declared playing level.
- Relevant position preferences.
- Requested teammates where permitted.

**SPK-PLACE-002**

Staff receive eligible candidate teams with explainable reasons.

Placement remains staff-reviewed by default.

**SPK-PLACE-003**

A placement must check capacity and current eligibility at commitment.

A recommendation does not reserve a place.

**SPK-PLACE-004 — Pickup**

Pickup sessions require their own:

- Capacity.
- Entry requirements.
- Payment rules.
- Waitlist.
- Cancellation rules.
- Attendance.
- Organizer assignment.

Pickup attendance does not create league membership.

**SPK-PLACE-005 — Privacy**

Free-agent discovery must not expose contact details or profiles publicly without an explicit product and consent decision.

The initial model is operator-mediated placement.

### 3.7 Scheduling and shared spaces

**SPK-SCHED-001 — Physical inventory**

The resource inventory must describe:

- Facility.
- Pitch or other space.
- Dimensions or supported configurations.
- Whole-space and subdivision relationships.
- Compatible activity formats.
- Operating hours.
- Closures.
- Setup and cleanup requirements.
- Required equipment.
- Applicable staffing constraints.

**SPK-SCHED-002 — Overlap model**

Represent physical conflict units.

A whole-field reservation must conflict with every overlapping subdivision reservation.

Two compatible subdivisions may operate simultaneously only when the configured physical arrangement permits it.

**SPK-SCHED-003 — Occupied interval**

Conflict checks must include preparation and cleanup buffers.

A game ending at 19:00 with a ten-minute turnover requirement does not make its space available at 19:00.

**SPK-SCHED-004 — Other constraints**

Check:

- Team overlap.
- Assigned coach overlap.
- Official overlap.
- Required rest.
- Closures.
- Equipment conflicts.
- Required staffing.
- Approved participant conflicts where relevant.

**SPK-SCHED-005 — Drafts**

Schedule changes occur in autosaved drafts.

Drafts must preserve:

- Base revisions.
- Proposed changes.
- Validation results.
- Author.
- Last save.
- Publication status.

Drafts do not send final customer notices.

**SPK-SCHED-006 — Publication**

Publication must:

1. Recheck authorization.
2. Revalidate current records.
3. Recheck all physical conflicts.
4. Verify fixture obligations.
5. Commit the approved revision.
6. Record durable follow-up events.
7. Update customer and staff views.

A stale or conflicting draft fails without partially publishing unrelated changes in the same publication group.

**SPK-SCHED-007 — Recurrence**

Support edits to:

- One occurrence.
- This and future occurrences.
- The entire series.

Show exactly which events change.

Past attendance and played games remain attached to their original stable identities.

**SPK-SCHED-008 — Time**

Store event instants in UTC and retain the facility’s IANA timezone for scheduling and display.

Recurring local times must behave explicitly across daylight-saving changes.

Ambiguous or nonexistent times require resolution.

**SPK-SCHED-009 — Closure response**

A closure must identify affected:

- Games.
- Programs.
- Rentals.
- Staff.
- Customers.
- Financial obligations.
- Messages.

Staff can build and review a resolution involving relocation, rescheduling, cancellation, or policy-governed financial adjustment.

### 3.8 Fixture generation and scheduling fairness

**SPK-FIX-001 — Fixture specification**

Define:

- Teams.
- Games per team.
- Opponent frequency.
- Competition dates.
- Blackouts.
- Byes.
- Minimum rest.
- Allowed start times.
- Required resources.
- Playoff structure.

**SPK-FIX-002 — Completeness**

A conflict-free calendar is not necessarily a complete season.

Validation must detect:

- Missing fixtures.
- Duplicate fixtures.
- Excess games.
- Unscheduled games.
- Incorrect opponent frequency.
- Invalid byes.
- Unfulfilled playoff requirements.

Partial publication must explicitly record remaining obligations, owner, and deadline.

**SPK-FIX-003 — Fairness**

Support configurable preferences for:

- Early and late start distribution.
- Rest distribution.
- Consecutive games.
- Repeated opponents.
- Preferred availability.
- Home/away balance where meaningful.
- Coach or family convenience when approved.

Hard constraints and preferences must be visibly distinct.

**SPK-FIX-004 — Solver outcomes**

Return:

- Feasible proposal.
- Proven optimal proposal, only when established.
- Proven infeasibility, only when established.
- No feasible proposal found within the search limit.

A timeout must not be mislabeled “impossible.”

Preserve input snapshot, rule version, search settings, and outcome.

**SPK-FIX-005 — Staff control**

Suggestions remain drafts. Publication uses the normal scheduling command and current conflict validation.

### 3.9 Match readiness

**SPK-READY-001**

Each fixture must have an explainable readiness assessment.

Checks may include:

- Published time and field.
- Field operational status.
- Required officials.
- Team acceptance.
- Minimum eligible roster.
- Required forms.
- Applicable financial conditions.
- Unresolved suspensions.
- Pending disputes affecting play.
- Material change notifications.

**SPK-READY-002**

Separate:

- Blocking issue.
- Warning.
- Informational issue.
- Unknown or stale evidence.

A missing RSVP alone must not become an eligibility block.

**SPK-READY-003**

Every readiness issue must identify:

- Reason.
- Source record.
- Responsible role.
- Required action.
- Last evaluation.
- Deadline when applicable.

**SPK-READY-004**

Readiness is derived from authoritative records.

It is not a separate editable “ready” checkbox that can override those records.

### 3.10 Officials, coaches, and assignments

**SPK-STAFF-001**

Maintain availability, permitted assignments, qualification evidence where required, and assignment scope.

**SPK-STAFF-002**

Assignment states must distinguish:

- Proposed.
- Offered.
- Accepted.
- Declined.
- Withdrawn.
- Completed.

A proposed assignment does not satisfy a required accepted-official check.

**SPK-STAFF-003**

Changes must check overlapping commitments and any required turnaround.

An absent official can trigger a replacement workflow and operational escalation.

**SPK-STAFF-004**

Temporary or substitute assignments grant time-bounded access.

Access expires without removing historical work records.

**SPK-STAFF-005**

Officials may submit:

- Scores.
- Result classification.
- Cards.
- Match incidents.
- Abandonment details.
- Required confirmation.

Publication authority is separately configured.

**SPK-STAFF-006**

Track approved hours or fees with:

- Assignment.
- Rate basis.
- Submitted amount.
- Approver.
- Adjustment history.
- Export status.

These records support payment administration but do not execute payroll unless separately integrated and approved.

### 3.11 Results, standings, and disputes

**SPK-RESULT-001**

Result revisions use:

**Draft → submitted → official → superseded.**

Official standings derive only from official results.

**SPK-RESULT-002**

Distinguish:

- Ordinary completion.
- Forfeit.
- Cancellation.
- Abandonment.
- Postponement.
- Disputed result.

**SPK-RESULT-003**

Standings must use a versioned rule set and explain tiebreak outcomes.

**SPK-RESULT-004**

Corrections preserve the prior result, actor, reason, and publication time.

Recalculate affected standings.

If a correction affects a published bracket or a downstream game already played, create a management review task instead of silently rewriting it.

**SPK-RESULT-005**

Disputes require:

- Eligible submitting role.
- Relevant fixture.
- Submission window.
- Reason.
- Evidence references.
- Reviewer.
- Decision.
- Publication consequences.
- Appeal handling if applicable.

### 3.12 Discipline and incident management

**SPK-DISC-001**

Support restricted records for:

- Cards.
- Misconduct reports.
- Suspensions.
- Complaints.
- Appeals.
- Operational incidents.

**SPK-DISC-002**

A suspension must state:

- Subject.
- Basis.
- Scope.
- Effective period or match count.
- Applicable competitions.
- Approval.
- Appeal status.
- Completion criteria.

Do not assume every suspension applies across every program.

**SPK-DISC-003**

Discipline may affect event eligibility only through the approved rule set.

Overrides require authorized review and history.

**SPK-DISC-004**

Sensitive incident narratives must not appear in public results, ordinary team views, or general customer exports.

**SPK-DISC-005**

Operational injury or incident recording must remain distinct from diagnosis or medical advice.

The facility defines its required reporting and escalation procedure.

### 3.13 Youth programs and progression

**SPK-YOUTH-001**

Support age-banded programs, academies, camps, clinics, trials, makeups, and approved private coaching.

**SPK-YOUTH-002**

Capacity must respect configured group size, space, and staffing requirements.

Increasing commercial capacity must not silently bypass a staffing requirement.

**SPK-YOUTH-003**

Trial participation remains distinct from paid enrollment.

A follow-up offer can reuse permitted information without automatically charging or enrolling the child.

**SPK-YOUTH-004**

Makeup entitlements must reference:

- Originating session or policy event.
- Eligible replacements.
- Expiry.
- Redemption limit.
- Redemption history.

A monetary credit and a makeup entitlement are different assets.

**SPK-YOUTH-005 — Development records**

Coaches may record assessments using approved templates.

Assessments must define:

- Skill area.
- Observation date.
- Applicable scale.
- Author.
- Supporting comments.
- Visibility.
- Review status.

Private coaching notes and parent-visible feedback remain separate.

**SPK-YOUTH-006 — Progression**

Staff may recommend the next group or program.

A recommendation must explain eligibility and suitability using approved information.

It does not guarantee acceptance, availability, or purchase.

**SPK-YOUTH-007 — Family coordination**

Show all authorized children in one calendar.

Highlight overlapping commitments without preventing permitted enrollment by default.

A parent may knowingly accept an overlap; physical resource and staff conflicts remain separately enforced.

### 3.14 Arrival, attendance, departure, and pickup

**SPK-ENTRY-001**

Keep separate records for:

- Facility arrival.
- Session check-in.
- Observed attendance.
- Departure.
- Supervised release.

**SPK-ENTRY-002**

A pass must contain an opaque reference rather than exposed child or household details.

Scanning opens the appropriate selection and validation flow.

**SPK-ENTRY-003**

A household scan must not mark every child present.

Staff select the people and sessions actually attending.

**SPK-ENTRY-004**

Arrival checks must show actionable issues.

An unrelated balance must not block participation unless the approved policy expressly requires it.

**SPK-ENTRY-005**

Attendance corrections preserve actor, time, and reason.

**SPK-ENTRY-006**

Support visitor categories used by the facility, including guardians and spectators, without fabricating participant enrollments.

**SPK-ENTRY-007 — Pickup**

For supervised programs, verify current pickup authority and record:

- Child.
- Collecting person.
- Verification outcome.
- Staff actor.
- Time.
- Relevant restriction or escalation.
- Release outcome.

Schedule visibility and payment permission do not establish pickup authority.

**SPK-ENTRY-008**

An arrivals count must not be presented as verified occupancy unless departure capture and reconciliation support that claim.

### 3.15 Prices, obligations, and payments

**SPK-PAY-001**

Store money as integer minor units with an explicit currency.

Never accept a client-submitted price as authoritative.

**SPK-PAY-002 — Quotes**

A quote must show:

- Each participant and item.
- Base price.
- Discounts.
- Approved taxes and fees.
- Credits applied.
- Due now.
- Future obligations.
- Expiry.
- Applicable policies.

Historical purchases retain their price and policy basis.

**SPK-PAY-003**

Define discount:

- Eligibility.
- Stacking.
- Caps.
- Redemption limits.
- Rounding.
- Allocation across lines.
- Effective dates.

**SPK-PAY-004 — Team obligations**

Support:

- Individual player billing.
- One responsible team payer.
- Team obligation with player contributions.

Contribution requests do not create duplicate copies of the team debt.

Show total obligation, received amount, allocated amount, and remaining balance consistently.

**SPK-PAY-005**

Concurrent payments against the final balance must follow an approved overpayment policy.

Any excess must remain visible and traceable; it cannot disappear into a misleading zero balance.

**SPK-PAY-006 — Installments**

Plans must record:

- Amounts.
- Due dates.
- Authorization.
- Retry policy.
- Notices.
- Extensions.
- Outstanding obligations.

A failed installment creates a financial state and action queue. Participation consequences are evaluated separately.

**SPK-PAY-007 — Payment uncertainty**

A timeout is not proof of failure.

Unknown outcomes must be reconciled before another operation risks charging the customer again.

**SPK-PAY-008 — Refunds**

Refund operations must reserve the refundable amount before execution.

Concurrent requests cannot reserve the same funds.

An unknown external result retains its reservation until authoritative reconciliation.

**SPK-PAY-009 — Credits**

Credits have explicit:

- Owner.
- Currency.
- Permitted uses.
- Expiry when approved.
- Remaining balance.
- Source.
- Redemption history.

Concurrent redemption cannot consume the same credit twice.

**SPK-PAY-010 — Financial records**

Use an append-only operational subledger.

Posted corrections create reversing or adjusting entries.

Staff cannot directly overwrite balances.

**SPK-PAY-011 — Reconciliation**

Distinguish:

- Orders.
- Obligations.
- Customer receipts.
- Refunds.
- Credits.
- Processor fees.
- Disputes.
- Settlements.
- Cash.

Payment volume is not automatically revenue.

**SPK-PAY-012**

Cash and other externally recorded tenders require approved procedures, permissions, evidence, and reconciliation.

They do not bypass registration or capacity checks.

### 3.16 Rentals, parties, memberships, packages, and POS

These capabilities are part of the complete design. Their operating applicability and release timing remain explicit.

| Capability       | Required operating behavior                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Rentals          | Availability, requests or instant confirmation, recurring bookings, deposits, cancellation, setup, access conditions |
| Parties          | Combined space, staff, equipment, guest count, package choices, deposits, host responsibilities                      |
| Memberships      | Eligibility benefits, effective dates, renewal, suspension, cancellation, entitlement effects                        |
| Session packages | Purchase quantity, eligible sessions, expiry, reservation, redemption, reversal                                      |
| Tournaments      | Entry, divisions, pools, fixtures, seeding, brackets, officials, compressed scheduling                               |
| POS              | Products, prices, approved taxes, tenders, receipts, returns, permissions, reconciliation                            |
| Access hardware  | Device inventory, access policy, revocation, event ingestion, outages, audit                                         |
| Accounting       | Approved mappings, export or integration batches, reconciliation, correction handling                                |

**SPK-COND-001**

Membership must not automatically imply unlimited attendance unless its specific entitlement says so.

**SPK-COND-002**

Package redemption must be transactional and reversible according to the cancellation policy.

**SPK-COND-003**

A party or rental must reserve all required resources together. Reserving a field while failing to reserve mandatory staff must not produce a falsely complete booking.

**SPK-COND-004**

Hardware access does not establish session attendance or child pickup authorization.

### 3.17 Facilities and maintenance

**SPK-FAC-001**

Track maintainable assets such as:

- Turf areas.
- Goals.
- Nets.
- Boards.
- Dividers.
- Lighting.
- Scoreboards.
- Relevant equipment.

**SPK-FAC-002**

Maintenance records must include:

- Asset or space.
- Issue.
- Severity.
- Reporter.
- Supporting evidence.
- Assigned owner.
- Due date.
- Operating restriction.
- Resolution and inspection.

**SPK-FAC-003**

An approved restriction must affect scheduling availability.

The affected physical area determines whether a whole pitch or only a compatible subdivision is blocked.

**SPK-FAC-004**

Returning a space to service requires an authorized release.

Closing a maintenance task must not silently reopen a field if a separate inspection remains required.

**SPK-FAC-005**

Preventive maintenance can create future reservations or closures through the same scheduling authority.

### 3.18 Communications

**SPK-COMMS-001**

Support in-app notices, push, and configured email or SMS channels.

The operating team must approve channel use and communication policies.

**SPK-COMMS-002**

Triggers include:

- Registration outcome.
- Team invitation.
- Placement.
- Waitlist offer.
- Schedule publication or change.
- Cancellation.
- Payment attention.
- Assignment offer.
- Result publication.
- Renewal opportunity.
- Approved youth feedback.

**SPK-COMMS-003**

Resolve recipients from current permissions.

Recheck protected recipients before handing an unsent notice to an external provider.

**SPK-COMMS-004**

Distinguish:

- Queued.
- Provider accepted.
- Delivered where confirmed.
- Failed.
- Unknown.
- Read.
- Acknowledged.

A push notification is not guaranteed delivery.

**SPK-COMMS-005**

Schedule messages must show old and new practical details.

Suppress obsolete unsent reminders.

**SPK-COMMS-006**

Staff compose messages against an authorized audience, preview the recipients, and confirm the send.

Do not expose everyone’s contact details through a shared recipient list.

**SPK-COMMS-007**

Essential operational communications and promotional preferences must be separately represented.

**SPK-COMMS-008**

Private calendar feeds must use stable event identities and revocable authorization.

Revocation stops future access but cannot guarantee erasure from an external calendar.

### 3.19 Customer service

**SPK-SUPPORT-001**

Provide a scoped customer timeline covering relevant:

- Registration.
- Participation.
- Orders.
- Payments.
- Changes.
- Messages.
- Support requests.

**SPK-SUPPORT-002**

Support cases must record owner, category, related records, history, and resolution.

Staff must not need customer credentials to assist.

**SPK-SUPPORT-003**

Support actions use normal authorized commands.

A support note cannot substitute for an actual refund, permission change, or transfer.

### 3.20 Reporting, field economics, and retention

**SPK-REPORT-001**

Every metric must define:

- Business question.
- Grain.
- Numerator and denominator.
- Time basis.
- Exclusions.
- Dimensions.
- Currency where relevant.
- Freshness.
- Access scope.

**SPK-REPORT-002 — Required operating reports**

Include:

- Daily schedule.
- Expected arrivals.
- Attendance.
- Match readiness.
- Uncovered assignments.
- Waitlist demand.
- Registration funnel.
- Enrollment and roster completeness.
- Outstanding obligations.
- Payment and refund reconciliation.
- Maintenance restrictions.
- Communication failures.

**SPK-REPORT-003 — Field utilization**

Report reserved hours, available hours, occupied observations where captured, and closures separately.

Whole-field and subdivision reporting must avoid double-counting the same physical time.

Resource-equivalent calculations must disclose their configured weighting.

**SPK-REPORT-004 — Economics**

Show revenue or allocated sales per field hour only when the allocation method is explicit.

Profit or contribution margin requires agreed cost inputs; it cannot be inferred from collections alone.

**SPK-REPORT-005 — Retention**

Measure renewal by defined cohorts:

- Adult teams.
- Individual players.
- Youth participants.
- Households.
- Rental customers.

A household purchase and a returning individual participant are different metrics.

**SPK-REPORT-006**

Show demand by day, time, age band where appropriate, format, and program.

Separate observed demand from forecasts.

**SPK-REPORT-007**

Exports require independent permission checks and audit.

Reports must be reproducible after corrections.

### 3.21 Advanced operational assistance

**SPK-AUTO-001**

The optional assistant may:

- Summarize today’s unresolved issues.
- Explain readiness blockers.
- Find relevant policies.
- Draft communications.
- Propose schedule repairs.
- Summarize demand and renewals.
- Explain financial exceptions from approved records.

**SPK-AUTO-002**

Responses must identify supporting records and their freshness.

Missing evidence must remain visible.

**SPK-AUTO-003**

Consequential actions remain reviewable:

- Publishing schedules.
- Sending external communications.
- Charging or refunding.
- Changing rosters.
- Changing permissions.
- Resolving discipline.

**SPK-AUTO-004**

The assistant must use the same commands and permissions as other clients.

Imported text, attachments, and messages are data, not authority.

**SPK-AUTO-005**

Core operations remain usable when the assistant is unavailable.

---

## 4. Engineering and data contract

### 4.1 Architecture

Use a modular application with:

- Expo/React Native customer apps.
- React staff dashboard.
- TypeScript backend.
- NestJS domain modules.
- PostgreSQL operational database.
- Independently running durable workers.
- Restricted object storage.
- Provider adapters.
- Shared API and event contracts.

The proposed modular backend follows the organizational approach supported by [NestJS modules](https://docs.nestjs.com/modules).

Retain useful demo interfaces and tested business behavior. Replace demo-specific persistence, authentication, and shortcuts through explicit migrations and parity tests.

Do not split into microservices initially. Module ownership must be clear inside the application.

### 4.2 Domain ownership

| Module         | Owns                                               |
| -------------- | -------------------------------------------------- |
| Identity       | Accounts, people, relationships, grants            |
| Catalog        | Programs, offerings, policies                      |
| Competition    | Seasons, divisions, entries, rosters, results      |
| Scheduling     | Events, resources, reservations, publication       |
| Enrollment     | Applications, eligibility, capacity, waitlists     |
| Finance        | Quotes, orders, obligations, receipts, adjustments |
| Workforce      | Availability, assignments, approved fees           |
| Entry          | Arrival, attendance, departure, release            |
| Facilities     | Assets, maintenance, operating restrictions        |
| Communications | Audiences, notices, delivery attempts              |
| Support        | Cases and operational task coordination            |
| Migration      | Imports, mappings, authority records               |
| Reporting      | Derived metrics and exports                        |
| Automation     | Reviewable recommendations                         |

A module must not independently alter another module’s authoritative records.

### 4.3 Organization and facility boundaries

All operational records must carry organization scope.

A single organization may contain several facilities.

Independent-operator access remains disabled initially. Organization scoping must nevertheless be enforced so future expansion does not require retrofitting ownership into every record.

Cross-operator customer sharing is outside the initial design.

### 4.4 Minimum domain entities

| Area               | Required entities                                                          |
| ------------------ | -------------------------------------------------------------------------- |
| Identity           | Person, Account, ContactPoint, Household, Relationship, AccessGrant        |
| Policies           | PolicyVersion, Acknowledgment, Approval                                    |
| Catalog            | Program, Offering, Session, EntitlementDefinition                          |
| Competition        | League, Season, Division, Team, TeamEntry, RosterMembership                |
| Matches            | Fixture, ResultRevision, StandingsProjection, BracketNode                  |
| Discipline         | Incident, DisciplinaryDecision, Suspension, Appeal                         |
| Scheduling         | Resource, Configuration, ConflictUnit, Event, Reservation, ScheduleDraft   |
| Participation      | Application, Enrollment, PlacementRequest, SessionBooking                  |
| Capacity           | CapacityPool, Hold, Allocation, WaitlistEntry, WaitlistOffer               |
| Finance            | Quote, Order, OrderLine, Obligation, PaymentAttempt, RefundAttempt, Credit |
| Accounting support | Journal, JournalEntry, PaymentAllocation, SettlementReconciliation         |
| Workforce          | Availability, Qualification, Assignment, FeeSubmission                     |
| Arrival            | Visit, AttendanceObservation, Departure, ReleaseRecord                     |
| Facilities         | Asset, MaintenanceTask, Inspection, Restriction                            |
| Communications     | Notification, DeliveryAttempt, Preference, Acknowledgment                  |
| Operations         | Case, Exception, Operation, AuditRecord                                    |
| Reliability        | OutboxEvent, InboxEvent, JobAttempt                                        |
| Migration          | ExternalMapping, ImportBatch, ImportException, AuthorityAssignment         |

Every consequential record must retain stable identity, revision where applicable, timestamps, and relevant provenance.

### 4.5 Important changes to current shared types

The production model must explicitly replace current demo shortcuts:

- `Person.householdId` cannot determine authority.
- A stored `age` cannot replace date-based eligibility evaluation.
- `Resource` must express physical overlap and configurations.
- `Offering.priceCents` must become versioned price rules and quotes.
- Enrollment must not combine confirmation and waitlisting in one simplified status.
- Payment must not reduce provider outcomes to only paid/refunded.
- Team must separate continuing identity from season entry.
- Attendance must preserve observations and corrections.
- Coach names must become person and assignment references.
- Messages must represent actual delivery states.
- Global bootstrap responses must give way to scoped, paginated queries.

Existing clients must be migrated together with contract tests.

### 4.6 State machines

| Record          | Canonical lifecycle                                                                        |
| --------------- | ------------------------------------------------------------------------------------------ |
| Application     | Draft, submitted, awaiting review, accepted, declined, withdrawn                           |
| Enrollment      | Pending, confirmed, canceled, transferred, completed                                       |
| Placement       | Unassigned, proposed, assigned, released                                                   |
| Hold            | Active, committed, released, expired                                                       |
| Session booking | Pending, confirmed, canceled, expired                                                      |
| Payment attempt | Created, action required, processing, succeeded, failed, canceled, unknown                 |
| Refund          | Requested, processing, succeeded, failed, canceled, unknown                                |
| Checkout        | Prepared, awaiting payment, finalizing, completed, recovery required, compensated, aborted |
| Result          | Draft, submitted, official, superseded                                                     |
| Assignment      | Proposed, offered, accepted, declined, withdrawn, completed                                |

Each command must define allowed source state, actor, guards, locks, effects, events, and recovery.

Independent facts must not overwrite one another’s state.

### 4.7 Integrity invariants

The system must enforce:

1. No unauthorized cross-household or cross-organization access.
2. No equivalent duplicate active entitlement where prohibited.
3. No overcommitted capacity.
4. No overlapping exclusive physical reservation.
5. No duplicate financial effect from replay.
6. No refund beyond available refundable funds.
7. No double credit or package redemption.
8. No official result without publication authority.
9. No silent rewriting of published history.
10. No protected message dispatched using revoked authority.
11. No duplicated authority during migration.
12. No lost required follow-up after a committed operation.

Use database constraints and transactions for integrity.

PostgreSQL range and exclusion mechanisms are suitable for enforcing non-overlapping reservations; application checks provide earlier feedback but are not the final guarantee. [PostgreSQL range documentation](https://www.postgresql.org/docs/current/rangetypes.html)

### 4.8 API contract

Use versioned, command-oriented APIs.

Representative interfaces:

| Interface                                | Purpose                                       |
| ---------------------------------------- | --------------------------------------------- |
| `POST /v1/registration-quotes`           | Evaluate an authorized basket and price       |
| `POST /v1/registration-checkouts`        | Acquire capacity and initiate checkout        |
| `GET /v1/operations/{id}`                | Read an authorized asynchronous outcome       |
| `POST /v1/enrollments/{id}/transfer`     | Coordinate participation and financial change |
| `POST /v1/waitlist-offers/{id}/accept`   | Consume an eligible reserved offer            |
| `POST /v1/team-entries/{id}/invitations` | Invite a prospective team member              |
| `POST /v1/fixtures/{id}/availability`    | Record authorized RSVP                        |
| `POST /v1/schedule-drafts/{id}/publish`  | Validate and commit a schedule revision       |
| `GET /v1/fixtures/{id}/readiness`        | Explain current readiness                     |
| `POST /v1/assignments/{id}/accept`       | Accept an authorized assignment               |
| `POST /v1/fixtures/{id}/results`         | Submit a result revision                      |
| `POST /v1/results/{id}/publish`          | Make an approved result official              |
| `POST /v1/payments/{id}/refunds`         | Reserve and request a refund                  |
| `POST /v1/attendance-observations`       | Record activity-specific observation          |
| `POST /v1/releases`                      | Record an authorized supervised release       |
| `POST /v1/maintenance-restrictions`      | Apply an approved operating restriction       |

Publish exact schemas in OpenAPI before client integration.

Organization context must be derived from authenticated authorization, even when identifiers appear in requests.

### 4.9 Command behavior

Consequential commands require:

- Actor.
- Authorized scope.
- Validated payload.
- Idempotency key where appropriate.
- Expected revision for sensitive edits.
- Policy references.
- Reason for overrides or corrections.

A replay with the same key and payload returns the same operation.

The same key with different contents returns a conflict.

A sensitive stale edit must fail rather than overwrite newer work.

### 4.10 Errors

Return a stable code, safe message, correlation reference, and permitted next action.

Required error categories include:

- Access denied.
- Participant authority required.
- Eligibility failed.
- Missing acknowledgment.
- Capacity unavailable.
- Resource conflict.
- Stale revision.
- Quote expired.
- Idempotency conflict.
- Payment outcome unknown.
- Refund pending.
- Integration unavailable.

Errors must not reveal another household’s protected record existence.

### 4.11 Financial coordination

The checkout coordinator must:

1. Validate the stored quote and policy.
2. Prevent duplicate equivalent entitlement intent.
3. Acquire required holds.
4. Create the order and durable operation.
5. Initiate provider execution.
6. Receive authoritative evidence.
7. Record financial facts.
8. Finalize permitted enrollments.
9. Record durable follow-up.
10. Reconcile or compensate failures.

Provider success followed by local finalization failure must remain visible as received money plus incomplete fulfillment.

Do not hold a database transaction open across an external network call.

Webhook handlers must authenticate provider events, durably record them, and tolerate duplicates and reordering. Stripe’s documentation illustrates these provider behaviors; it does not constitute a provider selection. [Webhook documentation](https://docs.stripe.com/webhooks)

### 4.12 Background work

Use a transactional outbox for follow-up work and an inbox for external events.

Jobs must carry:

- Organization.
- Operation.
- Stable event identity.
- Attempt count.
- Retry policy.
- Correlation reference.
- Failure owner.

Workers must tolerate interruption and replay.

Exactly-once network delivery is not assumed. One logical business effect must be enforced.

### 4.13 Native security and compatibility

Store session secrets using appropriate platform-backed secure storage. Expo provides a native secure-storage facility, but application lifecycle and recovery behavior must be tested independently. [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)

The mobile release must define:

- Supported OS versions.
- API compatibility window.
- Minimum supported app version.
- Session expiry and recovery.
- Safe deep-link destinations.
- Update behavior.
- Privacy declarations.
- Native permission explanations.
- Account deletion/request handling under the approved policy.

Package versions must be pinned and verified at implementation time.

### 4.14 Security and privacy

Require:

- Verified identity.
- Multifactor authentication for privileged staff.
- Least privilege.
- Object-level and field-level authorization.
- Rate-limited recovery.
- Protected secret storage.
- Encrypted transport.
- Restricted uploads and downloads.
- Expiring exports.
- Audited privileged actions.
- Dependency and secret scanning.
- Incident response.

Payment-card details must remain in approved provider flows.

Child information must be minimized and separated from public schedules, general exports, and ordinary logs.

Retention periods and legal wording require approval from the responsible operator and advisers. They must not be invented by engineering.

### 4.15 Offline behavior

Proposed default:

Approved staff devices may queue arrival and attendance observations against a recent, encrypted, scoped roster.

They may not authorize:

- New payments.
- New capacity commitments.
- Guardian changes.
- Roster transfers.
- Current pickup permission.

Proposed maximum roster age: two hours, pending operating approval.

Show cached-data age prominently.

Each queued observation needs a unique identifier, actor, event, observed time, snapshot reference, and received time.

Reconnection must preserve conflicting observations for review.

Supervised pickup requires an online authorization check or a separately approved manual outage procedure.

---

## 5. Integration, migration, and operating readiness

### 5.1 Integration register

For every provider, record:

- Product and vendor.
- Account owner.
- Authorized access.
- Supported operations.
- Sandbox availability.
- Documentation.
- Event behavior.
- Rate limits.
- Idempotency.
- Failure handling.
- Reconciliation owner.
- Exit procedure.

Classify capability evidence as:

**Documented → tested → accepted → live.**

Public documentation alone does not prove the facility’s account capabilities.

### 5.2 Provider-selection gates

The specification establishes interfaces without inventing vendor approvals.

Before implementing the affected integration, the technical lead and account owner must approve:

- Identity provider.
- Payment processor and merchant arrangement.
- Messaging providers.
- Hosting and recovery environment.
- Accounting connection.
- Hardware interfaces.

The implementing engineer must not silently choose a provider or create production accounts.

Unrelated domain work may proceed against tested adapters and synthetic fixtures.

### 5.3 Migration inventory

Inventory and classify:

- People.
- Households.
- Relationship evidence.
- Accounts.
- Programs.
- Seasons.
- Teams.
- Rosters.
- Future schedules.
- Attendance history.
- Results.
- Orders.
- Open obligations.
- Credits.
- Refunds.
- Documents.
- Communication preferences.

Preserve external identifiers and extraction provenance.

Names and emails are not reliable migration keys.

### 5.4 Import behavior

Imports must be repeatable.

Each batch must retain:

- Source.
- Timestamp.
- Checksum.
- Transformation version.
- Row outcomes.
- Validation errors.
- Review decisions.

Reimport must not execute charges or send historical notifications.

Ambiguous relationships and balances enter review queues.

### 5.5 Reconciliation

Verify:

1. Control totals.
2. Record identity.
3. Relationships.
4. Operational outcomes.

Compare active rosters, future schedules, capacity, obligations, credits, and results.

Do not net unrelated discrepancies to make totals appear correct.

Finance approves opening balances. Program and league owners approve active participation. Operations approves the schedule.

### 5.6 One authority during transition

Maintain an authority matrix for each record category and scope.

A synchronized copy does not become an independent writer.

Shared pitches require one effective scheduling authority across migrated and non-migrated activities.

Periodic imports alone cannot prevent conflicting reservations.

### 5.7 Cutover

The runbook must define:

- Final snapshot.
- Delta capture.
- Write freeze.
- Reconciliation.
- Payment routing.
- Schedule authority.
- Customer activation.
- Staff communications.
- Abort conditions.
- Named decision owner.

Disable conflicting execution before enabling the new authoritative workflow.

### 5.8 Recovery

Distinguish:

- Prelaunch abort.
- Software rollback.
- Data restoration.
- Recovery after real transactions.

Restoring an older database cannot undo payments or valid customer activity.

After live transactions, recovery must preserve journals, reconcile external facts, and explicitly hand back authority if necessary.

### 5.9 Proposed reliability targets

These are planning targets, not measured performance or contractual promises.

| Indicator                             | Proposed target                                                    |
| ------------------------------------- | ------------------------------------------------------------------ |
| Critical workflow availability        | 99.9% over rolling 30 days                                         |
| Staff lookup service latency          | p95 ≤ 750 ms                                                       |
| Online check-in response              | p95 ≤ 1 second                                                     |
| Published schedule visibility         | p99 ≤ 5 seconds in first-party views                               |
| Verified payment-event classification | p99 ≤ 10 seconds                                                   |
| Eligible automatic fulfillment        | At least 99.9% within 30 seconds after verified successful receipt |
| Transactional notice dispatch         | p95 ≤ 60 seconds to provider acceptance                            |
| Recovery point                        | ≤ 5 minutes for core operational data                              |
| Recovery time                         | ≤ 60 minutes for defined critical operations                       |

Report customer experience and provider dependency effects separately.

Creating an exception does not count as successful enrollment fulfillment.

### 5.10 Workload validation

Initial synthetic test envelope:

- 25,000 people.
- 100,000 historical enrollments.
- 1 million attendance and operational events.
- 250 active customer sessions.
- 20 active staff or scanner sessions.
- 50 simultaneous attempts competing for a final place.

These are test inputs, not facility facts or proven capacity.

Replace or enlarge them using actual operating evidence.

The workload manifest must also define arrival rates, workflow mix, duration, contention, infrastructure, and dependency failures.

### 5.11 Observability

Monitor:

- Registration completion.
- Payment-to-enrollment mismatch.
- Unknown financial outcomes.
- Refund reservations.
- Capacity anomalies.
- Schedule publication failures.
- Worker age and retries.
- Delivery failures.
- Assignment coverage.
- Stale readiness.
- Offline synchronization age.
- Import discrepancies.
- Access denials and suspicious activity.

Operational issues must have owners and supported resolution actions.

### 5.12 Production ownership

The complex must control or have documented access to:

- App Store and Google Play accounts.
- Merchant accounts.
- Domains.
- Hosting.
- Messaging accounts.
- Backups.
- Operational exports.
- Recovery instructions.
- Support contacts.

The exit path must be tested through representative export and restoration.

---

## 6. Acceptance, delivery, and decision register

### 6.1 End-to-end acceptance journeys

| ID         | Scenario                                          | Required outcome                                                             |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| SPK-AT-001 | Returning parent registers two children           | Correct permissions, prices, basket behavior, enrollments, and schedules     |
| SPK-AT-002 | New adult joins a team                            | Verification, approval, payment, roster, and placement remain understandable |
| SPK-AT-003 | Captain renews a team                             | New season records without changing historical participation                 |
| SPK-AT-004 | Two guardians register the same child             | One equivalent entitlement; payer privacy preserved                          |
| SPK-AT-005 | Final-place contention                            | At most one valid commitment                                                 |
| SPK-AT-006 | Payment succeeds after hold expiry                | No displaced waitlist offer; tracked valid fulfillment or compensation       |
| SPK-AT-007 | Concurrent partial refunds                        | No over-refund; uncertain execution retains reservation                      |
| SPK-AT-008 | Whole pitch and subdivision publish concurrently  | At most one conflicting reservation commits                                  |
| SPK-AT-009 | Field closure affects youth and adult activities  | Complete impact preview, approved resolution, consistent publication         |
| SPK-AT-010 | Odd-team season generation                        | Correct byes and complete fixture obligations                                |
| SPK-AT-011 | Fairness constraints conflict                     | Explain limitations; no false optimality or feasibility claim                |
| SPK-AT-012 | Referee declines shortly before kickoff           | Uncovered assignment, replacement workflow, readiness update                 |
| SPK-AT-013 | Suspended player is added as a substitute         | Applicable restrictions enforced                                             |
| SPK-AT-014 | Official result changes after playoff publication | History retained; downstream review required                                 |
| SPK-AT-015 | Parent arrives with one of two children           | Only the actual child and selected session recorded                          |
| SPK-AT-016 | Adult may pay but may not collect                 | Pickup denied or escalated under approved procedure                          |
| SPK-AT-017 | Coach loses access while messages are queued      | New protected access and unsent dispatch re-evaluated                        |
| SPK-AT-018 | Device works offline then reconnects              | Observations synchronize once; stale authority is not asserted               |
| SPK-AT-019 | Trial converts to term participation              | Separate trial history and paid entitlement                                  |
| SPK-AT-020 | Makeup or package redeemed concurrently           | At most one permitted redemption                                             |
| SPK-AT-021 | Turf restriction closes a subdivision             | Correct booking impact; authorized reopening                                 |
| SPK-AT-022 | Team contributions exceed remaining amount        | Approved overpayment handling with reconciled allocation                     |
| SPK-AT-023 | Worker stops after registration commit            | Durable follow-up resumes without duplicate effects                          |
| SPK-AT-024 | Migration snapshot imported twice                 | Stable identities, no repeated charges or messages                           |
| SPK-AT-025 | Customer account recovered                        | Only verified prior access restored                                          |
| SPK-AT-026 | Assistant receives an unauthorized request        | No protected disclosure or privileged action                                 |
| SPK-AT-027 | Old mobile app contacts updated API               | Supported behavior or clear update requirement                               |
| SPK-AT-028 | Backup restored after external transactions       | External facts reconciled before normal operations resume                    |

### 6.2 Native acceptance

Test signed builds on physical iOS and Android devices.

Required scenarios include:

- Fresh installation.
- Account verification.
- Interrupted onboarding.
- Expired session.
- App backgrounding during payment.
- Payment return.
- Deep links.
- Push permission denied.
- Notification opened after its event changes.
- Poor connectivity.
- Native sharing.
- Camera permission denied.
- VoiceOver and TalkBack.
- Large text.
- Update from a prior supported build.

A web preview or successful bundle export does not satisfy these requirements.

### 6.3 Staff acceptance

Use actual expected workstation, tablet, and scanner configurations.

Operators must complete:

- Assisted family registration.
- Season setup.
- Roster correction.
- Schedule publication.
- Closure handling.
- Arrival and attendance.
- Referee replacement.
- Result correction.
- Financial reconciliation.
- Export.
- Outage procedure.

Measure task completion, errors, time, and assistance required.

### 6.4 Competitive proof

Benchmark realistic workflows:

1. Returning family registration.
2. Team creation and player invitations.
3. Team contribution collection.
4. Season construction.
5. Field-closure recovery.
6. Busy arrival period.
7. Financial exception resolution.
8. Season renewal.

Use comparable inputs and disclose differences in setup or scope.

Proposed improvement targets must be set after baseline measurement. Do not invent percentage improvements in advance and report them as achieved.

### 6.5 Delivery sequence

#### Package A — Operating model and specification baseline

Deliver:

- Requirement cross-reference.
- Facility inventory.
- Policy register.
- Role matrix.
- Integration inventory.
- Authority matrix.
- Representative adult and youth journeys.
- Acceptance fixtures.

**Gate:** unresolved decisions are owned and their affected workflows identified.

#### Package B — Production foundation

Deliver:

- Organization-scoped model.
- Managed identity integration.
- Relationship permissions.
- Versioned migrations.
- Command contracts.
- Audit.
- Durable operations and workers.
- Security boundaries.

**Gate:** authorization, replay, and recovery tests pass.

#### Package C — Soccer scheduling and competition

Deliver:

- Resource configurations.
- Conflicts and closures.
- Draft publication.
- Seasons and divisions.
- Rosters.
- Fixtures.
- Results and standings.
- Assignments.
- Match readiness.

**Gate:** a representative operating week and complete season can be created and corrected.

#### Package D — Registration and money

Deliver:

- Catalog publication.
- Quotes.
- Family baskets.
- Capacity holds.
- Approval.
- Waitlists.
- Real test-provider payments.
- Team obligations.
- Applicable installments.
- Refunds, credits, and transfers.
- Reconciliation.

**Gate:** concurrency and uncertain-payment scenarios pass.

#### Package E — Complete customer and daily operations

Deliver:

- Native customer journeys.
- Captain workspace.
- Family calendar.
- Coach and referee workspace.
- Arrival and attendance.
- Pickup when applicable.
- Communications.
- Support.
- Maintenance.

**Gate:** representative customers and operators complete connected tasks on actual devices.

#### Package F — Controlled live pilot

Proposed initial pilot: one complete adult-league workflow and one complete youth-program workflow, subject to operator confirmation.

Deliver:

- Rehearsed import.
- Reconciliation.
- Single scheduling authority.
- Staff training.
- Support coverage.
- Monitoring.
- Backup restoration.
- Cutover and recovery runbooks.

**Gate:** named owners accept the operating evidence and explicitly authorize launch.

#### Package G — Full facility operation and differentiation

Complete applicable:

- Rentals.
- Pickup.
- Memberships.
- Packages.
- Parties.
- Tournaments.
- POS.
- Accounting.
- Hardware.
- Youth progression.
- Advanced fairness.
- Retention tools.
- Reviewable operational assistance.

The sequence reflects dependencies. It does not remove these capabilities from the whole-product vision.

### 6.6 Operator decisions

| Decision                                           | Required owner                | Must be resolved before    |
| -------------------------------------------------- | ----------------------------- | -------------------------- |
| Actual facilities, spaces, subdivisions, hours     | Operations                    | Scheduling acceptance      |
| Soccer formats and competition rules               | League manager                | Competition release        |
| Youth eligibility, capacity, staffing, progression | Program manager               | Youth workflow release     |
| Guardian verification and child-account policy     | Operator/privacy owner        | Protected family access    |
| Pickup and outage procedure                        | Operations                    | Supervised program launch  |
| Waitlist, holds, approvals, basket behavior        | Product and operations        | Registration acceptance    |
| Prices, taxes, discounts, rounding                 | Finance                       | Financial release          |
| Team liability, installments, overpayments         | Finance and league manager    | Team billing release       |
| Refunds, credits, transfers, cash                  | Finance                       | Correction workflows       |
| Discipline and appeals                             | League manager/operator       | Discipline enforcement     |
| Official qualifications and fees                   | Operations/finance            | Workforce release          |
| Public information and communication policy        | Operator/privacy owner        | Publication and messaging  |
| Providers and production accounts                  | Technical lead/account owners | Integration implementation |
| Migration scope and writer authority               | Migration owner/operator      | Cutover                    |
| Support, workload, service objectives              | Technical lead/operator       | Live readiness             |
| Conditional capability applicability               | Product owner                 | Affected package planning  |
| Budget, dates, acceptance authority                | Sponsor                       | Delivery commitment        |

Each decision record must keep separate:

- Answer status: unknown, answered, not applicable.
- Proposal status: proposed, approved, rejected, superseded.
- Named owner.
- Effective date.
- Affected scope.
- Supporting evidence.
- Target date for unresolved items.

“No answer yet” must never be interpreted as “not applicable.”

### 6.7 Specification and handoff artifacts

The maintained project documentation must include:

- Master specification.
- Domain model and relationship diagram.
- Screen and journey inventory.
- API and event schemas.
- Permission matrix.
- Policy and decision register.
- Requirement-to-test matrix.
- Integration capability register.
- Migration mappings and authority matrix.
- Metric dictionary.
- Native acceptance matrix.
- Operational runbooks.
- Release evidence ledger.

The operator questionnaire remains the mechanism for collecting business evidence. It does not replace the engineering specification.

All documents must distinguish verified implementation, proposed behavior, and pending decisions.

### 6.8 Definition of done

A capability is complete only when:

1. Its applicable policies are approved.
2. Customer and staff paths work together.
3. Permissions are enforced server-side.
4. Consequential writes are safe under concurrency and retry.
5. Error and recovery states are understandable.
6. Financial and operational records reconcile.
7. Required follow-up survives interruption.
8. Native and staff-device behavior is verified.
9. Monitoring and support actions exist.
10. Operators complete representative acceptance tasks.
11. Evidence identifies the build and environment.
12. Release ownership is explicit.

Critical defects involving protected data, financial execution, capacity, physical resource conflicts, or supervised release block the affected launch scope.

### 6.9 Final product outcome

The complete product must let:

- A player manage participation confidently.
- A captain run a team with minimal administrative effort.
- A parent coordinate children without fragmented records.
- A coach prepare, teach, and record progress.
- A referee manage assignments and report matches.
- Front-desk staff resolve arrivals quickly.
- Managers publish dependable schedules.
- Finance explain and reconcile every obligation and movement of money.
- Facilities staff connect maintenance to availability.
- Ownership understand demand, utilization, retention, and operating performance.

All of these experiences must use the same authoritative records and controlled business workflows.
