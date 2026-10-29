# automation module

**Owns:** assistant requests (prompt, imported attachments, context references, response, supporting
evidence with freshness, missing evidence), reviewable recommendations, and the append-only log of
every module query or command the assistant used or a reviewer applied (`tool_invocations`).

**Specification:** §3.21 (SPK-AUTO-001..005), §4.2 ("Automation: reviewable recommendations"), §4.4,
SPK-AT-026, §4.7 invariants 1 and 5, §4.10, §4.11, §5.2 (provider-selection gate)

**Migration range:** `packages/db/migrations/1400_automation_*.sql` … `1499` (this module uses `1400`)

**Depends on:** identity (`PeopleService.getPerson`), scheduling (`ScheduleDraftsService.get`,
`create`, `publish`), competition (`ReadinessService.evaluate`), catalog (`PoliciesService.list`),
communications (`NotificationsService.composeAndQueue`), finance (`PaymentsService.get`,
`RefundsService.request`), support (`TodayService.feed`, `TimelineService.timeline`), reporting
(`ReportsService.evaluate`) and the kernel. It never reads or writes another module's tables
(§4.2); the one kernel read is `audit_records` (finance's refund audit, to tell a failed refund from
one with an unknown outcome). **Nothing depends on this module** (SPK-AUTO-005): it is last in
`DOMAIN_MODULES` and registers no port, kernel implementation or event handler that another module
consumes.

**Status: implemented** — verified by `apps/api/src/modules/automation/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit specs `automation.machines.spec.ts`,
`evidence.spec.ts`, `providers/fake-assistant.provider.spec.ts`. Statements below are verified
unless marked proposed or pending.

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
  enabling the assistant in production without a selected provider stops startup.

## Tables (migration `1400_automation_core.sql`)

| Table                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assistant_requests` | Requester principal snapshot (customer or staff only), account and person, facility, prompt, attachments (name, kind, content, length, sha256), context references with the client's `observedAt`, provider, AssistantRequestMachine status, turns, response text, evidence, missing evidence, error, the coordinating operation, revision                                                                                                                                                                             |
| `recommendations`    | Request, kind (`schedule_repair`, `communication_draft`, `readiness_explanation`, `financial_exception_explanation`, `demand_summary`, `policy_lookup`, `issue_summary`), title, summary, payload, command (`actionId`, `input`, authorization `target`), evidence, missing evidence, requester, RecommendationMachine status, expiry, review (reviewer, decision, reason, policy references), apply claim and outcome (applying operation, applied by, audit record, command operation, record, last error), revision |
| `tool_invocations`   | Append-only: request, recommendation (apply phase), sequence, phase (`assist` / `apply`), tool, owning module action, kind (`query` / `command` / `unknown`), the principal it ran under, arguments as proposed, outcome (`succeeded`, `denied`, `failed`, `unsupported`, `invalid`, `unknown`), error code and message, result references, correlation id, operation                                                                                                                                                  |

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

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/automation.ts`)

| Method | Path                                       | Who                                                                                                                                                                   |
| ------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/assistant/requests`                      | any signed-in person (`automation.ask`: every staff role, customers for themselves); the answer is bounded by the caller's own permissions                            |
| GET    | `/assistant/requests/{id}`                 | the requester only (`automation.read_request`, self, protected); everyone else, other organizations included: NOT_FOUND                                               |
| GET    | `/recommendations`                         | the viewer's own recommendations and those whose command action the viewer holds on its target (facility scope included)                                              |
| GET    | `/recommendations/{id}`                    | the requester, or a person holding the recommendation's command action on its target; anyone else: NOT_FOUND                                                          |
| POST   | `/recommendations/{id}/approve`, `/reject` | same audience (`automation.review_recommendation` for the requester; the command's own action for anyone else); `expectedRevision` required; reject needs a reason    |
| POST   | `/recommendations/{id}/apply`              | the approving reviewer only; the owning module's command authorizes the reviewer (`scheduling.publish_schedule`, `communications.compose` + `send`, `finance.refund`) |

Every POST is `@Idempotent()` and zod-validated; every write runs in `UnitOfWork.run` with an audit
record and outbox events; asking and applying create an operation (`automation.assistant_request`,
`automation.apply_recommendation`). While the assistant is disabled every endpoint answers
`503 INTEGRATION_UNAVAILABLE` (a controller guard, before validation and idempotency).

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

## Ports

- `ASSISTANT_PROVIDER_PORT` (`AssistantProviderPort.respond(turn)`): the language-model provider
  gate; `FakeAssistantProvider` only (`providers/fake-assistant.provider.ts`).
- Exported services: `AssistantService`, `RecommendationsService` (nothing consumes them today).
- Fixtures for tests: `testing/automation-fixtures.ts` (`enableAutomation()`, `fakeAssistant(app)`,
  `createAssistantRequestFixture`, `createRecommendationFixture`).

## Events (`automation.events.ts`)

`automation.assistant_request_completed`, `automation.tool_invocation_denied`,
`automation.recommendation_proposed`, `automation.recommendation_reviewed`,
`automation.recommendation_applied`, `automation.recommendation_apply_failed`,
`automation.recommendation_expired`, and the timer `automation.recommendation_expiry_due` (handler
`automation.expire_recommendation`, idempotent under replay; it runs even while the assistant is
disabled because it only touches this module's table). Payloads carry identifiers and enumerations
only — never prompts, attachments or record content.

## Configuration and policy defaults (proposed, pending decisions)

`automation.settings.ts` (token `AUTOMATION_SETTINGS`, read from the environment):
`AUTOMATION_ENABLED` (default `false`; whether the complex uses advanced assistance is DEC-016,
product owner), `AUTOMATION_RECOMMENDATION_TTL_MINUTES` (proposed 24 h),
`AUTOMATION_EVIDENCE_MAX_AGE_MINUTES` (proposed 24 h; the window between `recent` and `stale`),
`AUTOMATION_MAX_TURNS` (proposed 4), `AUTOMATION_MAX_TOOL_CALLS` (proposed 12). The time values are
pending the §6.6 "Support, workload, service objectives" decision (technical lead/operator). What
may be disclosed to whom is the owning modules' authorization (DEC-012 / POL-025 remain pending for
those modules); the provider behind the assistant is DEC-013 (**Pending decision**).

## Known gaps

- **Provider:** no real adapter exists (DEC-013); responses are whatever the fake is scripted to say.
- **Requests are synchronous:** `POST /assistant/requests` returns when the assistant has answered.
  A process that stops mid-request leaves the request `processing` with a running operation; no
  sweeper fails such requests.
- **Unknown apply outcomes:** an apply whose outcome could not be learned (or whose outcome could
  not be recorded) stays claimed with a `recovery_required` operation and an operational exception;
  there is no endpoint to settle it after reconciliation.
- **Catalogue:** schedule repairs publish drafts (existing or opened from proposed changes) but the
  assistant does not compute repairs itself; renewal summaries, readiness across many fixtures and
  financial exceptions beyond a single payment need further tools. Roster, permission and discipline
  changes are deliberately excluded.
- **No per-organization switch:** the feature flag is deployment-wide (`automation.manage_assistant`
  in the permission matrix is not implemented).
- The kernel's exception filter logs every 5xx `DomainError`, so each request to the disabled
  assistant is logged at error level.

## Kernel limitations worked around here

- The kernel configuration schema does not carry module settings, so `AUTOMATION_SETTINGS` reads
  the environment in this module (tests override the token).
- References to `operations` and `audit_records` are organization-scoped composite foreign keys
  (`0005_core_org_scoped_keys.sql`, `1480_automation_org_scoped_kernel_fks.sql`); the earlier
  triggers are kept as earlier feedback with their messages.
- Outbox handlers receive the transaction but not the kernel's transaction context; the module
  binds it with `runWithTransaction`.
