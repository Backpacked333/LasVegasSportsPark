# identity module

**Owns:** persons, contact points, login accounts, households, relationships, access grants,
invitations, claims, staff memberships, disputed-access reviews, duplicate candidates, person merges

**Specification:** §3.1 (SPK-IAM-001..007 and acceptance examples), §4.4 Identity, §4.5
(`Person.householdId` cannot determine authority), §4.14, SPK-AT-004, SPK-AT-025

**Migration range:** `packages/db/migrations/0100_identity_core.sql` … `0199` (present: `0100`,
`0101_identity_invitation_subjects`, `0102_identity_suspension_window`,
`0103_identity_grant_suspensions`, `0104_identity_invitation_decline`,
`0105_identity_expiry_indexes`, `0180_identity_org_scoped_kernel_fks`)

**Status: implemented** (verified by `apps/api/src/modules/identity/__tests__` and the unit specs
next to the code). Statements below are verified unless marked proposed or pending.

## Kernel registration — verified

- `PRINCIPAL_RESOLVER_IMPL` → `PrincipalResolver`: verified identity `(issuer, subject)` → active
  account → active person → staff memberships in effect at the clock → `Principal`
  (`kind` staff|customer, organization from the account row, `staffScopes` keeping each role's
  own facility scope — a role is organization-wide only when one of its own memberships is
  unscoped — with `staffRoles` and `facilityIds` as the unions for display, `actorLabel` built
  from ids only). The kernel authorizes against the scope of the roles that hold the action
  (`staffFacilityScope`, `listFacilityScope`), so front_desk at F1 plus an organization-wide coach
  membership is still front_desk at F1 only (identity-05, §2.1, §4.14). Disabled accounts, unknown subjects and inactive/merged
  persons resolve to `null` (unauthenticated).
- `RELATIONSHIP_AUTHORITY_IMPL` → `RelationshipAuthority.hasPermission`: true only for an
  unrevoked access grant that is not under a suspension in force, inside its own effective dates
  and its relationship's effective dates, on an **active** relationship, evaluated at the clock on
  every call (revocation, review restrictions and the end of a time-bounded relationship apply
  immediately, SPK-IAM-003/005/006). Self: an adult always; a child never for `pay` or `collect`.

Both IMPL tokens are bound with `useExisting` in `identity.module.ts`. `subjectsWithPermission`
(K-05, IF-01) answers with `hasPermission`'s effectivity rule, never the actor, through the active
transaction, so the kernel's customer "my ..." lists (`AuthorizationService.customerSubjects`)
start from the people a guardian holds a permission over (**Verified**:
`__tests__/directory-ports.spec.ts` "IF-01: …").

## Tables (migration 0100)

| Table                                       | Purpose                                                                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persons`                                   | name, date of birth, kind adult/child, status active/inactive/merged, `merged_into_person_id`, provenance (child data minimized)                                                                                |
| `contact_points`                            | email/phone per person; one primary per kind; a verified primary identifier is unique per organization                                                                                                          |
| `accounts`                                  | `(issuer, subject)` unique; `person_id` nullable until claimed; partial unique: one active account per person                                                                                                   |
| `households`, `household_memberships`       | grouping only; unique `(household, person)`; never consulted by any authority check                                                                                                                             |
| `relationships`                             | actor→subject capacity (guardian/delegate/caregiver/self_managed), status active/suspended/ended, one live row per (actor, subject, kind)                                                                       |
| `access_grants`                             | one row per permission; 4-column deferred FK to the relationship (same two people); GiST exclusion forbids overlapping unrevoked grants per permission; revoke/suspend keep the row                             |
| `access_grants.suspended_until` (0102)      | end of a temporary restriction; null until lifted; check: needs a suspension and ends after it starts                                                                                                           |
| `access_grant_suspensions` (0103)           | one row per review and grant it restricts (window, reason, the decisions that made and ended it); partial unique: one unended row per (grant, review); ended once, never edited or deleted (guard trigger)      |
| `invitations`                               | inviter (with the authority `basis` used: `staff_role` or `delegated`), recipient (person or contact), scope (person or household), requested + granted permissions, token hash, expiry, acceptance, revocation |
| `invitations` decline (0104)                | status `declined`; `declined_at` + `declined_by_person_id` (composite FK) set together, `decline_reason` 1..2000 only when declined; indexes for the sent list and the recipient-contact match                  |
| expiry indexes (0105)                       | pending-expiry indexes on `invitations` and `claims`, and the open restriction-window index on `access_grant_suspensions`, for the periodic jobs                                                                |
| `invitation_subjects` (0101)                | the people an invitation covers, fixed at issue; composite FKs to the invitation and the person; append-only                                                                                                    |
| `claims`                                    | self/guardian claim tokens for staff-created participants; acceptance links an account or creates guardianship without a new person                                                                             |
| `staff_memberships`                         | roles (StaffRole vocabulary check), `facility_ids`, effective window, status active/ended                                                                                                                       |
| `access_reviews`, `access_review_decisions` | disputed-access workflow with owner role/person, parties, evidence, effective dates, escalation; decisions are append-only                                                                                      |
| `duplicate_candidates`                      | canonical pair (a < b), reasons, score, status open/merged/dismissed                                                                                                                                            |
| `person_merges`                             | append-only merge fact (survivor, merged, moved summary, actor, operation); a person is merged at most once                                                                                                     |

Every table is organization-scoped with composite foreign keys; editable records carry `revision`
and `touch_updated_at`; append-only tables carry `forbid_mutation`.

## Endpoints (`/v1`)

| Endpoint                                                     | Who                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                                                    | any authenticated principal: principal, person, staff memberships, current authorities                                                                                                                                                                                                                                                                                                                                                          |
| `POST /people`                                               | front_desk, program_manager, league_manager, system_administrator; any other adult (a customer, or staff whose roles do not cover the command, such as a coach who is also a parent) may create a `child` record (self-service, no authority implied)                                                                                                                                                                                           |
| `GET /people/{id}`                                           | self, holders of `view`, staff (read roles); otherwise NOT_FOUND                                                                                                                                                                                                                                                                                                                                                                                |
| `PATCH /people/{id}`                                         | self, holders of `register`, staff; `expectedRevision` required                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /people/{id}/contact-points`                           | self, holders of `register`, staff (only a staff role that covers the command may mark verified; staff kind alone does not)                                                                                                                                                                                                                                                                                                                     |
| `POST /people/{id}/claims`                                   | staff: issue a self or guardian claim token; a guardian claim names the recipient's verified contact point, a self claim names none (identity-02)                                                                                                                                                                                                                                                                                               |
| `POST /claims/accept`                                        | verified customer, token in the body (§4.14): links the account (self) or creates guardianship (guardian); a self claim stored with a recipient is refused (fails closed)                                                                                                                                                                                                                                                                       |
| `POST /claims/{token}/accept`                                | deprecated (token in the URL path); same behaviour, kept until clients move to `POST /claims/accept`                                                                                                                                                                                                                                                                                                                                            |
| `POST /claims/{id}/revoke`                                   | staff (`identity.revoke_claim`): revoke a pending claim with a reason; a revoked token is never accepted (SPK-IAM-002, SPK-IAM-006)                                                                                                                                                                                                                                                                                                             |
| `POST /accounts`, `POST /accounts/{id}/relink`               | system_administrator, support_operator; relink never touches grants (SPK-AT-025)                                                                                                                                                                                                                                                                                                                                                                |
| `POST /households`, `POST /households/{id}/members`          | staff role, or a household member holding `view` over the person added (a staff member without a covering role is held to the member rule)                                                                                                                                                                                                                                                                                                      |
| `POST /relationships`                                        | staff role; self-service only as guardian of a child the adult created; another household's record reads as NOT_FOUND whatever its state (§4.10)                                                                                                                                                                                                                                                                                                |
| `POST /access-grants`                                        | staff role; self-service on the creator's own self-service relationship, refused while the actor is restricted, a review over the subject is open, or anyone but the holder revoked that permission                                                                                                                                                                                                                                             |
| `POST /access-grants/{id}/revoke`                            | staff role; the grant holder for their own grant; the creator-guardian only for a delegate or caregiver they invited, and only while they hold effective authority over the child                                                                                                                                                                                                                                                               |
| `POST /invitations`, `/{id}/accept`, `/{id}/revoke`          | staff role, or a guardian delegating only permissions held as guardian (proposed default, DEC-089); subjects fixed at issue; acceptance re-checks the inviter (staff role still held, or permissions still held as guardian) and drops the rest; recipient and scope errors never reveal another household's records                                                                                                                            |
| `POST /staff-memberships`, `PATCH /{id}`, `POST /{id}/end`   | system_administrator only                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /access-reviews`, `GET /{id}`, `POST /{id}/decisions`  | open: holders of `view`/staff; read: deciders see everything, an opener who is not a decider sees a redacted projection (own reason, parties, evidence, status and dates; no decisions, outcome or owner, SPK-IAM-005); decide: general_manager, system_administrator, support_operator; a closed review still takes `lift`; `restrict`/`lift` record and end only this review's suspensions (a grant another review restricts stays suspended) |
| `POST /duplicate-candidates`, `/{id}/merge`, `/{id}/dismiss` | flag: record staff; merge: system_administrator (never a child survivor of an adult); dismiss: GM/sysadmin/support                                                                                                                                                                                                                                                                                                                              |
| `POST /dev/tokens`                                           | public, exists only with `AUTH_MODE=local` outside production (NOT_FOUND otherwise)                                                                                                                                                                                                                                                                                                                                                             |

### Stage 3 reads and commands (ID-02..ID-08) — verified

| Endpoint                                                              | Who and what                                                                                                                                                                                                                                                            | Test                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /person-names?ids=` (1..100)                                     | anyone; each id decided with `identity.read_person` as a protected record; people the caller may not view are omitted (never 404); names and `canonicalPersonId` only (SPK-IAM-002/003, §4.10, §4.14)                                                                   | `person-reads.spec.ts`                                  |
| `GET /people?query&kind&status&cursor`                                | `identity.lookup_person` (Proposed C.2: front_desk, league_manager, program_manager, finance_operator, general_manager, system_administrator, support_operator); name prefix or exact contact; merged only with `status=merged`; keyset; no DOB, contacts or households | `person-reads.spec.ts`                                  |
| `POST /people/{id}/contact-points/{contactPointId}/make-primary`      | `identity.add_contact_point` (self, `register` holder, support staff); moves the primary flag in one unit of work; person revision checked and bumped; `identity.person_updated`                                                                                        | `contact-points.spec.ts`                                |
| `POST /people/{id}/contact-points/{contactPointId}/remove`            | same authority; deletes the row; audit keeps kind + masked value; the only verified contact of a person with an active account is refused (`LAST_VERIFIED_CONTACT`, conservative until DEC-018)                                                                         | `contact-points.spec.ts`                                |
| `GET /me/invitations?direction=received\|sent&status&cursor`          | received: addressed to me or to one of my verified contacts; sent: issued by me; `status` filters the effective status                                                                                                                                                  | `invitation-reads.spec.ts`                              |
| `GET /me/invitations/{id}`                                            | recipient or inviter (else protected NOT_FOUND): inviter and subject names, permissions, relationship kind, expiry, `effectiveStatus`; never the token                                                                                                                  | `invitation-reads.spec.ts`                              |
| `POST /invitations/{id}/decline`                                      | the recipient, with the accept proof (token in the body); locked row; expiry recorded first; `identity.invitation_declined`                                                                                                                                             | `invitation-reads.spec.ts`, `identity.machines.spec.ts` |
| `GET /invitations?scopePersonId&status&cursor`                        | `identity.read_invitations` (front_desk, program_manager, league_manager, support_operator, general_manager, system_administrator)                                                                                                                                      | `invitation-reads.spec.ts`                              |
| `GET /me/access-grants?direction=held\|over_me`                       | the holder (or the subject): grant id, relationship, names, source, dates, `status` effective/scheduled/suspended/revoked/ended, `underReview`, revision; other adults' grants over a child are not shown (DEC-004 pending)                                             | `authority-reads.spec.ts`                               |
| `GET /people/{id}/authority`                                          | `identity.read_authority` (same staff set as invitations): relationships, grants, households with member counts, pending invitations, `accountLinked`, claims with masked `recipientHint` (never the token) for SCR-S-20/21                                             | `authority-reads.spec.ts`                               |
| `GET /me/households`                                                  | members limited to myself and people I hold `view` over; the rest only counted (`otherMemberCount`)                                                                                                                                                                     | `authority-reads.spec.ts`                               |
| `GET /staff-memberships?personId&role&facilityId&status`, `GET /{id}` | `identity.read_staff_membership` (general_manager, system_administrator); keyset (created_at desc, id desc)                                                                                                                                                             | `staff-reads.spec.ts`                                   |
| `GET /staff-directory?role&facilityId&query`                          | `identity.read_staff_directory`; memberships in effect at the clock with per-role facility scopes; coach and official roles only with `identity.read_workforce_directory` (scheduler, league_manager, program_manager, general_manager, system_administrator)           | `staff-reads.spec.ts`                                   |
| `GET /access-reviews?status&ownerRole&subjectPersonId`                | review deciders; default every review not closed; `allowedDecisions` from `allowedReviewDecisions` (AccessReviewMachine; also on `GET /access-reviews/{id}`), `restrictedGrantCount`                                                                                    | `staff-reads.spec.ts`                                   |
| `GET /duplicate-candidates?status`, `GET /{id}`                       | `identity.read_duplicates`; default `open`; both names and the signals; dates of birth only on the single read                                                                                                                                                          | `staff-reads.spec.ts`                                   |

The new write routes carry `@RecordAuthority` (`person` for the contact-point commands,
`relationship_evidence` for decline, scope `unproven`), like their siblings in the migration
module's static list (§5.6, IF-41). Role sets for the new read actions are **Proposed** (permission
matrix C.2).

### Background jobs (§4.12) — verified

- `identity.expire_invitations_and_claims` (60 s, failure owner `support_operator`, ID-07): pending
  invitations, then claims, with `expires_at <= now`, one transaction per row
  (`FOR UPDATE SKIP LOCKED`), `InvitationMachine`/`ClaimMachine` `expire`, revision bump, audit
  with the system-only actions `identity.expire_invitation` / `identity.expire_claim`, and one
  `identity.invitation_expired` / `identity.claim_expired` (`via: 'sweep'`). The lazy path on
  accept or decline records the same facts with `via: 'acceptance_attempt'` and still answers
  INVALID_TRANSITION; whichever path holds the row lock first records the expiry, once
  (`identity-jobs.spec.ts`, the race case under PGlite and PostgreSQL). Durations are unchanged
  (POL-044, pending).
- `identity.end_elapsed_restrictions` (60 s, failure owner `support_operator`, ID-08): for each
  review with an elapsed restriction window, one transaction that locks the review (skipped while
  a decision holds it) and its grants in id order, appends a `lift` decision by the system actor
  `identity.restriction_window` (note "restriction window ended", `bySystem: true` on reads), ends
  each suspension at its own `suspended_until`, re-projects the grants, and emits
  `identity.access_restriction_lifted` with `cause: 'window_ended'` for grants no other review
  suspends plus `identity.access_review_decided` `lift`. The review's status is unchanged; its
  revision moves. A manual lift that names `actorPersonId` now ends only that actor's suspensions
  (fix), and the decision path sets `cause: 'decision'` (`identity-jobs.spec.ts`).

Every consequential POST/PATCH is `@Idempotent()` and validated with the zod contracts in
`packages/contracts/src/api/identity.ts`. Services choose the staff path only when a staff role
covers the command (`staffAuthorityApplies`), never on `principal.kind` alone, so a coach who is
also a parent keeps every parent flow and gains nothing from the coach role (SPK-IAM acceptance
example 3). State-changing commands lock the row they transition (`FOR UPDATE`) and check the
revision-guarded update, so a concurrent second accept, revoke or decision fails with
INVALID_TRANSITION or STALE_REVISION (§4.9; `__tests__/identity-concurrency.spec.ts`, run under
PGlite and PostgreSQL).

Merges (SPK-IAM-007): self-service and imported relationships and grants of the merged person are
ended, not transferred; self-service relationships over the survivor end and the survivor's
self-service creator privilege is cleared; the summary (`moved`) reports each count so staff can
re-establish legitimate access through a claim or a staff grant. A child record cannot survive an
adult.

Several reviews may restrict the same grant (SPK-IAM-005, §4.6): each `restrict` records its own
row in `access_grant_suspensions`, and `lift` ends only the deciding review's rows. A grant is
suspended while any unended row is in force (closed reviews included: closing never lifts). The
`access_grants.suspended_at`, `suspended_until`, `suspended_by_review_id` and `suspension_reason`
columns are the projection of the rows in force (earliest start, latest end, the review whose
restriction lasts longest), rewritten under the grant's row lock; restrict and lift lock the grants
in id order, so a lift racing another review's restriction never clears it
(`__tests__/access-reviews.spec.ts`, `identity-concurrency.spec.ts`, `identity-schema.spec.ts`).
`identity.access_restriction_lifted` lists only the grants that are no longer suspended.

## Ports (for other modules)

- `PERSON_DIRECTORY_PORT` (`PersonDirectoryPort`, IF-09): `findPerson`, `resolveCanonicalPersonId`
  (follows merges), `displayNames(org, ids, trx?)` (names only, other-organization and unknown ids
  omitted) and `personIdsResolvingTo(org, id, trx?)` (`[canonical, ...merged into it,
transitively]`, nearest first; `[]` when unknown), both through `trx ?? currentTransaction() ??
db`: modules holding immutable facts read a survivor's history with it instead of rewriting rows
  (SPK-IAM-007). **Verified**: `__tests__/directory-ports.spec.ts`.
- `PeopleService.createPerson(principal, input, correlationId, { importProvenance })` (alias
  `create`, IF-40, K-13): only the batch's import principal (`assertImportPrincipal`), `id =
recordId`, source `import`, create-if-absent (same content: the existing person with no new
  effects; different: RESOURCE_CONFLICT `IMPORT_CONTENT_MISMATCH`); joins the caller's unit of
  work; `POST /v1/people` cannot ask for it. **Verified**: `directory-ports.spec.ts`.
- `AUTHORITY_LOOKUP_PORT` (`AuthorityLookupPort`): `hasPermission`, `actorsWithPermission`
  (communications resolves protected recipients from current permissions, SPK-COMMS-003), and
  `hasPermissionAt(…, asOf)`: whether a permission was effective at a past instant, from the grant
  and relationship windows, revocation and end times and the append-only
  `access_grant_suspensions` history (entry re-checks an offline release at its recorded handover
  time, SPK-AT-018). Tested in `__tests__/access-reviews.spec.ts`. `effectiveGrant(…, at)` (ID-09,
  IF-46, SPK-ENTRY-007): the grant behind a `hasPermission` answer with the same rule evaluated at
  `at` (latest `effectiveFrom` first), null whenever `hasPermission` would be false and for self
  authority. **Verified**: `directory-ports.spec.ts`.
- `STAFF_DIRECTORY_PORT` (`StaffDirectoryPort`): `staffWithRole(org, role, facilityId?)`.
- Fixtures for downstream tests: `testing/identity-fixtures.ts` (`createOrganizationPeople`,
  `createPersonFixture`, `createAccountFixture`, `createRelationshipFixture`,
  `createStaffMemberFixture`, `tokenForPerson`, `authHeaderForPerson`) — use with
  `createTestApp({ imports: [IdentityModule], principalResolver: 'module' })`.

## Events

`identity.person_created`, `identity.person_updated`, `identity.account_linked`,
`identity.account_relinked`, `identity.relationship_created`, `identity.access_granted`,
`identity.access_grant_revoked` (communications re-evaluates unsent protected messages),
`identity.access_restricted`, `identity.access_restriction_lifted` (`cause` `decision` or
`window_ended`, IF-26; absent means `decision`), `identity.invitation_created`,
`identity.invitation_accepted`, `identity.invitation_revoked`, `identity.invitation_declined`
(IF-10, no handler yet), `identity.invitation_expired` and `identity.claim_expired` (IF-25, `via`
`sweep` or `acceptance_attempt`, once per expiry), `identity.claim_issued`,
`identity.claim_revoked`, `identity.claim_accepted`, `identity.staff_membership_changed`,
`identity.access_review_opened`, `identity.access_review_decided`,
`identity.duplicate_candidate_flagged`, `identity.persons_merged` (consumers never rewrite person
ids in history; they read through `personIdsResolvingTo`, IF-21).

## Policy defaults (proposed, pending operator decisions §6.6)

- Adult age is 18 (`ADULT_AGE_YEARS`); kind must agree with the date of birth when known.
- An adult customer may create a child record and become its guardian without staff review
  (guardian verification and child-account policy: pending). Because that guardianship is
  unverified, a merge never carries it to another record.
- Delegation (DEC-089, pending; implemented as the proposed default): only a guardian may invite,
  only into permissions held as guardian, so a delegate or caregiver cannot pass access on.
- Creator-guardian revocation (role matrix item 4, pending): bounded to delegates and caregivers
  the creator invited, while the creator holds effective authority; contested guardianship goes
  to an access review.
- Invitation tokens default to 72 hours, claim tokens to 7 days; raw tokens are returned once to
  the issuer because no messaging provider is selected (§5.2). Expiry durations stay POL-044
  (pending); the background sweep only records expiry that has already happened.
- Invitation lifecycle with `declined` (DEC-093, Proposed): pending → accepted | declined | revoked
  | expired, all terminal. Claims keep pending → accepted | revoked | expired.
- Contact point removal (DEC-018 pending): the only verified contact point of a person with an
  active account is never removed.
- Staff reads (permission matrix C.2, Proposed): the role sets of `identity.lookup_person`,
  `identity.read_invitations`, `identity.read_authority`, `identity.read_staff_membership`,
  `identity.read_staff_directory`, `identity.read_workforce_directory` and
  `identity.read_duplicates`.

## Capability switches (DEC-016)

None. Identity has no Package G capability: every item above applies to every organization and
none is behind a per-organization switch.

## Staff logins (SPK-AT-025, §4.14) — verified

Recovering (`POST /accounts/{id}/relink`), provisioning (`POST /accounts` with a `personId`) or
self-claiming (issue and accept) the login of a person who holds a staff membership in force or
scheduled needs `identity.manage_staff_membership` (system administrator): support and front desk
cannot take over a login that may assign staff roles. A relink never re-activates a disabled account
(409 `INVALID_TRANSITION`) and its audit names the previous and the new provider subject.
**Verified**: `__tests__/claims-and-accounts.spec.ts` "SPK-AT-025 / §4.14: …" and
`apps/api/src/__tests__/journeys/spk-at-025.spec.ts`. Verification evidence for recovery, rate limits
and a second approver for staff recovery are **Pending decision** (DEC-018, DEC-091).

## Known gaps

- Self claims are bound only by handing the token over in person: an account with no person yet
  holds no verified contact point, and the kernel principal carries no provider-verified contact
  claims, so a self claim cannot name a recipient (refused at issue; a stored one fails closed at
  acceptance). A durable binding is pending the identity-provider decision (DEC-018, §5.2):
  either the guard passes provider-verified email/phone to the claim service, which compares it
  with the subject's staff-verified contact point, or self claims gain a recipient account
  (a new 0100s migration). Staff revoke a leaked or misdelivered claim with
  `POST /claims/{id}/revoke`.

- Restrictions apply to the grant rows that exist when `restrict` runs; a grant created later
  through staff, a claim or another guardian's invitation is not suspended automatically.
  Enforcing restrictions per (actor, subject) is a follow-up.
- A relationship past its `effective_to` confers nothing but keeps status `active`, so it still
  blocks a new relationship of the same kind for the same pair (RESOURCE_CONFLICT) and refuses
  further grants (INVALID_TRANSITION) until staff end it; there is no command to end one yet.
- Grants an invitee received do not end when the inviter's own grant is revoked or suspended
  (pending DEC-089/DEC-004). A guardian who did not create the child record cannot revoke a
  delegate's pending invitation or an invitee's grant; that needs staff.
- Invitations and claims are expired by the background sweep (ID-07); the `effectiveStatus` reads
  show `expired` before it runs. Restriction windows that elapsed are recorded by
  `identity.end_elapsed_restrictions` (ID-08); a closed review still never lifts on its own.
- `GET /me/invitations` matches a recipient contact against the person's verified contact points
  as they are now; a contact verified later makes an older invitation appear (proposed).
- Coaches and officials do not search people; they see names only through the activities they are
  assigned to, which entry and competition read with `displayNames` (ENT-01, CMP-06).
- Household-scope invitations cover the child members at issue only (`invitation_subjects`); a
  child who leaves the household before acceptance is dropped and reported.
- Duplicate detection signals are exact name + date of birth and shared verified contact values.

## Kernel notes

- The kernel's `UnitOfWork` carries the active transaction in async context
  (`kernel/database/transaction-context.ts`), so authority checks invoked inside a command read
  through it; `identity.transaction-context.ts` keeps thin aliases for older call sites.
- The IMPL tokens are bound with `useExisting` (the earlier `useValue` workaround is gone).
- Self authority for a permission is decided by the relationship port
  (`AuthorizationService.decide`), so a child never holds `pay` or `collect` over themselves.
- Shared files outside this module are left to integration (**Pending**): the migration module's
  route-classification test (`modules/migration/__tests__/authority.spec.ts`) reads only its
  static lists on this branch, so it lists the three new write routes (classified here with
  `@RecordAuthority`, which MIG-00 makes it read, IF-41) as unclassified; `docs/api/openapi.json`
  and `packages/api-client/src/generated/paths.ts` need `pnpm build && pnpm openapi` and
  `pnpm api-client:generate` (the clients typecheck against the regenerated client); and
  `apps/api/src/__tests__/declared-interfaces.spec.ts` still expects
  `personIdsResolvingTo` to answer its pre-ID-01 default (it now resolves `[]` for an unknown id).
