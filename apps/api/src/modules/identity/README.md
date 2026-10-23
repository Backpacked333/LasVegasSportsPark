# identity module

**Owns:** persons, contact points, login accounts, households, relationships, access grants,
invitations, claims, staff memberships, disputed-access reviews, duplicate candidates, person merges

**Specification:** §3.1 (SPK-IAM-001..007 and acceptance examples), §4.4 Identity, §4.5
(`Person.householdId` cannot determine authority), §4.14, SPK-AT-004, SPK-AT-025

**Migration range:** `packages/db/migrations/0100_identity_core.sql` … `0199`

**Status: implemented** (verified by `apps/api/src/modules/identity/__tests__` and the unit specs
next to the code). Statements below are verified unless marked proposed or pending.

## Kernel registration — verified

- `PRINCIPAL_RESOLVER_IMPL` → `PrincipalResolver`: verified identity `(issuer, subject)` → active
  account → active person → staff memberships in effect at the clock → `Principal`
  (`kind` staff|customer, organization from the account row, roles and facility scope unioned,
  `actorLabel` built from ids only). Disabled accounts, unknown subjects and inactive/merged
  persons resolve to `null` (unauthenticated).
- `RELATIONSHIP_AUTHORITY_IMPL` → `RelationshipAuthority.hasPermission`: true only for an
  unrevoked, unsuspended access grant inside its effective dates on an **active** relationship,
  evaluated at the clock on every call (revocation and review restrictions apply immediately,
  SPK-IAM-006). Self: an adult always; a child never for `pay` or `collect`.

Both are registered as `useValue` handles bound in `onModuleInit` (see "Kernel limitations").

## Tables (migration 0100)

| Table                                       | Purpose                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persons`                                   | name, date of birth, kind adult/child, status active/inactive/merged, `merged_into_person_id`, provenance (child data minimized)                                                    |
| `contact_points`                            | email/phone per person; one primary per kind; a verified primary identifier is unique per organization                                                                              |
| `accounts`                                  | `(issuer, subject)` unique; `person_id` nullable until claimed; partial unique: one active account per person                                                                       |
| `households`, `household_memberships`       | grouping only; unique `(household, person)`; never consulted by any authority check                                                                                                 |
| `relationships`                             | actor→subject capacity (guardian/delegate/caregiver/self_managed), status active/suspended/ended, one live row per (actor, subject, kind)                                           |
| `access_grants`                             | one row per permission; 4-column deferred FK to the relationship (same two people); GiST exclusion forbids overlapping unrevoked grants per permission; revoke/suspend keep the row |
| `invitations`                               | inviter, recipient (person or contact), scope (person or household), requested + granted permissions, token hash, expiry, acceptance, revocation                                    |
| `claims`                                    | self/guardian claim tokens for staff-created participants; acceptance links an account or creates guardianship without a new person                                                 |
| `staff_memberships`                         | roles (StaffRole vocabulary check), `facility_ids`, effective window, status active/ended                                                                                           |
| `access_reviews`, `access_review_decisions` | disputed-access workflow with owner role/person, parties, evidence, effective dates, escalation; decisions are append-only                                                          |
| `duplicate_candidates`                      | canonical pair (a < b), reasons, score, status open/merged/dismissed                                                                                                                |
| `person_merges`                             | append-only merge fact (survivor, merged, moved summary, actor, operation); a person is merged at most once                                                                         |

Every table is organization-scoped with composite foreign keys; editable records carry `revision`
and `touch_updated_at`; append-only tables carry `forbid_mutation`.

## Endpoints (`/v1`)

| Endpoint                                                     | Who                                                                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                                                    | any authenticated principal: principal, person, staff memberships, current authorities                                                                |
| `POST /people`                                               | front_desk, program_manager, league_manager, system_administrator; an adult customer may create a `child` record (self-service, no authority implied) |
| `GET /people/{id}`                                           | self, holders of `view`, staff (read roles); otherwise NOT_FOUND                                                                                      |
| `PATCH /people/{id}`                                         | self, holders of `register`, staff; `expectedRevision` required                                                                                       |
| `POST /people/{id}/contact-points`                           | self, holders of `register`, staff (only staff may mark verified)                                                                                     |
| `POST /people/{id}/claims`                                   | staff: issue a self or guardian claim token                                                                                                           |
| `POST /claims/{token}/accept`                                | verified customer: links the account (self) or creates guardianship (guardian)                                                                        |
| `POST /accounts`, `POST /accounts/{id}/relink`               | system_administrator, support_operator; relink never touches grants (SPK-AT-025)                                                                      |
| `POST /households`, `POST /households/{id}/members`          | staff, or a customer member holding `view` over the person added                                                                                      |
| `POST /relationships`                                        | staff; self-service only as guardian of a child the adult created                                                                                     |
| `POST /access-grants`, `POST /access-grants/{id}/revoke`     | staff; grant holder may revoke their own; creator-guardian may revoke over their child                                                                |
| `POST /invitations`, `/{id}/accept`, `/{id}/revoke`          | customers may delegate only permissions they hold; acceptance re-checks the inviter and drops the rest                                                |
| `POST /staff-memberships`, `PATCH /{id}`, `POST /{id}/end`   | system_administrator only                                                                                                                             |
| `POST /access-reviews`, `GET /{id}`, `POST /{id}/decisions`  | open: holders of `view`/staff; decide: general_manager, system_administrator, support_operator                                                        |
| `POST /duplicate-candidates`, `/{id}/merge`, `/{id}/dismiss` | flag: record staff; merge: system_administrator; dismiss: GM/sysadmin/support                                                                         |
| `POST /dev/tokens`                                           | public, exists only with `AUTH_MODE=local` outside production (NOT_FOUND otherwise)                                                                   |

Every consequential POST/PATCH is `@Idempotent()` and validated with the zod contracts in
`packages/contracts/src/api/identity.ts`.

## Ports (for other modules)

- `PERSON_DIRECTORY_PORT` (`PersonDirectoryPort`): `findPerson`, `resolveCanonicalPersonId`
  (follows merges).
- `AUTHORITY_LOOKUP_PORT` (`AuthorityLookupPort`): `hasPermission`, `actorsWithPermission`
  (communications resolves protected recipients from current permissions, SPK-COMMS-003).
- `STAFF_DIRECTORY_PORT` (`StaffDirectoryPort`): `staffWithRole(org, role, facilityId?)`.
- Fixtures for downstream tests: `testing/identity-fixtures.ts` (`createOrganizationPeople`,
  `createPersonFixture`, `createAccountFixture`, `createRelationshipFixture`,
  `createStaffMemberFixture`, `tokenForPerson`, `authHeaderForPerson`) — use with
  `createTestApp({ imports: [IdentityModule], principalResolver: 'module' })`.

## Events

`identity.person_created`, `identity.person_updated`, `identity.account_linked`,
`identity.account_relinked`, `identity.relationship_created`, `identity.access_granted`,
`identity.access_grant_revoked` (communications re-evaluates unsent protected messages),
`identity.access_restricted`, `identity.access_restriction_lifted`, `identity.invitation_created`,
`identity.invitation_accepted`, `identity.invitation_revoked`, `identity.claim_issued`,
`identity.claim_accepted`, `identity.staff_membership_changed`, `identity.access_review_opened`,
`identity.access_review_decided`, `identity.duplicate_candidate_flagged`,
`identity.persons_merged` (other modules re-point person references to the survivor).

## Policy defaults (proposed, pending operator decisions §6.6)

- Adult age is 18 (`ADULT_AGE_YEARS`); kind must agree with the date of birth when known.
- An adult customer may create a child record and become its guardian without staff review
  (guardian verification and child-account policy: pending).
- Invitation tokens default to 72 hours, claim tokens to 7 days; raw tokens are returned once to
  the issuer because no messaging provider is selected (§5.2).

## Known gaps

- Restrictions recorded with an `effectiveTo` on a review decision are not lifted automatically;
  a `lift` decision is required (no sweeper yet).
- Pending invitations/claims are expired lazily on an acceptance attempt; no background expiry.
- Household-scope invitations cover child members only.
- Duplicate detection signals are exact name + date of birth and shared verified contact values.

## Kernel limitations worked around here

- The kernel resolves `*_IMPL` tokens through a Proxy that Nest probes during instantiation; only
  `useValue` providers survive, so this module registers late-bound handles (`identity.module.ts`).
- `AuthorizationService.require` calls the relationship-authority port without a transaction
  handle, which deadlocks PGlite inside `UnitOfWork.run`; commands run inside an
  AsyncLocalStorage transaction context that the port falls back to
  (`identity.transaction-context.ts`).
- The kernel's self short-circuit allows a child principal to act on themselves for `pay`/`collect`
  before consulting the port; modules that own those actions should consult `AuthorityLookupPort`
  for child subjects until the kernel asks the port for self decisions.
