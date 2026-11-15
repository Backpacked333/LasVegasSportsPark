# Security review: amendments PA-01 to PA-10, public views and demo mode

**Date:** 2026-11-14
**Branch reviewed:** `claude/jolly-johnson-gd61vv` at `a4fb2e37`, against `main` (merge base `b1d1c2e`)
**Method:** read-only review of the diff (`apps/api`, `packages/contracts`, `packages/db/migrations`,
the public pages of `apps/staff`, the demo and development sign-in paths, `scripts/demo.mjs`). No
build, no test run, no request was made against a running service. Every finding marked
**Confirmed** was traced in the code quoted; nothing was reproduced at runtime. Findings marked
**Suspected** say what would confirm them.

## Summary

No critical or high finding was confirmed. The branch is consistent about the things the
engineering rules ask for: every new reference is an organization-scoped composite foreign key,
the replaced database triggers keep every rule of the functions they replace, capability switches
are checked server-side inside the unit of work for every new write, prices are computed from
catalog and ledger facts and never from a client-sent amount, and the second approval of an
open-amount line is enforced by the database as well as the service.

The findings that matter:

| Severity      | Count |
| ------------- | ----- |
| Critical      | 0     |
| High          | 0     |
| Medium        | 4     |
| Low           | 7     |
| Informational | 7     |

1. **M-1** A renter can put any person whose id they know on a rental roster, read that person's
   display name and liability-waiver status, and mark them "joined" by accepting the invitation
   themselves with the token the invite command returned.
2. **M-2** The rule that keeps competitions for under-18 players private is a word list and a
   regular expression that fails open: "12U", "U12s", "Under 12", "Teen", "High School", an age
   in the competition or season name, or simply no age criteria all pass.
3. **M-3** The `public_views` rate limit is keyed on `request.ip`. Behind a proxy with
   `TRUST_PROXY` unset every visitor shares one bucket (one scraper blanks every lobby display);
   with `TRUST_PROXY=true` behind a proxy that appends to `X-Forwarded-For` the limit is bypassed
   by sending the header. Nothing refuses either configuration at boot.
4. **M-4** The open-amount ceiling is per line only. Any number of lines just under the ceiling
   can be entered on one sale with no second approval.

## Findings

### Medium

#### M-1 Rental roster: a person named by id is exposed to, and can be joined by, the renter

**Status:** Confirmed (code trace).
**Files:**
`apps/api/src/modules/enrollment/services/booking-rosters.service.ts:292-327` (invite),
`:419-450` and `:467-476` (accept), `:696-710` (recipientCheck), `:1043-1061`, `:1084`,
`:1091-1094` (member views);
`packages/contracts/src/api/enrollment-rosters.ts:140-156`.

**What can be done.** The renter of a live rental booking is a customer. With `rental_rosters` on:

1. `POST /v1/bookings/{id}/roster/invitations` accepts `recipientPersonId` from the renter with no
   relationship check; the only test is that the person is an active person of the organization:

   ```ts
   const recipient = await this.persons.findPerson(organizationId, body.recipientPersonId, trx);
   if (!recipient || recipient.status !== 'active') {
     throw errors.notFound('person', body.recipientPersonId);
   }
   ```

   A 404 for an unknown id against a 201 for a known one is an existence oracle for person ids.

2. The roster read then returns, for that `invited` row, the person's display name and, while
   `liability_waivers` is on and the offering requires a waiver, their waiver status. Only
   removed rows and rows without a person are excluded:

   ```ts
   const personIds = [...new Set(rows.map((r) => r.person_id).filter((id) => id !== null))];
   ...
   waiverStatus:
     row.status === 'removed' || row.person_id === null
       ? 'not_evaluated'
       : (statusOf.get(row.person_id) ?? 'not_evaluated'),
   ```

   So a customer who knows a person's id (an adult or a child) learns the name and whether that
   person has a current, lapsed or missing liability waiver, without that person doing anything.

3. The invite command returns the invitation token to the inviter. `accept` lets "the person it
   names, or the holder of its token" through (`recipientCheck`: `if (!named && !holdsToken)`),
   and for an invitation that names a person only checks that the _joiner_ is the caller:

   ```ts
   const joiner = body.personId ?? actorPersonId;
   ...
   if (found.recipient_person_id) {
     if (!selfIds.includes(joiner)) { throw errors.validation('This invitation names you. ...
   ```

   It never checks that the caller is the named recipient. The roster row then keeps the named
   person: `person_id: member.person_id ?? person.id`. The renter can therefore accept their own
   invitation with the token and the named person becomes `joined`
   (`accepted_by_person_id` records the renter). This contradicts the stated rules "an invitation
   that names a person is accepted by that person" and "nobody is put on a list without their
   own say".

The invitation also carries a free-text `message` (up to 1000 characters) that the named person
sees under `GET /v1/me/booking-roster-invitations`, from any renter to any person id.

**Precondition.** Person ids are UUID v7 and are not guessable; the renter needs one. Ids of
other people do reach customers in existing responses (for example `invitedByPersonId` and
`addedByPersonId` here, team rosters elsewhere).

**Fix.**
- In `accept`, when `recipient_person_id` is set, require
  `selfIds.includes(invitation.recipient_person_id)`; the token must not stand in for the named
  person. Add a database check in `booking_roster_invitations_guard` that an accepted invitation
  naming a person has `accepted_by_person_id = recipient_person_id` (or a guardian decision made
  explicit).
- For a non-staff inviter, do not resolve a person id at all, or restrict it to the caller's own
  subjects; answer an unknown, inactive and unrelated id identically.
- Show a row's display name and waiver status to the renter only once the row is `joined`; show
  an `invited` row as "invitation pending".

#### M-2 The under-18 publication rule fails open

**Status:** Confirmed (code reading). The rule is labelled a proposed default pending DEC-100.
**Files:** `apps/api/src/modules/competition/public/public-competition.service.ts:50-76`
(`describesMinors`), `:464-493` (`isShown`, `minorDivisions`), `:374-381` (publish refusal).

**What can happen.** A competition is refused publication, and hidden on every public read, only
when one of its _divisions_ "describes minors":

```ts
const MINOR_WORDS =
  /\b(youth|junior|juniors|kid|kids|boy|boys|girl|girls|child|children|minor|minors)\b/i;
const UNDER_AGE = /\bu[-\s]?(\d{1,2})\b/i;
...
if (band && (band.minAge !== null || band.maxAge !== null)) {
  if (band.minAge === null || band.minAge < PUBLIC_ADULT_AGE) return true;
}
const words = [division.name, criteria.level, criteria.category].filter(Boolean).join(' ');
```

- A division with no age band and a neutral name is treated as adult ("A division with no age
  criteria at all describes nobody under 18"). Age bands are optional in
  `DivisionCriteriaSchema` (`ageBand ... .nullable().default(null)`).
- `UNDER_AGE` misses the common spellings: `12U`, `U12s` (no word boundary after the digits),
  `Under 12`, `Under-12s`, birth-year names (`2015 Coed`). `MINOR_WORDS` misses `teen`,
  `high school`, `middle school`, `elementary`, `jr`, `academy`, `grade 5`, `ages 8-10`.
- Only division name, level and category are read. The competition name and the season name are
  never examined, so "Youth Spring League" with divisions "Gold" and "Silver" publishes.
- A competition with no divisions yet publishes.

Once published, the anonymous surface shows the team names, opponents, times and field names of
the competition (`seasonView`), and the facility day schedule titles its games with the team
names (`fixtureTitles`). For a youth competition that is where named children's teams will be,
and when.

**Fix.** Fail closed: publish only when every division of every season has an age band with
`minAge >= 18` (an explicit adult statement), or when a permitted role records an explicit
"adult competition" attestation that is audited. Keep the word list as an additional refusal,
extend it to the competition and season names, and treat missing criteria as not publishable.
Enforce the stored attestation with a database check rather than a text heuristic.

#### M-3 Public rate limit keys on an address that is shared or caller-supplied behind a proxy

**Status:** Confirmed in code; the impact depends on the deployment.
**Files:** `apps/api/src/kernel/http/rate-limit.ts:137-156`, `apps/api/src/kernel/app-setup.ts:75`,
`apps/api/src/kernel/config.ts:181-198`, `docs/deploy/staging.md:63`.

```ts
const address = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
const decision = await this.limiter.consume(`${name}:${address}`, rule, this.clock.now());
```

- `TRUST_PROXY` is optional and unset by default ("forwarded headers are ignored"). Behind any
  load balancer the address is then the balancer's, so all anonymous visitors share one
  `public_views` bucket of 120 requests a minute. One scraper, or a handful of lobby displays and
  public pages refreshing every 30 seconds, exhausts it; every other display then shows "Please
  wait a moment". The same applies to the `claims`, `invitations` and `dev_tokens` buckets.
- `TRUST_PROXY=true` (the value `docs/deploy/staging.md` gives) makes Express take the left-most
  `X-Forwarded-For` entry. On a host that overwrites the header this is correct; behind a proxy
  that appends, the caller chooses the key, the limit is bypassed and each forged address adds a
  row to `rate_limit_buckets` (pruned hourly per process, rows a day old).
- The production configuration checks (`ConfigSchema.superRefine`) refuse many unsafe settings
  but say nothing about `TRUST_PROXY`.

The limit is applied to every route this branch marks public (class-level
`@RateLimited('public_views')` on both public controllers, read with `getAllAndOverride` on
handler and class, and `RateLimitGuard` is registered before `AuthGuard`).

**Fix.** In production require `TRUST_PROXY` to be set explicitly and refuse `true` (accept a hop
count or subnets only), as the production guide already describes. Consider a second, larger
bucket keyed on organization slug so one address cannot starve a whole organization's displays,
and serve the public reads from a short server-side cache so a burst costs no standings
computation.

#### M-4 The open-amount ceiling is evaded by splitting

**Status:** Confirmed (code reading; no aggregate rule in service or database).
**Files:** `apps/api/src/modules/finance/services/pos/pos-open-amount.service.ts:141-164`,
`packages/db/migrations/0695_finance_pos_open_amount_lines.sql` (constraint
`pos_sale_lines_open_amount_ceiling`), `0696_finance_pos_line_approvals.sql`
(`pos_sale_awaits_line_approval`).

```ts
const ceiling = openAmountCeiling(principal, sale.facility_id, rules);
...
const approvalRequired = input.amountMinor > ceiling;
```

The comparison is one line against the ceiling, and the database repeats exactly that
(`approval_required = (unit_price_minor > approval_ceiling_minor)`). Nothing sums the
open-amount lines of a sale, of a register session or of a person per day. A desk user whose
ceiling is 50.00 enters ten lines of 50.00 on one sale and takes tender with no second person.
The review list (`GET /v1/pos-register-sessions/{id}/open-amount-lines`) shows them afterwards,
which is detection, not prevention.

What is sound here: the entering person cannot approve their own line by any path found (service
check and trigger `pos_line_approvals_second_person`; the approval insert and the tender insert
both lock the sale row; one approval per line is unique; a changed amount is a new line judged
again; a line is only ever removed as entered; no tender and no `paid` transition while an
approval is outstanding; amounts are positive in contract and database).

**Fix.** Judge the ceiling against the sum of the open-amount lines in effect on the sale
entered by the same person (and optionally the session), in the service and in the
`pos_sale_lines` trigger, so the line that takes the sum above the ceiling needs the approval.
State the chosen aggregate in the policy content (DEC-102).

### Low

#### L-1 Roster invitation token is kept in clear with the idempotency record

**Status:** Confirmed.
**Files:** `apps/api/src/modules/enrollment/controllers/booking-rosters.controller.ts:65-76`;
compare `apps/api/src/modules/identity/controllers/invitations.controller.ts:33-34`,
`apps/api/src/modules/competition/controllers/roster.controller.ts:67`;
`apps/api/src/kernel/http/idempotency.interceptor.ts:403-415`.

The service stores only `token_hash`, but the route is plain `@Idempotent()`, so the response
body, token included, is written to `idempotency_keys.response_body` for
`IDEMPOTENCY_TTL_HOURS` (24 by default). Every other token-issuing route uses
`@Idempotent({ withhold: ['token'] })` with the comment "the invitation token is stored only as
a hash; never keep it with the idempotency key".

**Fix.** `@Idempotent({ withhold: ['token'] })` on `invite`.

Related, same area:
- `GET /v1/booking-roster-invitations/{id}?token=...` carries the token in the query string
  (`booking-rosters.controller.ts:96-103`). The API's own access log drops query strings, but a
  proxy or browser history will not. Prefer a header or a POST body.
- A contact invitation is accepted by any signed-in person of the organization who holds the
  token; it is not matched to a verified contact point (documented in the service; staff
  invitations in `staff-access.service.ts` do match a verified email). Acceptable while a roster
  grants nothing, but worth stating in DEC-103.
- Token comparison is `hashToken(token) === row.token_hash` (not constant time). With a 256-bit
  random token hashed with SHA-256 this is not practically exploitable; noted for consistency
  with `timingSafeEqual` used elsewhere.

#### L-2 Public codes are published by the directory, so they are identifiers, not secrets

**Status:** Confirmed.
**Files:** `apps/api/src/modules/competition/public/public-competition.service.ts:109-137`,
`:386` ; `apps/api/src/modules/scheduling/public/public-schedule.service.ts:180-197`, `:250`;
`packages/db/migrations/0470_competition_public_visibility.sql`.

Codes are 96 random bits from `crypto.randomBytes` and unique per table, which is sound against
guessing. But `GET /v1/public/{organization}/directory` lists the code of every enabled facility
schedule and every shown competition to anyone who knows the organization slug, and the
competition view lists the season codes. Consequences:

- "Issue a new code, so links shared before stop working" (`newCode` on the facility view) does
  not withdraw access: the new code is in the directory. Only disabling does.
- There is no "enabled but unlisted" state, although the audit record deliberately omits the
  code as "the key to the view".
- Competition and season codes cannot be rotated at all
  (`public_code: competition.public_code ?? newPublicCode()`; the migration comment says a
  shared link "works again if the competition is made public again").

**Fix.** Decide and document that enabled means world-readable, and drop the language that
treats the code as a key; or add a `listed` flag per view and competition so the directory shows
only what the operator chose to list, and add a rotate command for competition and season codes.

#### L-3 The public schedule answers for any date

**Status:** Confirmed.
**Files:** `apps/api/src/modules/scheduling/public/public-schedule.service.ts:82-137`,
`packages/contracts/src/api/scheduling-public.ts:76-79`.

`date` is any valid calendar date. An anonymous caller can walk the facility's whole history and
every future day and collect, per field, every occupied interval including private bookings
(shown as "Reserved"). No name is shown, but a recurring private rental's pattern is, and the
whole forward booking state of the facility is available to a competitor. A lobby needs today; a
public page needs a short window.

**Fix.** Bound `date` to a policy window around today in the facility's zone (for example 1 day
back and 14 to 30 days ahead) and answer the same "not available" outside it.

Also in this read: `resources` are every resource that is not `closed`; if internal rooms are
modelled as resources their names appear in `fields`. Suspected only; confirm against how
resources are used in practice and add a "shown publicly" attribute if needed.

#### L-4 Waiver override: unresolved activities carry no facility scope and never lapse

**Status:** Confirmed (code reading).
**Files:** `apps/api/src/modules/catalog/services/waivers.service.ts:145-150`, `:425-461`;
`apps/api/src/modules/catalog/services/waiver-status.reader.ts:247-271`;
`apps/api/src/kernel/authorization/authorization.service.ts:63-65`.

- For activity types `scheduling_event` and `booking`, `activityFacility` returns `null` and the
  id is "recorded as a reference and not resolved here". The authorization target then has no
  `facilityId`, and the kernel treats a target without a facility as in scope
  (`!target.facilityId || scopeCoversFacility(...)`). A staff member scoped to one facility can
  record an override for a booking or event of another facility, or for an id that names
  nothing.
- The override that lifts a block is "the newest override recorded for the person, the family
  and any of the activities". It is not tied to the waiver version in force when it is read and
  has no end: an override for an offering lifts the block for that person for the life of the
  offering, across later waiver versions whose `overrideRoles` may differ.

**Fix.** Resolve bookings and events through their modules' ports (existence and facility)
before authorizing; refuse an unknown activity. Match an override to `policy_version_id` (or
give overrides an expiry) so a new version asks again.

#### L-5 Existence oracles on new authenticated routes

**Status:** Confirmed. Ids are UUID v7, so these are low value, but they depart from the "never
reveal existence" rule.

- `apps/api/src/modules/competition/services/team-waitlist.service.ts:561-577`: an existing team
  entry answers 403 "Only the captain or league staff read the offers of an entry", an unknown
  one 404.
- `apps/api/src/modules/enrollment/services/uniform-orders.service.ts:292-308`:
  `errors.notFound('uniform_order', id)` before authorization; a customer gets 404 or 403
  depending on existence.
- `apps/api/src/modules/catalog/services/waivers.service.ts:243-262`: a draft or archived
  offering answers 403 to a customer, an unknown one 404.
- `booking-rosters.service.ts:318-325`: see M-1 (person id).

**Fix.** Authorize first where the target is known from the principal, and answer
`errors.protectedNotFound(...)` for the not-permitted case on customer-reachable routes.

#### L-6 A scheduled message for a season is not bound to the sender's facility scope

**Status:** Confirmed; consistent with the existing compose path, so not a regression.
**Files:** `apps/api/src/modules/communications/sequences/message-schedule.service.ts:323-349`
(generate authorizes a target without a facility), `:710-728` (matching sequences),
`:1127-1150` (`lockForStaff` authorizes at the sequence's facility), `:1023-1037` (send as the
system principal).

A season has no facility; a sequence does. A sequence manager scoped to facility A creates a
season sequence at A with no scope id, generates the schedule of any season of the organization,
edits the text and confirms. The message goes to every approved team of that season, composed by
the system principal, so the audience authorization of the ordinary compose path
(`requireAudience`) is not consulted. The roles are managers, the text is audited with who
confirmed it, and consent and preferences are still applied at send time by the notification
path.

**Fix.** Decide in DEC-099 whether a facility-scoped manager may address a season's teams. If
not, derive the facilities a season plays at (its fixtures' venues) and require the confirmer's
scope to cover them, or require an organization-wide role for season sequences.

#### L-7 Demo launcher inherits the caller's environment and listens on every interface

**Status:** Confirmed; development-only.
**Files:** `scripts/demo.mjs:54-61`, `apps/api/src/main.ts:24`.

`pnpm demo` forces `NODE_ENV=development`, `AUTH_MODE=local`, a random `AUTH_LOCAL_SECRET`, a
separate PGlite directory, and deletes `DATABASE_URL`, so it cannot point at a real database:
that part is sound. It spreads the rest of `process.env` into the API (provider selectors,
`TRUST_PROXY`, `CORS_ALLOWED_ORIGINS`, `DEV_TOKENS_PASSCODE`), and the API listens on all
interfaces (`app.listen(config.PORT)`), with `/v1/dev/tokens` open to private-network callers
when no passcode is set. On a shared network during a walkthrough, a neighbour who learns an
account id can mint a token for the sample data. Sample data only.

**Fix.** Build the demo environment from an allow-list instead of `...process.env`, and bind the
demo API to `127.0.0.1` unless `--mobile` is given.

### Informational

- **I-1 Signed-in tabs send the bearer token to public routes.** The public pages use the shared
  API client, which attaches `Authorization` whenever a session is in the tab
  (`packages/api-client/src/client.ts:208-209`). `AuthGuard` verifies a presented token even on
  a `@Public()` route (`apps/api/src/kernel/auth/auth.guard.ts:39-41`), so an expired staff
  token turns a public page into a 401 and signs the tab out. The session lives in
  `sessionStorage` and the kept public answer in `localStorage` under `public-view:*`; they do
  not mix, and the kept answer is cleared on "not available". Use a client without a session for
  the public routes.
- **I-2 The kept lobby answer has no maximum age.** While offline the display shows the last
  answer indefinitely, labelled with when it was computed
  (`apps/staff/src/screens/public/usePublicView.ts`). A view disabled while the display is
  offline stays on screen until the display reconnects.
- **I-3 Text on the public surface is typed by people.** Team names (typed by captains),
  competition, season, division, offering, facility and field names are shown as stored. React
  escapes them, and no server string is injected as HTML (the one `dangerouslySetInnerHTML`,
  `apps/staff/src/ui/glass/Glass.tsx:143`, is built from numeric props). The ADR's statement
  that only system-generated titles are shown is true of event titles, not of these names; a
  team named after a person appears publicly.
- **I-4 Pairings are public before they are scheduled.** `seasonView` returns every fixture of
  the season, including `unscheduled` ones (teams and round, no time). Times appear only once
  the scheduling event is published (`fixtures.service.ts:518-548`).
- **I-5 Public reads compute on every request.** The season view computes one standings table
  per division per anonymous request; only the HTTP `Cache-Control: public, max-age=30` and the
  rate limit stand in front of it. See M-3.
- **I-6 Source maps and the bundle check.** `apps/staff/vite.config.ts` builds with
  `sourcemap: true`; `scripts/check-release-bundle.mjs` scans `.js`, `.mjs`, `.html` and `.css`
  but not `.map`. Demo sources are outside a real build's module graph, so nothing was found
  wrong; scan the maps too, or do not publish them. A staging build (`VITE_STAGING=true`) keeps
  the development sign-in and is by design built without the check: `pnpm build` fails on it,
  a bare `vite build` does not.
- **I-7 Price facts are fixed at the quote.** The member price is decided by a confirmed,
  unsuspended membership at the quote instant and holds for the life of the quote and of the
  purchase; a membership refunded afterwards does not reopen the price (DEC-098). A tier has no
  eligibility beyond its purchase deadline and session bounds, so a customer may name any tier
  of the rule in effect (DEC-097). Both are stated proposed defaults.

## Checked and found sound

**Unauthenticated surface**
- Routes this branch marks `@Public()`: `GET /v1/public/{organization}/schedule/{code}`
  (`scheduling/public/public-schedule.controller.ts`), `.../directory`, `.../competitions/{code}`,
  `.../seasons/{code}` (`competition/public/public-competition.controller.ts`), and
  `GET /v1/metrics` (token in a header, constant-time compare, route absent without
  `METRICS_TOKEN`). No other new public route.
- The public contracts (`packages/contracts/src/api/scheduling-public.ts`,
  `competition-public.ts`) have no field for a person, booker, contact or record id; the services
  build each answer field by field from dedicated queries. Rental, party, maintenance and block
  events are never titled; stored event titles are never read.
- One answer for unknown organization, malformed slug or code, unknown code, disabled view,
  capability off, unpublished or archived competition and minor-division competition: 404
  `PUBLIC_VIEW_NOT_AVAILABLE`, `no-store` (the cache header is set only after success). Path
  parameters are accepted as any string so no validation message describes a code.
- Codes: `randomBytes(12)`, unique index per table, shape check in the database.
- Disable and unpublish are never capability-gated; enable and publish are.

**Cross-organization**
- Every query in the new services reviewed filters on the principal's `organization_id`; every
  foreign key in the 34 new migrations is `(organization_id, ...)` composite (checked by
  listing every `references` clause).

**Waivers** (`catalog/services/waivers.service.ts`, `acknowledgments.service.ts`,
`waiver-status.reader.ts`, migration 0220)
- Person read is `protected: true` with self or `complete_forms`; overrides are staff-only in
  the answer. Acceptance goes through the existing signing path; paper is staff-only in service
  and database; the signing time is the server's; a digital acceptance must be of the version in
  force. Nobody overrides for themselves (service and check constraint). `waiver_overrides` is
  append-only. The replaced `acknowledgments_guard` only adds columns to the immutable set.

**Team waiting list** (`competition/services/team-waitlist.service.ts`, migration 0467)
- Accept and decline require league staff or the entry's captain (`teamRole: 'captain'`,
  `protected: true`), inside the unit of work under entry and offer locks; expiry is checked at
  accept; one open offer per entry; an open offer counts against capacity. The replaced
  `team_entries_check_division_capacity` keeps every rule of 0400 and adds held places.

**Uniforms** (`enrollment/services/uniform-orders.service.ts`, migration 0523)
- List and hand-over are staff-only at the offering's facility; names are read after
  authorization; "already holds the uniform" is derived server-side, not sent by the client.

**Open-amount lines** (see M-4 for what is not sound)
- Second-person rule, approval-before-tender and paid-transition guards in the database; the
  0686 and 0695 replacements of `pos_sale_lines_apply` keep every rule of the function they
  replace (compared line by line).

**Pricing** (`finance/pricing/line-pricing.service.ts`, `quote-calculator.ts`,
`enrollment/services/registration-extras.ts`, `membership-pricing.ts`, migrations 0211, 0215,
0216, 0217, 0521, 0522, 0687, 0690, 0691)
- No client-sent amount enters a quote. Tier, sessions counted, member standing, add-on and
  uniform prices are read from catalog and the membership ledger at the quote instant and stored
  as the line's basis. Add-on quantity is the number of selected sessions the participant
  attends. Checkout refuses an expired quote and a basket that no longer matches its quote lines
  (including extras). Basket lines are not edited in place. `price_rules_guard` replacement adds
  the new columns to the immutable set. Extra lines are unique per source and must name an
  add-on or uniform of their offering.

**Capability gating**
- Every new write checks its capability with `capabilities.require(..., trx)` inside the unit of
  work: waivers (accept, override, set required, draft a waiver policy), price rule fields,
  tiers, add-ons, uniforms, basket selections, quotes of gated lines, message templates,
  sequences, schedule commands and the sending job, public view enable and publish, open-amount
  enter and approve, roster add, invite and accept, team wait, offer and accept. Unwinding
  commands (disable, unpublish, decline, revoke, remove, skip) are deliberately ungated. Public
  reads answer "not available" while off.

**Messages** (`communications/sequences/*`, migration 1013)
- Placeholders are filled in one pass from a fixed vocabulary; a value containing `{{` or `}}`
  or an unfillable placeholder refuses confirmation, and a database check refuses a confirmed
  text with placeholder marks. Nothing unconfirmed is sent. The job claims a row with
  `FOR UPDATE SKIP LOCKED`, re-reads status and due time, and marks it sent in the same
  transaction that queues the notification, so two workers do not send twice. Recipients,
  consent and preferences are resolved by the notification path at send time; an offering
  audience is marked protected.

**Demo mode and development sign-in**
- Staff: demo imports are behind the build-time literal `__DEMO__`; the development sign-in is
  behind `import.meta.env.DEV` or `VITE_STAGING`; `pnpm build` runs the bundle check with demo
  markers added. Mobile: demo modules are required only under `__DEV__`; markers added to the
  bundle check. API: `AUTH_MODE=local` refuses to boot in production; `/v1/dev/tokens` is
  guarded, rate limited, passcode-compared in constant time and refuses forwarded requests
  without a passcode; `assertSeedAllowed` refuses production and non-local identity.

**Secrets and logging**
- No secret or credential was found in the new code. The access log drops query strings and
  replaces UUIDs. Public codes are not written to audit records or events.

## Not examined

- Nothing was run: no test suite, no build, no request against a live service, no inspection of
  a built bundle. The bundle-check and tree-shaking claims are from reading configuration only.
- Identity changes on this branch outside the ten amendments: staff invitations and access
  reviews (`identity/services/staff-access.service.ts`), care notes, migration 0181. Skimmed for
  authorization calls only.
- Other new reads outside the ten amendments: `finance-desk.service.ts` (person money, payment
  reminders), `enrollment-overview.service.ts`, reporting additions, facilities release
  checklist, workforce replacements, support customer replies. Authorization calls were listed,
  not traced.
- Refund, cancellation and transfer arithmetic for add-on and uniform order lines
  (`finance-policy.adapter.ts` beyond its queries), and POS returns of open-amount lines.
- The waiver gate at registration and at arrival (`entry/services/arrival-checks.ts`,
  `registration-evaluator.ts`): whether a blocking waiver can be bypassed there.
- The mobile app's public views and invitation screens (`apps/mobile/src/screens/public`), and
  the staff screens other than `screens/public`.
- Kernel changes on this branch beyond rate limiting, response headers and configuration checks
  (OIDC verifier, JSON logger, metrics snapshot, inline worker, backup and restore CLI).
- The standings computation used by the public season view (which entries and results count).
- Timing differences between the "not available" branches (one to three queries); not measured.
- Hosting configuration (`apps/api/vercel.json`, `docs/deploy/*`) beyond the `TRUST_PROXY` rows.
