# automation module

**Owns:** assistant requests (prompt, imported attachments, context references, response, supporting
evidence with freshness, missing evidence), reviewable recommendations, the append-only log of
every module query or command the assistant used or a reviewer applied (`tool_invocations`), and
the append-only settlements of applies whose outcome was unknown
(`recommendation_apply_settlements`).

**Specification:** §3.21 (SPK-AUTO-001..005), §4.2 ("Automation: reviewable recommendations"), §4.4,
SPK-AT-026, §4.7 invariants 1 and 5, §4.10, §4.11, §4.12, §1.6 and §6.5 Package G ("reviewable
operational assistance", a conditional capability), §5.1 and §5.2 (integration register,
provider-selection gate)

**Migration range:** `packages/db/migrations/1400_automation_*.sql` … `1499` (this module uses
`1400`, `1401` and `1480`)

**Depends on:** identity (`PeopleService.getPerson`), scheduling (`ScheduleDraftsService.get`,
`create`, `publish`), competition (`ReadinessService.evaluate`), catalog (`PoliciesService.list`),
communications (`NotificationsService.composeAndQueue`), finance (`PaymentsService.get`,
`RefundsService.request`), support (`TodayService.feed`, `TimelineService.timeline`), reporting
(`ReportsService.evaluate`) and the kernel (`CapabilityService`, `INTEGRATION_REGISTRY`,
`PeriodicJobRegistry`, `OperationalExceptions`, `OperationsService`, module settings). It never
reads or writes another module's tables (§4.2); the one kernel table read is `audit_records`
(finance's refund audit, to tell a failed refund from one with an unknown outcome). **Nothing depends on this module** (SPK-AUTO-005): it is last in
`DOMAIN_MODULES` and registers no port, kernel implementation or event handler that another module
consumes.

**Status: implemented** — verified by `apps/api/src/modules/automation/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit specs `automation.machines.spec.ts`,
`evidence.spec.ts`, `providers/fake-assistant.provider.spec.ts`. Statements below are **Verified**
unless marked **Proposed** or **Pending decision** (§6.7). Stage 3 (AUT-01 to AUT-03) is summarised
in [Stage 3](#stage-3-aut-01-to-aut-03).

## Stage 3 (AUT-01 to AUT-03)

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Status                                                       | Evidence                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------- |
| AUT-01 (§5.1, §5.2, SPK-AUTO-001): `AutomationModule.onModuleInit` registers `automation.assistant_provider` in `INTEGRATION_REGISTRY`: gate `assistant` (DEC-013), port `ASSISTANT_PROVIDER_PORT`, adapter `fake-assistant` kind `fake`, `productionAllowed: false`, scenarios `success`, `failure`, `timeout_unknown` (what the fake reproduces; `duplicate` does not apply: the provider has no callback, the module never re-sends a turn and a replayed request is answered from its idempotency record), reconciliation owner `system_administrator`. Registered whether or not the assistant is enabled; in production the port is the no-provider stand-in, which is not registered, so the gate lists no adapter. No behaviour change.                                                                                                                                                                                                                                                                                                  | **Verified**                                                 | `__tests__/integration-register.spec.ts`                 |
| AUT-02 (SPK-AUTO-005, §1.6, §6.5 Package G): the assistant answers only when `AUTOMATION_ENABLED` is true **and** the organization's capability switch `assistant` is on. Flag off: every automation endpoint answers `503 INTEGRATION_UNAVAILABLE` (unchanged). Flag on, capability off (the default for every organization): `POST /assistant/requests`, `POST /recommendations/{id}/approve` and `/apply` answer `403 ACCESS_DENIED` with `details.code CAPABILITY_DISABLED` and record nothing; reading requests and recommendations, rejecting, settling and the expiry timer stay available; other modules never depend on either switch. The switch is changed only by a system administrator through the kernel's `core.manage_capabilities` naming DEC-016 (DEC-013 is a related decision and is refused as an enabling reference), with audit and `core.capability_changed`.                                                                                                                                                           | **Verified**                                                 | `__tests__/capability.spec.ts`, `disabled.spec.ts`       |
| AUT-02 (IF-43): the `AUTOMATION_*` values are the `automation` section of the kernel configuration (`defineModuleSettings`), validated at boot (a malformed value refuses boot); `AUTOMATION_SETTINGS` is derived from `MODULE_SETTINGS('automation')`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **Verified**                                                 | `__tests__/capability.spec.ts` ("IF-43 …")               |
| AUT-02: the permission matrix's proposed `automation.manage_assistant` is **replaced** by `core.manage_capabilities` (capability `assistant`); it is not declared. `automation.ask` and `automation.apply_recommendation` name the capability (`ActionDefinition.capability`), so `GET /v1/me/permissions` treats them as unusable while it is off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **Verified** (declaration); the roles stay **Proposed**      | `automation.actions.ts`                                  |
| AUT-03 (§4.12): periodic job `automation.fail_stalled_requests` (every 300 s, failure owner `system_administrator`) fails each request still `processing` `AUTOMATION_REQUEST_STALL_SECONDS` (technical, default 900) after it was received, with its operation, one transaction each, under `systemPrincipal(organization, job)`, with audit `automation.assistant_request_stalled` and `automation.assistant_request_completed` (`failed`, error `REQUEST_STALLED`). Idempotent; racing sweeps fail a request once; a process that finishes after the sweep keeps the failed outcome and proposes nothing. Runs whatever the flag and the capability say.                                                                                                                                                                                                                                                                                                                                                                                      | **Verified** on PGlite and PostgreSQL                        | `__tests__/stalled-requests.spec.ts`                     |
| AUT-03 (§4.11, §4.7 invariant 5, SPK-AUTO-003): `POST /v1/recommendations/{id}/settle-apply` `{ expectedRevision, outcome: applied \| not_applied, evidence (1..2000), reason, policyReferences? }` (`automation.settle_apply`: system administrator, general manager — roles **Proposed**), only for an apply whose outcome the module recorded as unknown (claim held, operation `recovery_required`). `applied`: the recommendation becomes applied by the approving reviewer who ran it, the operation succeeds, `automation.recommendation_applied` (with `settlementId`). `not_applied`: the claim is released, the operation fails, the expiry timer is re-armed, `automation.recommendation_apply_failed` (`failed`, `APPLY_SETTLED_NOT_APPLIED`); the reviewer may apply it again. Either way the settlement is recorded, the `automation.apply_outcome_unknown` exception is resolved and the command is never run again. Not gated by the capability; `@NoRecordAuthority('Records the reconciled outcome of an apply already run')`. | **Verified**                                                 | `__tests__/settle-apply.spec.ts`                         |
| AUT-03 database guarantees (migration 1401): a settlement names the apply that holds the claim with a recorded unknown outcome; one settlement per apply operation; settlements are append-only and settled by staff only; while such a claim is held the recommendation is marked applied only with an `applied` settlement, released only with a `not_applied` one, and its recorded unknown outcome cannot be rewritten.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Verified** (the database refuses each violation)           | `__tests__/settle-apply.spec.ts` ("database guarantees") |
| Whether the complex uses the assistant at all (capability `assistant`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **Pending decision** DEC-016 (product owner)                 | `docs/package-a/decision-register.md`                    |
| Which provider answers (no real adapter; the fake is refused in production)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Pending decision** DEC-013 (technical lead/account owners) | `docs/package-a/decision-register.md`                    |

## Principles

- **The assistant is a client, never an authority (SPK-AUTO-004).** Every module query or command
  it uses runs through the owning module's exported service with the **requester's own principal**
  (the assistant never uses a system principal; the database refuses any requester, reviewer or
  tool-log principal that is not a customer or staff person). The owning module authorizes the
  call exactly like a direct call: a protected record the requester may not see is `NOT_FOUND`,
  an action they do not hold is `ACCESS_DENIED`.
- **Imported text, attachments and messages are data (SPK-AUTO-004).** Attachments reach the
  provider marked `treatedAs: 'data'`; whatever they say, a tool call they provoke is authorized
  under the requester, and the audit record of the request states that attachments were treated as
  data. A provider that "obeys" an injected instruction achieves nothing (`at-026.spec.ts` R2).
- **Consequential changes are reviewable (SPK-AUTO-003).** Publishing schedules, sending
  communications and refunding are never executed by the assistant: a proposed command is
  authorized like a direct call (the requester must be able to run it themselves; the target is
  read through the owning module first) and becomes a `proposed` recommendation. It is applied
  only after an explicit approval, **by the approving reviewer**, through the owning module's
  normal command with **the reviewer's principal**; the owning module re-authorizes and re-validates
  at that moment. Roster, permission and discipline changes are not in the catalogue at all: the
  assistant can neither propose nor apply them (a call to them is logged `unsupported`).
- **Evidence and its freshness are part of every answer (SPK-AUTO-002).** Each supporting record is
  listed with the tool that read it, `observedAt` (when the assistant read it), `asOf` (its last
  change, or the instant a result was computed), `ageSeconds` and `freshness`. Missing evidence —
  denied reads, unknown readiness checks, unvalidated drafts, unknown payment outcomes, sources the
  caller may not read, calls beyond the limit — is listed explicitly and is never presented as
  "ready" or "none". `not_available` covers both "does not exist" and "you may not see it", so a
  denial never reveals another household's record (§4.10). A recommendation keeps the evidence read
  when it was proposed; when it is read later its evidence is shown with its freshness at that
  read (`recent` within the evidence window, then `stale`; never `live` again) and its age to that
  instant.
- **Provider output is data, not authority (SPK-AUTO-004).** A facility the provider names in a
  proposed command must be a facility of the requester's organization (otherwise `NOT_FOUND`,
  logged `denied`, no recommendation). If the outcome of a request cannot be recorded, the request
  and its operation fail instead of staying `processing`/`running`.
- **No provider is selected (§5.2).** `AssistantProviderPort` has only the deterministic
  `FakeAssistantProvider` (scripted turns, failure, timeout); it is refused in production, and
  enabling the assistant in production without a selected provider stops startup. The integration
  register lists it (AUT-01).
- **Two switches, both off by default (SPK-AUTO-005, DEC-016).** The deployment flag
  `AUTOMATION_ENABLED` turns the whole module on; the per-organization capability `assistant`
  decides whether that organization accepts new requests, approvals and applies (AUT-02). What
  unwinds or reconciles (reads, rejections, settlements, expiry, stalled-request sweeps) is never
  gated by the capability.
- **Unknown stays explicit until reconciled (§4.11).** An apply with no reported outcome keeps its
  claim until a person records the reconciled outcome with its evidence (AUT-03); a request whose
  process stopped is failed by a periodic job instead of staying `processing`.

## Tables (migrations `1400_automation_core.sql`, `1401_automation_apply_settlements.sql`)

| Table                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assistant_requests`               | Requester principal snapshot (customer or staff only), account and person, facility, prompt, attachments (name, kind, content, length, sha256), context references with the client's `observedAt`, provider, AssistantRequestMachine status, turns, response text, evidence, missing evidence, error, the coordinating operation, revision                                                                                                                                                                             |
| `recommendations`                  | Request, kind (`schedule_repair`, `communication_draft`, `readiness_explanation`, `financial_exception_explanation`, `demand_summary`, `policy_lookup`, `issue_summary`), title, summary, payload, command (`actionId`, `input`, authorization `target`), evidence, missing evidence, requester, RecommendationMachine status, expiry, review (reviewer, decision, reason, policy references), apply claim and outcome (applying operation, applied by, audit record, command operation, record, last error), revision |
| `tool_invocations`                 | Append-only: request, recommendation (apply phase), sequence, phase (`assist` / `apply`), tool, owning module action, kind (`query` / `command` / `unknown`), the principal it ran under, arguments as proposed, outcome (`succeeded`, `denied`, `failed`, `unsupported`, `invalid`, `unknown`), error code and message, result references, correlation id, operation                                                                                                                                                  |
| `recommendation_apply_settlements` | Append-only (1401, AUT-03): recommendation, the apply operation whose outcome was unknown (unique), outcome (`applied` / `not_applied`), evidence, reason, policy references, the staff person who settled it (snapshot, account, person), when, its audit record, correlation id                                                                                                                                                                                                                                      |

Lifecycles (`automation.machines.ts`; the check constraints and guard triggers list exactly these):

- AssistantRequest: `processing → answered | failed`; both final.
- Recommendation: `proposed → approved | rejected | expired`; `approved → applied | expired`;
  `rejected`, `applied` and `expired` are final.

### Database guarantees (tests in `__tests__/automation-schema.spec.ts`)

- **SPK-AUTO-004 / SPK-AT-026:** a request, recommendation or tool invocation always carries a person
  principal snapshot (`kind` customer or staff, with a label); never a system principal.
- **SPK-AUTO-003:** each kind's command is fixed (informational kinds never carry one;
  `schedule_repair` ↔ `scheduling.publish_schedule`, `communication_draft` ↔ `communications.send`,
  `financial_exception_explanation` ↔ optionally `finance.refund`); a recommendation is created
  `proposed`; approval and rejection are recorded with the reviewer (a rejection with its reason) and
  the recorded review is immutable; `applied` requires the approval, the claim of the coordinating
  operation, `applied_by` equal to the approving reviewer, and the audit record of the apply
  (`recommendations_applied_requires_review_and_audit`).
- **Lifecycles:** guard triggers accept exactly the machines' transitions; final states are final;
  a claimed recommendation cannot expire; every change bumps the revision by one; the proposal, its
  evidence, command and requester, and the request's prompt, attachments and context are immutable.
- **§4.7 invariant 5:** one coordinating operation applies one recommendation (unique
  `apply_operation_id`); the claim is held while an apply runs or its outcome is unknown.
- **§4.3:** composite foreign keys to accounts, persons, facilities and the request; triggers refuse
  operations and audit records of another organization and an apply logged against a
  recommendation of another request.
- `tool_invocations` is append-only (`forbid_mutation`); requests and recommendations are never
  deleted.
- **§4.11 / §4.7 invariant 5 (migration 1401, `__tests__/settle-apply.spec.ts`):** see the stage 3
  table; `recommendation_apply_settlements` is append-only, references the recommendation, the
  operation, the audit record and the settler by composite organization keys, and
  `assistant_requests_processing_idx` serves the stalled-request sweep.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/automation.ts`)

| Method | Path                                       | Who                                                                                                                                                                   |
| ------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/assistant/requests`                      | any signed-in person (`automation.ask`: every staff role, customers for themselves); the answer is bounded by the caller's own permissions                            |
| GET    | `/assistant/requests/{id}`                 | the requester only (`automation.read_request`, self, protected); everyone else, other organizations included: NOT_FOUND                                               |
| GET    | `/recommendations`                         | the viewer's own recommendations and those whose command action the viewer holds on its target (facility scope included)                                              |
| GET    | `/recommendations/{id}`                    | the requester, or a person holding the recommendation's command action on its target; anyone else: NOT_FOUND                                                          |
| POST   | `/recommendations/{id}/approve`, `/reject` | same audience (`automation.review_recommendation` for the requester; the command's own action for anyone else); `expectedRevision` required; reject needs a reason    |
| POST   | `/recommendations/{id}/apply`              | the approving reviewer only; the owning module's command authorizes the reviewer (`scheduling.publish_schedule`, `communications.compose` + `send`, `finance.refund`) |
| POST   | `/recommendations/{id}/settle-apply`       | `automation.settle_apply` (system administrator, general manager; **Proposed** roles); others who can see it: ACCESS_DENIED; anyone else: NOT_FOUND (AUT-03)          |

Every POST is `@Idempotent()` and zod-validated; every write runs in `UnitOfWork.run` with an audit
record and outbox events; asking and applying create an operation (`automation.assistant_request`,
`automation.apply_recommendation`). While the assistant is disabled (deployment flag) every endpoint
answers `503 INTEGRATION_UNAVAILABLE` (a controller guard, before validation and idempotency). While
the organization's capability `assistant` is off, asking, approving and applying answer
`403 ACCESS_DENIED` `CAPABILITY_DISABLED`; reads, rejections and settlements do not. Every
recommendation response lists its settlements (`apply.settlements`).

## Tools (`tools/query-tools.ts`, `tools/command-tools.ts`)

| Tool                            | Owning module call (with the requester's principal)           | SPK-AUTO-001                   |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| `support.today_feed`            | `TodayService.feed`                                           | today's unresolved issues      |
| `competition.fixture_readiness` | `ReadinessService.evaluate` (unknown checks → missing)        | readiness blockers             |
| `catalog.policy_versions`       | `PoliciesService.list` (approved only)                        | relevant policies              |
| `reporting.demand_report`       | `ReportsService.evaluate('demand')` (freshness from F1/F2/F3) | demand summary                 |
| `finance.payment`               | `PaymentsService.get` (unknown outcome → missing)             | financial exceptions           |
| `identity.person`               | `PeopleService.getPerson`                                     | (context)                      |
| `scheduling.schedule_draft`     | `ScheduleDraftsService.get` (unvalidated → missing)           | (context for repairs)          |
| `support.customer_timeline`     | `TimelineService.timeline` (staff only)                       | (context)                      |
| `scheduling.publish_schedule`   | command: publish a draft, or open a repair draft and publish  | schedule repairs               |
| `communications.send`           | command: compose and queue a drafted notice                   | draft communications           |
| `finance.refund`                | command: request a refund of a captured payment               | financial exception resolution |

Context references (`person`, `payment_attempt`, `fixture`, `schedule_draft`) are re-read first
through the matching tool; evidence reports `changedSinceClientObservation`.

## Behaviour — verified

- **SPK-AUTO-001 / SPK-AUTO-002 (`assistant.spec.ts`):** readiness explanations with the fixture as
  live evidence and every unknown check as missing evidence; context references re-read with the
  requester's principal, reporting a change since the client's observation; an unreadable context
  reference unresolved and `not_available`; Today summaries with each issue as evidence; demand
  summaries with the report's as-of instant and freshness; policy lookups that state when nothing
  matches; provider failure, timeout, malformed output and the turn limit fail the request (the
  operation fails, nothing is proposed); calls beyond the call limit are not made and are listed;
  unknown tools are `unsupported`, invalid arguments `invalid`; idempotent replay without a second
  provider call; the request is the requester's alone.
- **SPK-AT-026 (`at-026.spec.ts`):** R1 — a captain's request for a player's phone number and a
  refund: every call is refused as the captain (`NOT_FOUND`), neither the phone number nor the
  player's name reaches the provider or the response, no recommendation, no refund, reservation or
  journal, three denial audit records and events under the captain. R2 — an injected instruction in
  an attached message: refund and publication refused, a permission change `unsupported`; grants,
  memberships, drafts and finance unchanged. R3 — front desk cannot publish (refused as for a direct
  call). The same publication requested by a scheduler, and the refund by a finance operator, become
  recommendations and take effect only when the approving reviewer applies them; the module's own
  audit names the reviewer.
- **SPK-AUTO-003 / SPK-AUTO-004 (`recommendations.spec.ts`):** proposed → approved → applied by the
  approving reviewer through scheduling (publication actor and audit are the reviewer); apply before
  approval refused; stale revision; only the approving reviewer applies; replay applies nothing more;
  two concurrent applies publish once; visibility (requester, or holders of the command's action on
  its target; others, other organizations and other facilities NOT_FOUND; lists likewise); a
  reviewer who lost the role is refused by scheduling at apply time (claim released, denial logged,
  operation failed); refunds applied once, the refundable ceiling enforced by finance (failed, claim
  released); a refund the provider declines is a failed apply that can be retried, and one with no
  reported outcome stays claimed and is never marked applied; notices sent only on apply, as the
  reviewer; schedule repairs open and publish a draft as the reviewer, and a refused publication
  keeps the draft it opened (named on the recommendation's last error) so a retry publishes that
  draft instead of opening another, unless it was changed in scheduling meanwhile; rejection needs a reason and is final; informational recommendations cannot be
  applied; expiry by the durable timer and at command time; an apply with an unknown outcome stays
  claimed (`recovery_required` operation, exception owned by the command's queue, retries refused,
  never expired).
- **SPK-AUTO-005 (`disabled.spec.ts`):** disabled by default; every endpoint 503 without writing
  anything (no idempotency key claimed); support keeps working in the same application and in an
  application without this module; no other module imports it; the fake provider is refused in
  production.
- **AUT-01 to AUT-03:** see [Stage 3](#stage-3-aut-01-to-aut-03) (`integration-register.spec.ts`,
  `capability.spec.ts`, `stalled-requests.spec.ts`, `settle-apply.spec.ts`).

## Ports

- `ASSISTANT_PROVIDER_PORT` (`AssistantProviderPort.respond(turn)`): the language-model provider
  gate; `FakeAssistantProvider` only (`providers/fake-assistant.provider.ts`), registered in the
  kernel's integration register as `automation.assistant_provider` (AUT-01).
- Periodic job `automation.fail_stalled_requests` (`FAIL_STALLED_REQUESTS_JOB`, AUT-03).
- Exported services: `AssistantService`, `RecommendationsService` (nothing consumes them today).
- Fixtures for tests: `testing/automation-fixtures.ts` (`enableAutomation()`, `fakeAssistant(app)`,
  `createAssistantRequestFixture`, `createRecommendationFixture`).

## Events (`automation.events.ts`)

`automation.assistant_request_completed`, `automation.tool_invocation_denied`,
`automation.recommendation_proposed`, `automation.recommendation_reviewed`,
`automation.recommendation_applied`, `automation.recommendation_apply_failed` (both carry
`settlementId` when a settlement reported them, AUT-03), `automation.recommendation_expired`, and
the timer `automation.recommendation_expiry_due` (handler `automation.expire_recommendation`,
idempotent under replay; it runs even while the assistant or its capability is off because it only
touches this module's table). Payloads carry identifiers and enumerations only — never prompts,
attachments, settlement evidence or record content.

## Configuration (module settings, AUT-02 / IF-43)

`automation.settings.ts` defines the `automation` section of the kernel configuration
(`defineModuleSettings('automation', …)`, environment variables `AUTOMATION_<KEY>`, validated at
boot; a malformed value refuses boot). None is an operator policy value (no price, tax, deposit,
eligibility or retention rule); all are technical values with defaults.

| Variable                                | Default | Status                                                                                                                              |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOMATION_ENABLED`                    | `false` | deployment flag; only `true`/`false`. Whether the complex uses the assistant is **Pending decision** DEC-016 (product owner)        |
| `AUTOMATION_RECOMMENDATION_TTL_MINUTES` | 1440    | **Proposed** (how long a proposal stays reviewable); pending §6.6 "Support, workload, service objectives" (technical lead/operator) |
| `AUTOMATION_EVIDENCE_MAX_AGE_MINUTES`   | 1440    | **Proposed** (`recent` vs `stale` evidence window); same pending decision                                                           |
| `AUTOMATION_MAX_TURNS`                  | 4       | **Proposed** technical limit (provider turns per request)                                                                           |
| `AUTOMATION_MAX_TOOL_CALLS`             | 12      | **Proposed** technical limit (module calls per request)                                                                             |
| `AUTOMATION_REQUEST_STALL_SECONDS`      | 900     | **Proposed** technical value (AUT-03 stalled-request sweep; longer than any provider turn)                                          |

Capability switch `assistant` (`packages/contracts/src/capabilities.ts`): applicability reference
DEC-016 (**Pending decision**, product owner); related decision DEC-013 (provider, **Pending
decision**), which never enables it. No row means off. Tests turn it on with
`createTestApp({ capabilities: ASSISTANT_CAPABILITIES })` (`__tests__/automation.ts`). What may be
disclosed to whom is the owning modules' authorization (DEC-012 / POL-025 remain pending for those
modules).

## Known gaps (remaining)

- **Provider:** no real adapter exists (**Pending decision** DEC-013); responses are whatever the
  fake is scripted to say.
- **An apply whose process stopped before its outcome was recorded** (claim held, operation
  `running`, no unknown outcome recorded) is not swept: it is neither `recovery_required` nor
  settleable until a sweeper moves it there (**Proposed** follow-up: the AUT-03 job pattern applied
  to `apply_started_at`). Retries answer `APPLY_IN_PROGRESS` meanwhile.
- **Settling needs the deployment flag:** while `AUTOMATION_ENABLED=false` the settle endpoint is
  `503` like every automation endpoint; the `automation.apply_outcome_unknown` exception stays in its
  owner's Today queue (resolvable through the kernel's exception commands) and the claim stays held
  until the module is enabled again (**Proposed**).
- **Integration steps outside this module:** `docs/api/openapi.json` and `packages/api-client` are
  regenerated at integration (the new route and `RecommendationApplySettlement` make the committed
  document stale on this branch: `openapi-parity.spec.ts` "fresh emission"); the migration module's
  route classification counts `@NoRecordAuthority` on `settle-apply` once MIG-00 is merged (on
  stage3-core alone `modules/migration/__tests__/authority.spec.ts` lists it as unclassified).
- **Catalogue:** schedule repairs publish drafts (existing or opened from proposed changes) but the
  assistant does not compute repairs itself; renewal summaries, readiness across many fixtures and
  financial exceptions beyond a single payment need further tools. Roster, permission and discipline
  changes are deliberately excluded.

## Kernel limitations (stage 2) and their resolution

- Module settings: **resolved** by K-15 — `AUTOMATION_*` are kernel module settings (AUT-02).
- References to `operations` and `audit_records` are organization-scoped composite foreign keys
  (`0005_core_org_scoped_keys.sql`, `1480_automation_org_scoped_kernel_fks.sql`, and 1401 for
  settlements); the earlier triggers are kept as earlier feedback with their messages.
- The exception filter's error-level logging of every 5xx: **resolved** by K-10 (a raised
  INTEGRATION_UNAVAILABLE logs at warn).
- Outbox handlers receive the transaction but not the kernel's transaction context; the module
  binds it with `runWithTransaction` (unchanged).
