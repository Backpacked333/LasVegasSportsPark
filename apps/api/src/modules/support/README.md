# support module

**Owns:** support cases and their history, case actions (links from a case to the outcome of an
authorized command of the owning module), exception queues, and the timeline reference index.
Operational exceptions themselves are kernel records (`operational_exceptions`); support provides
their queue-scoped workflow and the Today workspace.

**Specification:** §3.19 (SPK-SUPPORT-001..003), §2.3 SPK-UX-006 (Today workspace), §4.4
Operations (Case, Exception), SPK-IAM-005 (escalation), SPK-IAM-007 (merges keep history),
SPK-AT-026, §4.10, §4.14, §5.11 ("operational issues must have owners and supported resolution
actions")

**Migration range:** `packages/db/migrations/1100_support_*.sql` … `1199` (this module uses `1100`)

**Depends on:** identity (`PERSON_DIRECTORY_PORT`, `STAFF_DIRECTORY_PORT`, `PeopleService`,
`RelationshipAuthority.authoritiesOf`, `HouseholdsService`, `AccessReviewsService`), enrollment
(`ApplicationsService`, `EnrollmentsService`, `SessionBookingsService`), finance
(`CheckoutService.getOrder`, `PaymentsService`, `RefundsService`, `ObligationsService`,
`CreditsService`), communications (`NotificationsService`), scheduling (`EventsService`, local-time
helpers), competition (`ReadinessService`, `ROSTER_PORT`), workforce (`RequirementsService`,
`uncoveredDedupeKey`), facilities (`RestrictionsService`) and the kernel (`OperationalExceptions`,
`OperationsService`). It never writes another module's tables (§4.2): every change to another
module's records is that module's own command, run with the operator's principal.

**Status: implemented** — verified by `apps/api/src/modules/support/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit spec `support.machines.spec.ts`. Statements below
are verified unless marked proposed or pending.

## Principles

- **Staff never use customer credentials (SPK-SUPPORT-002, SPK-AT-026).** Every endpoint acts with
  the operator's own principal; there is no impersonation and no customer token involved. A person
  with no account at all can be assisted (`timeline.spec.ts`, `cases.spec.ts`).
- **Support actions are the owning module's commands (SPK-SUPPORT-003).** A refund is finance's
  `finance.refund`, a resend is communications' compose + send, a permission change is identity's
  command. Support links their outcome (operation or audit record) to the case. A note is history
  only and never changes another module's state; resolving a case as `action_taken` requires a
  succeeded case action — enforced by the service and by the `cases_guard` trigger.
- **Reads go through the owning module with the operator's principal.** That module's
  authorization decides what the operator sees; a source the operator may not read contributes
  nothing and is reported `not_permitted` (timeline and Today feed).

## Tables (migration `1100_support_core.sql`)

| Table                 | Purpose                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cases`               | Category (`access/registration/payment/schedule/team/facility/other`), priority, CaseMachine status, title, description, subject person / household (protected), owner staff person and queue, related records, origin (escalated access review or operational exception), due date (service level), resolution, provenance, revision |
| `case_events`         | Append-only history: `note`, `status` (from/to), `assignment`, `update`, `action_link`; actor snapshot and instant; sequence unique per case                                                                                                                                                                                          |
| `case_actions`        | Action id of the owning module, `via` (`linked`/`helper`), CaseActionMachine status, command operation and/or audit record (evidence), support's coordinating operation, record reference, request key, non-sensitive input, error, actor, revision                                                                                   |
| `exception_queues`    | Name (unique per organization), owning staff roles, acknowledgment and resolution service levels, `active/retired`, revision                                                                                                                                                                                                          |
| `timeline_references` | Append-only index: which person a record of another module concerns (payer, recipient, subject, committed party, team member), the source event, a non-sensitive change summary                                                                                                                                                       |

Lifecycles (`support.machines.ts`; the check constraints and guard triggers list exactly these):

- Case: `open → waiting_customer | waiting_internal | resolved`; `waiting_customer → open |
waiting_internal | resolved`; `waiting_internal → open | waiting_customer | resolved`;
  `resolved → open (reopen) | closed`; `closed` is final.
- CaseAction: `requested → succeeded | failed | unknown`; `unknown → succeeded | failed`.

### Database guarantees (tests in `__tests__/support-schema.spec.ts`)

- **SPK-SUPPORT-003:** a succeeded case action carries the command's operation or audit record
  (`case_actions_succeeded_has_evidence`); a case is resolved as `action_taken` only with a
  succeeded action (`cases_action_taken_requires_command`); a linked action is always succeeded.
- **Lifecycles:** cases are created `open` at revision 1; the guard accepts exactly the CaseMachine
  transitions (every pair is exercised); a closed case is final and accepts no new action; every
  change bumps the revision by one; provenance is immutable. Case action outcomes are final, and the
  action, actor and request never change.
- **§4.7 invariant 5:** one helper execution per case and idempotency key; one link per command
  outcome (operation or audit record) per case; one live case per origin (escalated review,
  exception); one timeline reference per source event, person and record.
- **§4.3:** composite foreign keys to persons, households, facilities and access reviews; triggers
  refuse kernel references (operations, audit records, operational exceptions) of another
  organization.
- History (`case_events`, `timeline_references`) is append-only; cases, case actions and queues are
  never deleted. Queue owning roles are staff roles; acknowledgment is due before resolution.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/support.ts`)

| Method         | Path                                                             | Who (action)                                                                                                                                     |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET            | `/customers/{personId}/timeline`                                 | support operator, front desk, general manager (`support.read_timeline`); everyone else, every customer and other organizations: NOT_FOUND        |
| POST/GET       | `/cases`, `/cases/{id}`                                          | open: case staff (`support.open_case`); read: case staff (`support.read_case`), protected (NOT_FOUND), facility-scoped                           |
| PATCH/POST     | `/cases/{id}`, `/{id}/assign`, `/{id}/transition`, `/{id}/notes` | case staff (`support.work_case`); `expectedRevision` required for edits, assignment and transitions                                              |
| POST           | `/cases/{id}/actions`                                            | case staff (`support.link_action`): link the operation or audit record of a command the operator ran                                             |
| POST           | `/cases/{id}/resend-notification`                                | case staff; communications authorizes the read and the compose + send (`communications.read_notification`, `communications.compose`/`send`)      |
| POST           | `/cases/{id}/request-refund`                                     | case staff; finance authorizes `finance.refund` (finance operator, general manager, system administrator) and enforces the refundable ceiling    |
| POST           | `/cases/{id}/actions/{actionId}/settle`                          | case staff: record the owning module's outcome of an `unknown` helper action (succeeded only with the evidence of the command the helper ran)    |
| GET            | `/today`                                                         | operations staff (`support.read_today`): front desk, league/program managers, scheduler, finance and facilities operators, GM, sysadmin, support |
| GET            | `/exceptions`, `/exceptions/{id}`                                | kernel `exceptions.read`, limited to the viewer's queues (oversight roles see every queue) and facilities                                        |
| POST           | `/exceptions/{id}/acknowledge`, `/resolve`, `/close`             | kernel `exceptions.manage` (GM, sysadmin, support operator) within the viewer's queues; resolve and close require a reason                       |
| GET/POST/PATCH | `/exception-queues`, `/exception-queues/{id}`                    | list: operations staff; define/change: general manager, system administrator (`support.manage_queues`)                                           |

Every consequential POST/PATCH is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and outbox events.

## Behaviour — verified

- **Timeline (SPK-SUPPORT-001, `timeline.spec.ts`):** the person and the people they currently hold
  `view` over (identity's `authoritiesOf`), with applications, enrollments and session bookings
  (enrollment), orders, payments, refunds, obligations and credits (finance), messages with their
  actual per-channel delivery states (communications), schedule changes of published events
  (scheduling) and support cases — newest first, cursor-paged. Each record is read with the
  operator's principal. Only people in scope are named: another household's people and lines are
  never named (an order shows `otherLines` as a count, a message about a child shows a recipient
  count); a child's timeline does not name the paying guardian. Children appear by given name only;
  dates of birth, contacts, message bodies, payment-method tokens and provider references never
  appear. Facility-scoped staff see their facilities' records and organization-wide ones.
- **Cases (SPK-SUPPORT-002, `cases.spec.ts`):** service levels by priority (proposed, see below),
  owner validation (a current staff member who works cases), queue validation, the full CaseMachine,
  stale revisions, idempotent replay, the authorization matrix (other staff and every customer
  receive NOT_FOUND; other organizations are not found; facility scope).
- **Case actions (SPK-SUPPORT-003, `case-actions.spec.ts`):** a note leaves finance untouched and
  cannot justify `action_taken`; finance refuses a refund the operator is not authorized for and the
  attempt is recorded `failed` (a refusal raised after finance already reserved the refund — found
  by the request's correlation id in finance's audit record — is `unknown`, never `failed`); an authorized refund runs once, links finance's operation and
  replays without a second refund; a lost outcome is `unknown` with an exception owned by the
  finance operator, a retry with the same key is refused (`REFUND_PENDING`) instead of refunding
  again, and a reviewer settles it (failed, or succeeded with the helper's own command evidence);
  links verify that the evidence is the operator's own command of the named action; resends go
  through communications and re-resolve recipients from current permissions.
- **Escalation hook (SPK-IAM-005):** `identity.access_review_decided` with `kind = escalate` opens one
  `access` case owned by the review's owner role (the live-origin unique index makes replays
  harmless); later decisions are appended to the case history and never resolve it.
- **Merges (SPK-IAM-007):** `identity.persons_merged` copies the merged person's timeline
  references to the survivor, indexes their cases, and moves live cases to the survivor with a
  history entry.
- **Today (SPK-UX-006, `today.spec.ts`):** kernel exceptions in the viewer's queues and facilities
  (failed urgent communications, unknown financial outcomes, overdue maintenance, uncovered
  assignments raised by the owning modules), today's fixture readiness blockers (competition, the
  officials check excluded because coverage reports it), uncovered required assignments of today's
  activities (workforce, unless an exception the viewer sees owns the slot), and maintenance
  restrictions in effect or proposed today (facilities). Every item has title, severity, affected
  record, owner queue, age, deadline, the next actions the viewer is permitted to take (decided
  with their principal) and resolution history. "Today" is the facility-local day.
- **Exceptions (`exceptions.spec.ts`):** acknowledge, resolve and close go through the kernel's
  `OperationalExceptions.transition` (authorization, lifecycle, revision, audit); the history comes
  from those audit records; the affected record is never changed (`underlyingRecordUnchanged`),
  and closing an exception about a still-uncovered slot makes the derived item reappear on the feed.

## Ports

- `SUPPORT_CASES_PORT` (`SupportCasesPort.openSystemCase(trx, input)`, implemented by
  `CasesService`): another module opens a case from inside its own transaction, attributed to the
  system; one live case per origin.
- Fixtures for downstream tests: `testing/support-fixtures.ts` (`createCaseFixture`,
  `createExceptionQueueFixture`).

## Events (`support.events.ts`)

`support.case_opened`, `support.case_updated`, `support.case_assigned`,
`support.case_status_changed`, `support.case_note_added`, `support.case_action_recorded`,
`support.exception_transitioned`, `support.exception_queue_changed`. Payloads carry identifiers
and enumerations only.

Handlers registered: `support.index_payment` (`finance.payment_received`, `payment_failed`,
`payment_outcome_unknown`), `support.index_refund` (`finance.refund_requested`, `refund_settled`),
`support.index_order` (`finance.order_paid`), `support.index_message`
(`communications.notification_dispatched`), `support.index_schedule_change`
(`scheduling.event_changed`), `support.follow_person_merge` (`identity.persons_merged`),
`support.access_review_escalation` (`identity.access_review_decided`). All are idempotent under
replay (kernel consumption records plus unique keys).

## Policy defaults (proposed, pending operator decisions §6.6)

`support.policy.ts` (`DEFAULT_SUPPORT_POLICY`, token `SUPPORT_POLICY`): case service levels urgent
4 h, high 1 day, normal 3 days, low 7 days; oversight roles (every queue visible) general manager,
system administrator, support operator; escalated access reviews open as `high`; fixtures with only
warnings or unknown readiness evidence are shown as `info` items. The support service levels and
queue ownership are not in the decision register yet; they belong with the §6.6 support/operations
ownership decisions.

## Known gaps

- **Today workspace:** current and upcoming activities are counted, not listed; expected arrivals
  (entry) and resource-level field status are not part of the feed; incidents from competition
  discipline appear only when a module raises them as exceptions (no incident port exists).
  Coverage covers fixture and scheduling-event targets; catalog offering sessions are not scanned.
- **Timeline:** cash tenders (receipts without a payment attempt) and installment collections that
  finance records without one of the indexed events are not shown; records created before this
  module was deployed (or by fixtures that emit no events) are not indexed — a backfill would read
  the owning modules' exported services. Lists return one page per source (`timelineSourceLimit`).
- **Case actions:** a helper outcome left `requested` (the process failed while recording the
  outcome) is visible on the case but is not swept automatically; there is no worker that settles
  stale helper actions. Only refund and resend helpers exist; transfers and permission changes are
  run in their modules and linked.
- **Exceptions:** managing an exception requires the kernel's `exceptions.manage` (GM, sysadmin,
  support operator); a queue's owning role (for example the finance operator) can see but not
  acknowledge its queue's exceptions until the kernel widens that action.
- **Customers:** customers have no self-service support requests or timeline; cases are staff
  records.

## Kernel limitations worked around here

- References to the kernel tables `operations`, `audit_records` and `operational_exceptions` are
  organization-scoped composite foreign keys (`0005_core_org_scoped_keys.sql`,
  `1180_support_org_scoped_kernel_fks.sql`); the earlier triggers (`case_actions_scope`,
  `cases_guard`) are kept as earlier feedback with their messages.
- `OperationalExceptions` offers `listOpen` only: lists by status, single reads and the resolution
  history read `operational_exceptions` and `audit_records` read-only; every write stays with the
  kernel service. Its `transition` loads by id without the organization, so support checks the
  organization first (another organization's exception is NOT_FOUND, not ACCESS_DENIED).
- `OperationsService` has no lookup of who requested an operation; links read `operations`
  read-only to verify the operator ran the command.
- Outbox handlers receive the transaction but not the kernel's transaction context; the module
  binds it with `runWithTransaction` so the owning modules' reads go through it.
