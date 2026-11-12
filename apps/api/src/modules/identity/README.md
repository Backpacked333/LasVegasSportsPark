# identity module

**Owns:** persons, contact points, login accounts, households, relationships, access grants,
invitations, claims, staff memberships, disputed-access reviews, duplicate candidates, person merges

**Specification:** §3.1 (SPK-IAM-001..007 and acceptance examples), §4.4 Identity, §4.5
(`Person.householdId` cannot determine authority), §4.14, SPK-AT-004, SPK-AT-025

**Migration range:** `packages/db/migrations/0100_identity_core.sql` … `0199` (present: `0100`,
`0101_identity_invitation_subjects`, `0102_identity_suspension_window`,
`0103_identity_grant_suspensions`, `0104_identity_invitation_decline`,
`0105_identity_expiry_indexes`, `0180_identity_org_scoped_kernel_fks`,
`0181_identity_care_notes_and_staff_access`)

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

| Endpoint                                                     | Who                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                                                    | any authenticated principal: principal, person, staff memberships, current authorities                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /people`                                               | front_desk, program_manager, league_manager, system_administrator; any other adult (a customer, or staff whose roles do not cover the command, such as a coach who is also a parent) may create a `child` record (self-service, no authority implied)                                                                                                                                                                                                               |
| `GET /people/{id}`                                           | self, holders of `view`, staff (read roles); otherwise NOT_FOUND                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PATCH /people/{id}`                                         | self, holders of `register`, staff; `expectedRevision` required. The answer is the `PersonDetail` only when the caller may also read the person (`identity.read_person`: self, `view`, read staff); a `register`-only holder gets `{ id, revision, detailWithheld: true }` (SPK-IAM-003, R3-TRACE-A-05). `status`: a staff role only; for a person with staff memberships not ended, a system administrator covering all their facilities (§4.14, see Staff logins) |
| `POST /people/{id}/contact-points`                           | self, holders of `register`, staff (only a staff role that covers the command may mark verified; staff kind alone does not); the answer echoes only the contact point sent                                                                                                                                                                                                                                                                                          |
| `POST /people/{id}/claims`                                   | staff: issue a self or guardian claim token; a guardian claim names the recipient's verified contact point, a self claim names none (identity-02)                                                                                                                                                                                                                                                                                                                   |
| `POST /claims/accept`                                        | verified customer, token in the body (§4.14): links the account (self) or creates guardianship (guardian); a self claim stored with a recipient is refused (fails closed)                                                                                                                                                                                                                                                                                           |
| `POST /claims/{token}/accept`                                | deprecated (token in the URL path); same behaviour, kept until clients move to `POST /claims/accept`                                                                                                                                                                                                                                                                                                                                                                |
| `POST /claims/{id}/revoke`                                   | staff (`identity.revoke_claim`): revoke a pending claim with a reason; a revoked token is never accepted (SPK-IAM-002, SPK-IAM-006)                                                                                                                                                                                                                                                                                                                                 |
| `POST /accounts/register`                                    | the verified identity of the bearer token, before any account exists (public route, token required): a login account in the organization named by slug, with no person and no grant; a repeat answers the same account; rate limited (`account_registration`); a disabled account or one in another organization is answered AUTHENTICATION_REQUIRED                                                                                                                |
| `POST /me/person`                                            | the holder of an account with no person: their own adult record, linked in the same transaction; contact points only from the provider's verified claims; a verified claim that already identifies another person answers RESOURCE_CONFLICT `resolution: claim_existing_record` and creates nothing (SPK-IAM-002); other likenesses become duplicate candidates (SPK-IAM-007)                                                                                       |
| `POST /accounts`, `POST /accounts/{id}/relink`               | system_administrator, support_operator; relink never touches grants (SPK-AT-025)                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /households`, `POST /households/{id}/members`          | staff role, or a household member holding `view` over the person added (a staff member without a covering role is held to the member rule)                                                                                                                                                                                                                                                                                                                          |
| `POST /relationships`                                        | staff role; self-service only as guardian of a child the adult created; another household's record reads as NOT_FOUND whatever its state (§4.10)                                                                                                                                                                                                                                                                                                                    |
| `POST /access-grants`                                        | staff role; self-service on the creator's own self-service relationship, refused while the actor is restricted, a review over the subject is open, or anyone but the holder revoked that permission                                                                                                                                                                                                                                                                 |
| `POST /access-grants/{id}/revoke`                            | staff role; the grant holder for their own grant; the creator-guardian only for a delegate or caregiver they invited, and only while they hold effective authority over the child                                                                                                                                                                                                                                                                                   |
| `POST /invitations`, `/{id}/accept`, `/{id}/revoke`          | staff role, or a guardian delegating only permissions held as guardian (proposed default, DEC-089); subjects fixed at issue; acceptance re-checks the inviter (staff role still held, or permissions still held as guardian) and drops the rest; recipient and scope errors never reveal another household's records                                                                                                                                                |
| `POST /staff-memberships`, `PATCH /{id}`, `POST /{id}/end`   | system_administrator only, within its own facility scope (§2.1, §4.3, R3-SECURITY-01): the membership's requested facilities and current facilities must all be ones the administrator's `system_administrator` scope covers, and an organization-wide membership (`facilityIds: []`) needs an organization-wide administrator (403 `ACCESS_DENIED` otherwise)                                                                                                      |
| `POST /access-reviews`, `GET /{id}`, `POST /{id}/decisions`  | open: holders of `view`/staff; read: deciders see everything, an opener who is not a decider sees a redacted projection (own reason, parties, evidence, status and dates; no decisions, outcome or owner, SPK-IAM-005); decide: general_manager, system_administrator, support_operator; a closed review still takes `lift`; `restrict`/`lift` record and end only this review's suspensions (a grant another review restricts stays suspended)                     |
| `POST /duplicate-candidates`, `/{id}/merge`, `/{id}/dismiss` | flag: record staff; merge: system_administrator (never a child survivor of an adult; when either person holds staff memberships not ended (in force, scheduled or lapsed), only an administrator covering all their facilities); dismiss: GM/sysadmin/support                                                                                                                                                                                                       |
| `POST /dev/tokens`                                           | public, exists only with `AUTH_MODE=local` outside production (NOT_FOUND otherwise)                                                                                                                                                                                                                                                                                                                                                                                 |

### Stage 3 reads and commands (ID-02..ID-08) — verified

| Endpoint                                                              | Who and what                                                                                                                                                                                                                                                                                                                                                         | Test                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /person-names?ids=` (1..100)                                     | anyone; each id decided with `identity.read_person` as a protected record; people the caller may not view are omitted (never 404); names and `canonicalPersonId` only (SPK-IAM-002/003, §4.10, §4.14)                                                                                                                                                                | `person-reads.spec.ts`                                  |
| `GET /people?query&kind&status&cursor`                                | `identity.lookup_person` (Proposed C.2: front_desk, league_manager, program_manager, finance_operator, general_manager, system_administrator, support_operator); name prefix or exact contact; merged only with `status=merged`; keyset; no DOB, contacts or households                                                                                              | `person-reads.spec.ts`                                  |
| `POST /people/{id}/contact-points/{contactPointId}/make-primary`      | `identity.add_contact_point` (self, `register` holder, support staff); moves the primary flag in one unit of work; person revision checked and bumped; `identity.person_updated`; the contact point is answered only to a caller who may read the person, a `register`-only holder gets `{ id, personId, kind, personRevision, detailWithheld: true }` (SPK-IAM-003) | `contact-points.spec.ts`, `people.spec.ts`              |
| `POST /people/{id}/contact-points/{contactPointId}/remove`            | same authority; deletes the row; audit keeps kind + masked value; the only verified contact of a person with an active account is refused (`LAST_VERIFIED_CONTACT`, conservative until DEC-018)                                                                                                                                                                      | `contact-points.spec.ts`                                |
| `GET /me/invitations?direction=received\|sent&status&cursor`          | received: addressed to me or to one of my verified contacts; sent: issued by me; `status` filters the effective status                                                                                                                                                                                                                                               | `invitation-reads.spec.ts`                              |
| `GET /me/invitations/{id}`                                            | recipient or inviter (else protected NOT_FOUND): inviter and subject names, permissions, relationship kind, expiry, `effectiveStatus`; never the token                                                                                                                                                                                                               | `invitation-reads.spec.ts`                              |
| `POST /invitations/{id}/decline`                                      | the recipient, with the accept proof (token in the body); locked row; expiry recorded first; `identity.invitation_declined`                                                                                                                                                                                                                                          | `invitation-reads.spec.ts`, `identity.machines.spec.ts` |
| `GET /invitations?scopePersonId&status&cursor`                        | `identity.read_invitations` (front_desk, program_manager, league_manager, support_operator, general_manager, system_administrator)                                                                                                                                                                                                                                   | `invitation-reads.spec.ts`                              |
| `GET /me/access-grants?direction=held\|over_me`                       | the holder (or the subject): grant id, relationship, names, source, dates, `status` effective/scheduled/suspended/revoked/ended, `underReview`, revision; other adults' grants over a child are not shown (DEC-004 pending)                                                                                                                                          | `authority-reads.spec.ts`                               |
| `GET /people/{id}/authority`                                          | `identity.read_authority` (same staff set as invitations): relationships, grants, households with member counts, pending invitations, `accountLinked`, claims with masked `recipientHint` (never the token) for SCR-S-20/21                                                                                                                                          | `authority-reads.spec.ts`                               |
| `GET /me/households`                                                  | members limited to myself and people I hold `view` over; the rest only counted (`otherMemberCount`)                                                                                                                                                                                                                                                                  | `authority-reads.spec.ts`                               |
| `GET /staff-memberships?personId&role&facilityId&status`, `GET /{id}` | `identity.read_staff_membership` (general_manager, system_administrator); keyset (created_at desc, id desc)                                                                                                                                                                                                                                                          | `staff-reads.spec.ts`                                   |
| `GET /staff-directory?role&facilityId&query&personIds`                | `identity.read_staff_directory`; memberships in effect at the clock with per-role facility scopes; coach and official roles only with `identity.read_workforce_directory` (scheduler, league_manager, program_manager, general_manager, system_administrator)                                                                                                        | `staff-reads.spec.ts`                                   |
| `GET /access-reviews?status&ownerRole&subjectPersonId`                | review deciders; default every review not closed; `allowedDecisions` from `allowedReviewDecisions` (AccessReviewMachine; also on `GET /access-reviews/{id}`), `restrictedGrantCount`                                                                                                                                                                                 | `staff-reads.spec.ts`                                   |
| `GET /duplicate-candidates?status`, `GET /{id}`                       | `identity.read_duplicates`; default `open`; both names and the signals; dates of birth only on the single read                                                                                                                                                                                                                                                       | `staff-reads.spec.ts`                                   |

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
adult. Pending invitations and claims addressed to the merged person are revoked one by one through
the same pending → revoked transition as the revoke commands: under the row lock, revision bumped,
an `identity.revoke_invitation` / `identity.revoke_claim` audit record on the invitation or claim
(`details.via: 'merge'`, the merge's `operationId`) and an `identity.invitation_revoked` /
`identity.claim_revoked` event (§4.6, §4.9, §4.12). The other relationships, grants and candidates
a merge ends take the same per-record path: each relationship it ends goes through
`RelationshipMachine` 'end' with a revision-guarded write and its own `identity.merge_persons` audit
record on the relationship (`details.via: 'merge'`, `transition: 'end'`); each grant it revokes is
revision-guarded (and must still be unrevoked), audited as `identity.revoke_access` and announced
once as `identity.access_grant_revoked`; each other open candidate about the merged person is
dismissed through `DuplicateCandidateMachine` with a revision bump and an `identity.dismiss_duplicate`
audit record; all of them carry the merge's `operationId`. Every record the merge moves to the
survivor (each active account, relationship and grant, each staff membership not ended, and each
access review about the merged person that is open or still holds an unended suspension, since
closing never lifts) is moved under its row lock by a write guarded by the revision read under it
that bumps the revision, and gets its own `identity.merge_persons` audit record on that record
(`details.via: 'merge'`, `operation: 'move'`, the person ids it pointed at before and after, the
merge's `operationId`); an active account of the merged person that the merge disables (the survivor
keeps its own) gets the same record with `operation: 'disable'`. A moved staff membership is also
announced as `identity.staff_membership_changed` naming its new holder. So a `PATCH` or end of a
moved staff membership, or a decision on a moved access review, sent with a revision read before the
merge is refused with 409 `STALE_REVISION` (§4.4, §4.9; R4-LIFECYCLES-REVISIONS-03): a `restrict`
decided on the review as it read before the merge would otherwise reach the survivor's own grants,
which that reviewer never saw. A review about someone else (say, a child of the merged guardian) is
not moved and keeps its revision; a `restrict` or `lift` on any review that names the merged person
as `actorPersonId`, and `POST /access-reviews` about the merged person, are refused with 400
`VALIDATION_FAILED` whose `details.mergedIntoPersonId` names the survivor (they would otherwise match
none of the grants the merge re-pointed and still be recorded as made); naming the survivor reaches
those grants. A closed review that restricts nothing any more is history and stays about the merged
record (reachable through `personIdsResolvingTo`). The merge records no decision on a moved review.
**Verified**: `__tests__/duplicates.spec.ts` "merge keeps history reachable …", "SPK-IAM-007 / §4.9:
merge moves the account …", "§4.9 / §4.4 (R4-LIFECYCLES-REVISIONS-03): every record a merge moves
to the survivor bumps its revision …", "… a restrict or lift naming a merged actor on a review about
someone else is refused naming the survivor …", "… an access review cannot be opened about a merged
person record …" and "… a closed review whose restriction is still in force moves with the
restricted grant …".

Merge locking (§4.9): the merge locks the candidate and both persons, then the merged person's
staff memberships not ended and the access reviews about them it moves (each in id order, before the
staff-assignment scope check reads those memberships and before any grant, in the same
review-then-grants order as an access-review decision), then the merged person's active accounts,
then each live relationship of the merged person (and the self-service relationships over the
survivor it ends) and that relationship's unrevoked grants, before reading them for a write. A
holder's revocation, a review's restriction or decision, a staff membership change or end, or a
recovery either commits first (and the merge reads the committed row: a revoked grant is no longer
selected, a changed membership is scope-checked as committed) or waits for the merge and then sees
its outcome (a moved membership or review at its new revision). Commands that attach a new row to a
person (`POST /accounts` with a `personId`, `POST /staff-memberships`, `POST /households/{id}/members`,
`POST /relationships`, `POST /people/{id}/claims`, `POST /access-reviews`) share-lock the person
before checking its status, so one racing a merge waits and is then refused instead of linking the
row to the merged record behind the merge; an access-review `restrict` or `lift` that names an
`actorPersonId` share-locks that person before the review (the merge's persons-then-reviews-then-grants
order), so one racing a merge of the actor waits and is then refused naming the survivor; `POST
/access-grants` share-locks the relationship, so a grant on a relationship the merge ends is refused
(409 `INVALID_TRANSITION`). Invitation issue takes no person lock: acceptance refuses an acceptor
who is not active and grants only over subjects that are still active (the others are reported as
dropped). **Verified** (PGlite and PostgreSQL):
`__tests__/merge-concurrency.spec.ts` (a holder revoking, or staff granting on, what a running merge
has locked; a merge reaching a grant its holder is revoking; each person-scoped create racing a
merge, `POST /access-reviews` included; a staff membership change and an access-review decision
with a pre-merge revision waiting for a running merge and then refused `STALE_REVISION`; a
`restrict` naming the actor being merged waiting and then refused) and `identity-concurrency.spec.ts`
"§4.9 / SPK-IAM-007: a merge racing a recovery …".

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
transitively]`, nearest first; `[]` when unknown), plus `personIdsResolvingToMany(org, ids,
trx?)` (the same answer for each id, in one recursive read, R4-CARRY-01), all through `trx ??
currentTransaction() ?? db`: modules holding immutable facts read a survivor's history with it
  instead of rewriting rows (SPK-IAM-007). `PeopleService.loadPersons(db, org, ids)` is the batch
  form of `loadPerson` (competition's roster eligibility uses both). **Verified**:
  `__tests__/directory-ports.spec.ts`.
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
`sweep` or `acceptance_attempt`, once per expiry, by whichever path holds the row: the gated race
cases in `__tests__/identity-jobs.spec.ts` run under PGlite and PostgreSQL), `identity.claim_issued`,
`identity.claim_revoked` (`identity.invitation_revoked` and `identity.claim_revoked` come from the
revoke commands and from a merge alike), `identity.claim_accepted`, `identity.staff_membership_changed`,
`identity.access_review_opened`, `identity.access_review_decided`,
`identity.duplicate_candidate_flagged`, `identity.persons_merged` (consumers never rewrite person
ids in history; they read through `personIdsResolvingTo`, IF-21).

## Policy defaults (proposed, pending operator decisions §6.6)

- Adult age is 18 (`ADULT_AGE_YEARS`); kind must agree with the date of birth when known. Kind is
  fixed when the record is made, so the check runs at creation and on a `PATCH /people/{id}` that
  changes the date of birth; a change of names or status (or the stored date of birth sent back
  unchanged) is not re-checked, and a child record stays editable after its person turns 18
  (R4-PRIVACY-02; **Verified**: `__tests__/people.spec.ts` "§4.5 / DEC-004 (R4-PRIVACY-02): a
  child record stays editable after its person turns 18 …").
- **Pending decision** (DEC-004, Operator/privacy owner): the transition at majority. Nothing
  re-evaluates `persons.kind` when a child's date of birth passes `ADULT_AGE_YEARS`, and the code
  decides none of the following until the operator does: whether guardians' grants over the person
  end, are suspended or continue (today they continue unchanged); whether the person gains self
  authority (today `CHILD_SELF_EXCLUDED` still withholds `pay` and `collect` over themselves, and
  they are not their own message recipient); whether staff may change the record's kind from child
  to adult (no command does today); whether the person may self-claim the record (today a child
  record cannot be self-claimed); and how a date-of-birth correction on such a record is made
  (today a changed date of birth must still agree with kind `child`, so it is refused once the
  person is 18 or older).
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
- Editing a child's registration data (**Pending decision** DEC-094, R3-TRACE-A-05; implemented as
  the proposed default, like DEC-090 for availability): `register` alone changes a child's names,
  date of birth (which eligibility age bands read) and contact points (`identity.update_person`,
  `identity.add_contact_point`), without `view`. Such a holder never reads the record back: the
  commands answer with ids and revisions only (`__tests__/people.spec.ts` "SPK-IAM-003: register
  without view changes a child record but never reads it back (no implied view)"). The alternative
  the owner may choose is to require `view` as well for these edits. DEC-094 is recorded in
  `docs/package-a/decision-register.md` (Register F, after DEC-093).
- Staff reads (permission matrix C.2, Proposed): the role sets of `identity.lookup_person`,
  `identity.read_invitations`, `identity.read_authority`, `identity.read_staff_membership`,
  `identity.read_staff_directory`, `identity.read_workforce_directory` and
  `identity.read_duplicates`.

## Capability switches (DEC-016)

None. Identity has no Package G capability: every item above applies to every organization and
none is behind a per-organization switch.

## Staff logins (SPK-AT-025, §4.14) — verified

Recovering (`POST /accounts/{id}/relink`), provisioning (`POST /accounts` with a `personId`) or
self-claiming (issue and accept) the login of a person who holds a staff membership not ended
(status `active`, whatever its window: in force, scheduled, or past its `effective_to`, which
`PATCH /staff-memberships/{id}` can extend or reopen and a merge moves) needs
`identity.manage_staff_membership` (system administrator): support and front desk cannot take over
a login that may assign staff roles. Changing such a person's `status` (`PATCH /people/{id}`) needs
the same authority, because the principal resolver confers nothing on a person who is not active:
deactivating them ends every staff role they hold, and reactivating them restores it. The
administrator's own facility scope must
cover every facility of those memberships, and an organization-wide membership needs an
organization-wide administrator (§2.1, §4.3, R3-SECURITY-01; `requireStaffLoginAuthority` and
`requireStaffAssignmentScope` in `identity.shared.ts`). A claim records its issuer's assignment
scope (`claims.issued_by.staffAssignmentScope`), so a self claim issued by an F1 administrator on a
person who later receives an organization-wide or F2 membership is refused at acceptance; a claim
whose snapshot lacks the recorded scope fails closed. A merge that moves or keeps staff memberships
of either person needs the same coverage. **Verified**: `__tests__/staff-memberships.spec.ts`
"§2.1 / §4.14: a facility-scoped system administrator cannot widen its own scope or grant roles
elsewhere", "… cannot change or end memberships reaching another facility", "§4.14 / SPK-AT-025: …
cannot take over staff logins outside its facilities", "§4.14 / SPK-IAM-007: … cannot merge away
an organization-wide staff record", "§4.14 / SPK-AT-025: changing the person status of staff needs
the authority over their memberships, both ways", "§4.14 / SPK-AT-025: a staff membership past its
end date but never ended still guards the login and the merge" and `identity.shared.spec.ts`. A
relink never re-activates a disabled account
(409 `INVALID_TRANSITION`) and its audit names the previous and the new provider subject. The
account row is locked before the authority, status and revision checks, so a recovery that waits for
another recovery or for a merge is decided against the committed account (§4.9). When two
recoveries of one login at once both carry `expectedRevision`, exactly one relinks it; the other
answers 409 `STALE_REVISION` and is neither audited nor announced. `expectedRevision` is optional:
without it the second recovery is applied after the first, and its audit names the first one's
subject as the previous subject. A recovery that waited for a merge which moved the account onto a
person holding a staff membership needs the staff-role authority (support gets 403
`ACCESS_DENIED`). **Verified**: `__tests__/claims-and-accounts.spec.ts` "SPK-AT-025 / §4.14: …",
`__tests__/identity-concurrency.spec.ts` "§4.9 / SPK-AT-025: two recoveries of one login at once …",
"… two recoveries without expectedRevision both apply, in order …" and "… a recovery without
expectedRevision that waits for a merge …" (PGlite and PostgreSQL; the last two fail under
PostgreSQL without the row lock) and
`apps/api/src/__tests__/journeys/spk-at-025.spec.ts`. Verification evidence for recovery, rate limits
and a second approver for staff recovery are **Pending decision** (DEC-018, DEC-091).

## Keyset paging at the database's precision (R2-API-CONTRACT-01b, §4.5) — verified

The keyset lists (`GET /v1/me/access-grants`, `/v1/invitations`, `/v1/staff-memberships`,
`/v1/duplicate-candidates`, `/v1/access-reviews`) carry the boundary row's `created_at` at the
database's precision (`exactInstantOf` in `kernel/database/keyset.ts`) and compare it as text
(`afterKeyset`), so rows one transaction wrote (one microsecond instant) are paged once each
instead of the rest of a millisecond being skipped. A cursor whose instant PostgreSQL cannot
represent reads as the first page, never a server fault (`__tests__/keyset-paging.spec.ts`).

## Care notes, staff access reviews and staff invitations (migration 0181)

**Verified** by `__tests__/care-notes.spec.ts`, `__tests__/staff-access.spec.ts` and entry's
`__tests__/scan-care-notes.spec.ts`:

- **Care notes** (§1.7 "not a medical assessment system", SPK-DISC-005, §4.14): `person_care_notes`
  holds operational notes only, kind `allergy` or `care_instruction` (the database refuses any
  other kind). `GET /v1/people/{id}/care-notes`, `POST /v1/people/{id}/care-notes`,
  `POST /v1/care-notes/{id}/retire` (reason and expected revision). Reads:
  `identity.read_care_notes` (front desk, program manager, general manager; the person; a holder
  of `view`), anyone else NOT_FOUND. Writes: `identity.manage_care_notes` (the same staff, the adult
  themselves, a holder of `complete_forms`). Every read that returns a note writes an audit record
  naming the reader and the person, never the text; events carry no text. A note is never
  rewritten or deleted (trigger); a correction retires it and records a new one. A merged person's
  notes show on the survivor. `CareNotesService.mayReadAtFacility` / `readForArrivalIn` serve the
  arrival scan.
- **Staff access reviews** (§2.1, §4.14): `POST /v1/staff-access-reviews` (system administrator of
  every facility the roles cover, never their own access: the database refuses a self review),
  `GET /v1/staff-access-reviews`, `GET /v1/staff-access-summary`. Append-only. The next review date
  is set by the reviewer: no review interval is an approved policy (none is proposed here).
- **Last seen**: `StaffMembershipView.lastSeenAt` is `accounts.last_login_at`, which the principal
  resolver touches at most hourly, so it is accurate to the hour.
- **Staff invitations** (§2.1, SPK-IAM-004): `POST /v1/staff-invitations` (token returned once,
  withheld from the idempotency record), `GET /v1/staff-invitations`,
  `POST /v1/staff-invitations/{id}/accept` (token plus the address as a verified email contact
  point of the accepting active adult; creates exactly one staff membership through
  `StaffMembershipsService.createFromInvitationIn`), `POST /v1/staff-invitations/{id}/revoke`.
  One pending invitation per address (partial unique index); acceptance is refused when the
  inviter no longer administers the scope. Expiry is applied on read and recorded on an acceptance
  attempt or a re-invitation (no sweep job yet). **Pending**: delivery. No messaging channel is
  approved (DEC-012, DEC-062) and communications addresses people, not bare email addresses, so
  issuing records `identity.staff_invitation_created` without the address or token.

## Staff directory lookup by person id (ID-10, SCR-S-41) — verified

`GET /staff-directory?personIds=a,b` (1 to 100 ids, or repeated) lists only those people, under
every rule the directory already applies (in effect at the clock, active persons, coach and
official roles only with `identity.read_workforce_directory`); an unknown id is simply absent. The
staff dashboard names maintenance task owners with it instead of paging the facility's directory.
Test: `staff-reads.spec.ts` ("… a lookup by person id (ID-10)"), 2026-11-09.

## Self-registration (SPK-IAM-001, SPK-IAM-002, SPK-UX-001) — verified

**Verified** by `__tests__/self-registration.spec.ts` (PGlite and PostgreSQL):

- A person the identity provider verified registers their own login account
  (`POST /v1/accounts/register`) and, when the front desk has no record of them, their own adult
  record (`POST /v1/me/person`). Neither grants access to anyone else's record: no relationship,
  grant, household or staff role is created.
- The authentication guard keeps the verified identity on the request (`CurrentVerifiedIdentity`)
  for these two commands. Contact points are recorded from the OpenID Connect claims `email` with
  `email_verified` and `phone_number` with `phone_number_verified`; a claim the provider did not
  mark verified is recorded unverified.
- `POST /accounts/register` is not `@Idempotent()`: an idempotency key is scoped to a principal,
  and none exists yet. `(issuer, subject)` is unique, so a repeat or a race answers one account.
- Record authority (§5.6, §4.7 invariant 11): both routes are classified (`@RecordAuthority`,
  `account` and `person`). A first registration has no principal for the route guard to act on,
  so `registerAccount` asserts `RECORD_AUTHORITY_PORT` itself: while the legacy system is the
  writer of accounts, none is created here.
- **Proposed**, pending DEC-004 (Operator/privacy owner): anyone the identity provider verifies
  may register, and an adult may create their own record. Matching a provider-verified contact to
  a desk-made record automatically is not done; the person claims that record with a code.
- **Not built**: a provider that does not emit the standard verified-contact claims needs them
  mapped at the provider; multifactor claims (`amr`, `acr`) are not read (DEC-091).

## Known gaps

- Care notes are not shown to assigned coaches on activity days (the design's wish): that needs an
  assignment-scoped read through workforce and entry, not built.

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
- The stage-3 integration steps outside this module are closed (**Verified** 2026-10-29): the
  migration module's route-classification test reads `@RecordAuthority`, so the identity write
  routes are classified (`modules/migration/__tests__/authority.spec.ts` asserts no unclassified
  route); `docs/api/openapi.json` and `packages/api-client/src/generated/paths.ts` are regenerated
  (`apps/api/src/__tests__/openapi-parity.spec.ts`, `packages/api-client/src/__tests__/contract-drift.spec.ts`);
  and `apps/api/src/__tests__/declared-interfaces.spec.ts` expects `personIdsResolvingTo` to
  resolve `[]` for an unknown id.

## Stage-3 integration fixes — verified 2026-10-29

- An invitation that names a person is listed and read only by that person, never by another
  holder of the same contact (`__tests__/invitation-reads.spec.ts`, §4.10); declining checks
  `expectedRevision` (`STALE_REVISION`), and `DeclineInvitationRequest` accepts the command meta.
- Access-review lifts announce `access_restriction_lifted` only for grants that were suspended and
  are no longer suspended, once (`__tests__/identity-jobs.spec.ts`).
- Making a contact point primary and removing one are audited under their own action ids
  (`identity.make_primary_contact_point`, `identity.remove_contact_point`;
  `__tests__/contact-points.spec.ts`).
- People search pages on the same case-insensitive order it sorts by.
- The creator-guardian revocation rule applies to a child record the guardian created
  (self-service `POST /v1/people`) and whose guardianship was then verified; exercised end to end by
  `apps/api/src/__tests__/journeys/spk-iam-004-invitation-to-pickup.spec.ts`.
