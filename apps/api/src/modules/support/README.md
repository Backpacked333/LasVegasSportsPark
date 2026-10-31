# support module

**Owns:** support cases and their history, case actions (links from a case to the outcome of an
authorized command of the owning module), exception queues, the timeline reference index and its
per-organization backfill cursor. Operational exceptions themselves are kernel records; support
provides their queue-scoped workflow and the Today workspace.

**Specification:** §3.19 (SPK-SUPPORT-001..003), §3.5 SPK-CAP-001 ("contact the operating team"),
§2.3 SPK-UX-006 (Today workspace), §4.4 Operations (Case, Exception), SPK-IAM-005 (escalation),
SPK-IAM-007 (merges keep history), SPK-AT-023, SPK-AT-026, §4.2, §4.10, §4.11, §4.12, §4.14, §5.11
("operational issues must have owners and supported resolution actions"); screens SCR-C-22,
SCR-C-38.

**Migration range:** `packages/db/migrations/1100_support_*.sql` … `1199`. This module uses `1100`
(core), `1101` (close requires settled actions), `1102` (customer requests, SUP-01), `1103`
(timeline backfill, SUP-03) and `1180` (organization-scoped kernel foreign keys).

**Depends on:** identity (`PERSON_DIRECTORY_PORT` incl. `personIdsResolvingTo` (IF-09, ID-01),
`STAFF_DIRECTORY_PORT`, `PeopleService`, `RelationshipAuthority.authoritiesOf`,
`HouseholdsService`, `AccessReviewsService`), enrollment (`ApplicationsService`,
`EnrollmentsService`, `SessionBookingsService`), finance (`CheckoutService`, `PaymentsService`,
`RefundsService`, `ObligationsService`, `CreditsService`, `CashTendersService.listForPersons`
(FIN-02)), communications (`NotificationsService`), scheduling (`EventsService`, local-time
helpers), competition (`ReadinessService`, `ROSTER_PORT`, `FixturesService`), workforce
(`RequirementsService`, `uncoveredDedupeKey`), facilities (`RestrictionsService`) and the kernel
(`OperationalExceptions` get/list/history/raise/transition, `OperationsService`
requestedBy/find/create/transition, `AuditReader.forTarget`, `OutboxHistory.page`,
`FacilityDirectory`, `PeriodicJobRegistry`, module settings). It never writes another module's
tables (§4.2): every change to another module's records is that module's own command, run with the
operator's principal.

**Status: implemented** — verified by `apps/api/src/modules/support/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL, 76 tests) and the unit spec `support.machines.spec.ts`. Statements
below are **verified** unless marked **proposed** (an engineering value awaiting an operator
decision) or **pending** (not built, or waiting on a decision or another work item).

**Capability switches:** none. No support behaviour belongs to a §1.6 conditional capability, so
DEC-016 and the Register E records (DEC-072 to DEC-082) do not gate anything here; Package G
records (rentals, parties, memberships, packages, point of sale) reach the timeline only through
their owning modules' events and reads.

## Principles

- **Staff never use customer credentials (SPK-SUPPORT-002, SPK-AT-026).** Every staff endpoint acts
  with the operator's own principal; there is no impersonation and no customer token involved. A
  person with no account at all can be assisted (`timeline.spec.ts`, `cases.spec.ts`).
- **Customers see their own requests' status only (SUP-01, §4.14).** A customer opens a request
  and reads its category, title, status and dates — never notes, owner, queue, history, actions or
  any internal detail.
- **Support actions are the owning module's commands (SPK-SUPPORT-003).** A refund is finance's
  `finance.refund`, a resend is communications' compose + send, a permission change is identity's
  command. Support links their outcome (operation or audit record) to the case. A note is history
  only and never changes another module's state; resolving a case as `action_taken` requires a
  succeeded case action — enforced by the service and by the `cases_guard` trigger.
- **Reads go through the owning module with the operator's principal.** That module's
  authorization decides what the operator sees; a source the operator may not read contributes
  nothing and is reported `not_permitted` (timeline and Today feed). Kernel records are read
  through the kernel's read APIs (SUP-02); see "Kernel boundary" for the one exception.

## Tables

| Table                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cases`                             | Category (`access/registration/payment/schedule/team/facility/other`), priority, CaseMachine status, title, description, subject person / household (protected), owner staff person and queue, related records, origin (escalated access review or operational exception), how it was opened (`opened_via`: `staff`, `customer`, `hook`, 1102), due date (service level), resolution, provenance, revision |
| `case_events`                       | Append-only history: `note`, `status` (from/to), `assignment`, `update`, `action_link`; actor snapshot and instant; sequence unique per case                                                                                                                                                                                                                                                               |
| `case_actions`                      | Action id of the owning module, `via` (`linked`/`helper`), CaseActionMachine status, command operation and/or audit record (evidence), support's coordinating operation, record reference, request key, non-sensitive input, error, actor, revision                                                                                                                                                        |
| `exception_queues`                  | Name (unique per organization), owning staff roles, acknowledgment and resolution service levels, `active/retired`, revision                                                                                                                                                                                                                                                                               |
| `timeline_references`               | Append-only index: which person a record of another module concerns (payer, recipient, subject, committed party, team member), the source event, a non-sensitive change summary                                                                                                                                                                                                                            |
| `support_timeline_backfill_cursors` | One row per organization whose outbox history is replayed into the index (SUP-03, 1103): the last replayed event (`last_occurred_at`, `last_event_id`) and when the replay caught up (`completed_at`)                                                                                                                                                                                                      |

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
  change bumps the revision by one; provenance (opener, origin, `opened_via`, creation) is
  immutable. Case action outcomes are final, and the action, actor and request never change.
- **SUP-01 (1102):** a customer case names its opener (`cases_customer_has_opener`); `opened_via =
'hook'` exactly when the case names one origin record (`cases_opened_via_origin`) — "SUP-01
  (migration 1102): the database rejects a customer case without its opener; …".
- **SUP-03 (1103):** a backfill cursor names both keyset columns or neither; cursors are never
  deleted.
- **§4.7 invariant 5:** one helper execution per case and idempotency key; one link per command
  outcome (operation or audit record) per case; one live case per origin (escalated review,
  exception); one timeline reference per source event, person and record.
- **§4.3:** composite foreign keys to persons, households, facilities, access reviews and the kernel
  records (operations, audit records, operational exceptions; 1180).
- History (`case_events`, `timeline_references`) is append-only; cases, case actions, queues and
  backfill cursors are never deleted. Queue owning roles are staff roles; acknowledgment is due
  before resolution.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/support.ts`)

| Method         | Path                                                             | Who (action)                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST           | `/me/support-requests`                                           | a customer about themselves, someone they hold `view` over, or a team entry they captain (`support.request_support`); anything else NOT_FOUND. `@NoRecordAuthority`       |
| GET            | `/me/cases`, `/me/cases/{id}`                                    | the caller's own requests (opened under any of their merged records), status only; anyone else's request NOT_FOUND                                                        |
| GET            | `/customers/{personId}/timeline`                                 | support operator, front desk, general manager (`support.read_timeline`); everyone else, every customer and other organizations: NOT_FOUND                                 |
| POST/GET       | `/cases`, `/cases/{id}`                                          | open: case staff (`support.open_case`); read: case staff (`support.read_case`), protected (NOT_FOUND), facility-scoped; list filters incl. `origin` and `subjectPersonId` |
| PATCH/POST     | `/cases/{id}`, `/{id}/assign`, `/{id}/transition`, `/{id}/notes` | case staff (`support.work_case`); `expectedRevision` required for edits, assignment and transitions; resolve and close take `acknowledgeOpenRecovery` (SUP-04)            |
| POST           | `/cases/{id}/actions`                                            | case staff (`support.link_action`): link the operation or audit record of a command the operator ran                                                                      |
| POST           | `/cases/{id}/resend-notification`                                | case staff; communications authorizes the read and the compose + send (`communications.read_notification`, `communications.compose`/`send`)                               |
| POST           | `/cases/{id}/request-refund`                                     | case staff; finance authorizes `finance.refund` (finance operator, general manager, system administrator) and enforces the refundable ceiling                             |
| POST           | `/cases/{id}/actions/{actionId}/settle`                          | case staff who also hold `exceptions.manage` and see the outcome's queue: record the owning module's outcome of an `unknown` helper action                                |
| GET            | `/today`                                                         | operations staff (`support.read_today`): front desk, league/program managers, scheduler, finance and facilities operators, GM, sysadmin, support                          |
| GET            | `/exceptions`, `/exceptions/{id}`                                | kernel `exceptions.read`, limited to the viewer's queues (oversight roles see every queue) and facilities; newest first                                                   |
| POST           | `/exceptions/{id}/acknowledge`, `/resolve`, `/close`             | kernel `exceptions.manage`, or the queue's own staff role (`exceptions.manage_own_queue`, K-10), within the viewer's queues; resolve and close require a reason           |
| GET/POST/PATCH | `/exception-queues`, `/exception-queues/{id}`                    | list: operations staff; define/change: general manager, system administrator (`support.manage_queues`)                                                                    |

Every consequential POST/PATCH is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and outbox events. Case resolve and close are the `resolve`
and `close` events of `POST /cases/{id}/transition` (there are no separate routes).

## Stage 3 work items (verified)

| Item   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tests                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUP-01 | Customer support requests (SPK-SUPPORT-002, SPK-CAP-001, SCR-C-22, SCR-C-38). The subject (default the caller) is authorized with `allowSelf`/`view`, a team request with the entry's `captain` role, every linked record through its owning module with the customer's principal (application, enrollment, session booking, checkout, order, obligation, payment, refund, credit, scheduling event, fixture; other types: `UNSUPPORTED_RELATED_RECORD`). Routed to the policy's queue for the category; audited as `support.request_support`; outbox `support.case_opened` (with `openedVia`). Staff views gain `openedVia` and `GET /cases?origin`. TodayItem gains `revision` (the exception's or restriction's; null for derived conditions); NextAction gains `verb` (`acknowledge`/`resolve`/`close` for the exception lifecycle, `open` for an owning module's command, `view` for a read), and the lifecycle is offered with `exceptions.manage_own_queue` to the queue's own role, as the kernel accepts it (K-10) | `customer-requests.spec.ts` ("SPK-SUPPORT-002 / SPK-CAP-001: a captain contacts the operating team and reads the case status, never internal notes", "SPK-CAP-001: only the entry captain …", "SCR-C-38: a guardian asks about their child; …", "cases filter by origin"); `support-schema.spec.ts` (SUP-01, 1102); `today.spec.ts` (revision and verbs, own-queue lifecycle) |
| SUP-02 | Kernel records through the kernel's read APIs (§4.2, §4.10): exceptions (`OperationalExceptions.get/list/history`), who requested an operation (`OperationsService.requestedBy`) and its status (`find`, read before support's transaction), audit history (`AuditReader.forTarget`), refunds a helper request ran (`OutboxHistory.page` of `finance.refund_requested`, then `AuditReader`), facilities (`FacilityDirectory`). Support's own organization pre-check before an exception transition is gone (the kernel answers NOT_FOUND)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `kernel-boundary.spec.ts` ("support no longer selects from kernel tables", "the remaining kernel lookups are read-only and stay in their one documented file"); the existing support tests                                                                                                                                                                                    |
| SUP-03 | Timeline backfill (SPK-SUPPORT-001, §4.12, SPK-AT-023): job `support.backfill_timeline` (every 300 s, failure owner `support_operator`) replays each unfinished organization's committed events of the indexed types from `OutboxHistory` after its cursor, indexing each exactly as the live handler would and advancing the cursor in the same transaction; an empty page completes it. Migration 1103 requests a replay for every organization that existed when it ran; `TimelineBackfillService.request(org, { restart })` requests another. Cash tenders come from finance (FIN-02). Payments, refunds, cash tenders, messages, schedule changes and cases each page with their own keyset (index groups, finance's tender cursor, case history) and are merged newest first into one cursor                                                                                                                                                                                                                          | `timeline-backfill.spec.ts` ("SPK-SUPPORT-001: events committed before support indexed them appear on the timeline after the backfill", "a second backfill run indexes nothing twice", "a cash tender appears on the payer's timeline; a person with 250 payments pages through all of them"); `timeline.spec.ts` (pagination)                                                |
| SUP-04 | Job `support.settle_stale_case_actions` (every 300 s, failure owner `support_operator`): a helper request still `requested` `SUPPORT_STALE_ACTION_SECONDS` (technical, default 900) after its intent gets the owning module's outcome recorded — for a refund, the `finance.refund` that request ran (by its correlation id): `succeeded` with that command's evidence, `failed` when finance recorded only failed or canceled refunds — or stays `requested` with one `support.case_action_stale` exception (owned by the finance operator for refunds); the grace-period follow-up later supersedes it. Resolve and close refuse `RESOURCE_CONFLICT` `RELATED_RECORD_IN_RECOVERY` (listing the case's `recovery_required` operations: its actions' command and coordinating operations and related records of type `operation`) unless `acknowledgeOpenRecovery: true` with a reason, which is recorded on the audit record and the case history                                                                          | `stale-actions.spec.ts` ("a refund helper left requested is settled from the refund attempt's outcome", "without an owning-module outcome the request stays requested with one support.case_action_stale exception", "a case linked to a recovery_required operation cannot be resolved without acknowledgment; with it the acknowledgment is audited")                       |
| SUP-05 | Person merge (SPK-IAM-007): no handler, no rewritten row. The timeline, case search by person and `GET /me/cases` expand a person with identity's `personIdsResolvingTo`; a case's subject keeps its original id and the view adds `subject.canonicalPersonId`. Rows the earlier merge handler copied (`identity.persons_merged` references) are skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `timeline.spec.ts` ("SPK-IAM-007: the survivor's timeline and case search include the merged person's records")                                                                                                                                                                                                                                                               |

## Behaviour — verified

- **Timeline (SPK-SUPPORT-001, `timeline.spec.ts`, `timeline-backfill.spec.ts`):** the person and
  the people they currently hold `view` over (identity's `authoritiesOf`), each expanded with the
  people merged into them, with applications, enrollments and session bookings (enrollment),
  orders, payments, cash tenders, refunds, obligations and credits (finance), messages with their
  actual per-channel delivery states (communications), schedule changes of published events
  (scheduling) and the opening, reopening, resolution and closure of support cases — newest first,
  cursor-paged. Each record is read with the operator's principal. Only people in scope are named:
  another household's people and lines are never named (an order shows `otherLines` as a count, a
  message about a child shows a recipient count); a child's timeline does not name the paying
  guardian. Children appear by given name only; dates of birth, contacts, message bodies,
  payment-method tokens, provider references and tender evidence never appear. Facility-scoped
  staff see their facilities' records and organization-wide ones.
- **Cases (SPK-SUPPORT-002, `cases.spec.ts`):** service levels by priority (proposed, see below),
  owner validation (a current staff member who works cases), queue validation, the full CaseMachine,
  stale revisions, idempotent replay, the authorization matrix (other staff and every customer
  receive NOT_FOUND on staff views; other organizations are not found; facility scope).
- **Case actions (SPK-SUPPORT-003, `case-actions.spec.ts`):** a note leaves finance untouched and
  cannot justify `action_taken`; finance refuses a refund the operator is not authorized for and the
  attempt is recorded `failed` (a refusal raised after finance already reserved the refund — found
  by the request's correlation id — is `unknown`, never `failed`); an authorized refund runs once,
  links finance's operation and replays without a second refund; a lost outcome is `unknown` with an
  exception owned by the finance operator, a retry with the same key is refused (`REFUND_PENDING`)
  instead of refunding again, and a reviewer settles it (failed, or succeeded with the helper's own
  command evidence); links verify that the evidence is the operator's own command of the named
  action; resends go through communications and re-resolve recipients from current permissions.
- **Settling a helper outcome (support-migration-04/06/08):** the reviewer needs the kernel's
  `exceptions.manage` and must see the outcome's queue (a front-desk case worker is refused), and the
  finance-owned exception is resolved as the reviewer, not the system. A refund helper settles
  `failed` only while finance holds no refund for that request other than a failed or canceled one
  (`REFUND_RECORDED_BY_FINANCE`); it settles `succeeded` only with the refund that request ran —
  same operator, payment and amount, recorded since the request under its correlation id, not
  failed or canceled — and not already another case action's evidence (`EVIDENCE_NOT_OF_THIS_REQUEST`,
  `EVIDENCE_ALREADY_LINKED`). That refund cannot be linked to another case while the request is
  outstanding (`HELPER_REQUEST_OUTSTANDING`). The intent transaction enqueues a delayed
  `support.helper_outcome_due`; a request still `requested` after the grace period becomes
  `unknown` (`OUTCOME_NOT_RECORDED`) with the finance-owned exception and a `recovery_required`
  support operation, so it can be settled; a late answer from finance still records its outcome
  and resolves the exception.
- **Escalation hook (SPK-IAM-005):** `identity.access_review_decided` with `kind = escalate` opens one
  `access` case (`opened_via = 'hook'`) owned by the review's owner role (the live-origin unique
  index makes replays harmless); later decisions are appended to the case history and never
  resolve it.
- **Today (SPK-UX-006, `today.spec.ts`):** kernel exceptions in the viewer's queues and facilities
  (failed urgent communications, unknown financial outcomes, overdue maintenance, uncovered
  assignments raised by the owning modules), today's fixture readiness blockers (competition, the
  officials check excluded because coverage reports it), uncovered required assignments of today's
  activities (workforce, unless an exception the viewer sees owns the slot), and maintenance
  restrictions in effect or proposed today (facilities). Every item has title, severity, affected
  record, owner queue, age, deadline, revision, the next actions the viewer is permitted to take
  (decided with their principal, each with its verb) and resolution history. "Today" is the
  facility-local day.
- **Exceptions (`exceptions.spec.ts`):** acknowledge, resolve and close go through the kernel's
  `OperationalExceptions.transition` (authorization, lifecycle, revision, audit); the history comes
  from those audit records; the affected record is never changed (`underlyingRecordUnchanged`),
  and closing an exception about a still-uncovered slot makes the derived item reappear on the feed.
  Lists are newest first (the kernel's list order).

## Ports, events, jobs, settings

- `SUPPORT_CASES_PORT` (`SupportCasesPort.openSystemCase(trx, input)`, implemented by
  `CasesService`): another module opens a case from inside its own transaction, attributed to the
  system; one live case per origin.
- Exported for other modules and tests: `TimelineBackfillService` (`request`),
  `BACKFILL_TIMELINE_JOB`, `SETTLE_STALE_CASE_ACTIONS_JOB`, `CASE_ACTION_STALE_CATEGORY`,
  `INDEXED_EVENT_TYPES`, `SupportSettings`; fixtures `testing/support-fixtures.ts`
  (`createCaseFixture`, `createExceptionQueueFixture`).
- Events (`support.events.ts`): `support.case_opened` (now with `openedVia`),
  `support.case_updated`, `support.case_assigned`, `support.case_status_changed`,
  `support.case_note_added`, `support.case_action_recorded`, `support.helper_outcome_due`,
  `support.exception_transitioned`, `support.exception_queue_changed`. Payloads carry identifiers
  and enumerations only.
- Handlers: `support.index_payment` (`finance.payment_received`, `payment_failed`,
  `payment_outcome_unknown`), `support.index_refund` (`finance.refund_requested`,
  `refund_settled`), `support.index_order` (`finance.order_paid`), `support.index_message`
  (`communications.notification_dispatched`), `support.index_schedule_change`
  (`scheduling.event_changed`), `support.helper_outcome_overdue` (`support.helper_outcome_due`),
  `support.access_review_escalation` (`identity.access_review_decided`). All are idempotent under
  replay (kernel consumption records plus unique keys). `support.follow_person_merge` was removed
  (SUP-05).
- Periodic jobs (K-06): `support.backfill_timeline`, `support.settle_stale_case_actions`.
- Settings (K-15, technical): `SUPPORT_STALE_ACTION_SECONDS` (60..604800, default 900).

## Policy defaults (proposed, pending operator decisions)

`support.policy.ts` (`DEFAULT_SUPPORT_POLICY`, token `SUPPORT_POLICY`), all **proposed** and pending
DEC-015 (support coverage, service objectives) and the §6.6 support/operations ownership rows:

- case service levels urgent 4 h, high 1 day, normal 3 days, low 7 days;
- oversight roles (every queue visible) general manager, system administrator, support operator;
- escalated access reviews open as `high`;
- a helper request's outcome is treated as lost 15 minutes after its intent
  (`helperOutcomeGraceMinutes`);
- fixtures with only warnings or unknown readiness evidence are shown as `info` items;
- **SUP-01:** every category of a customer's request is routed to the `support_operator` queue
  (`customerRequestQueues`, the conservative choice: the queue that triages and reassigns), at
  priority `normal` (`customerRequestPriority`). Routing by category to other queues is pending
  DEC-015.

## Pending and known gaps

- **Cross-branch (pending integration):** `personIdsResolvingTo` is identity's ID-01 and
  `CashTendersService.listForPersons` is finance's FIN-02; the support tests run against them when
  present and otherwise through `__tests__/stage3-doubles.ts`, which follows the declared contract
  (verified against both branches merged). Without ID-01 the timeline, case search by person and
  `/me/cases` answer INTERNAL_ERROR; without FIN-02 the cash-tender source reports `unavailable`.
  The `@NoRecordAuthority` classification of `POST /me/support-requests` is counted by MIG-00's
  authority test; `docs/api/openapi.json` and the api-client are regenerated at integration.
- **Customer requests:** a notification cannot be linked to a request (communications offers no
  customer read of a notification by id); the customer describes it instead. Whether a request
  about a team should also be visible to the entry's co-captains is pending DEC-088. Customers do
  not see a timeline.
- **Timeline:** registration, participation, order, obligation and credit sources show the most
  recent `timelineSourceLimit` (200) records per person and page in memory; payments, refunds,
  cash tenders, messages, schedule changes and cases page without bound. Records created by
  fixtures or imports that emit no events are not indexed by the handlers or the backfill.
  Installment collections that finance records without an indexed event are not shown. A
  poison event (one the indexer cannot process) stops that organization's backfill until it is
  fixed, and the failing job reaches the support operator queue.
- **Recovery guard (SUP-04):** only operations are checked (the case's actions and related records
  of type `operation`); a related payment, checkout or booking in recovery is the owning module's
  state with no read support can use yet.
- **Stale helpers (SUP-04):** only refund helpers can be settled automatically; a resend is
  recorded with its request in one transaction, and communications exposes no lookup of a resend by
  correlation id.
- **Today workspace:** current and upcoming activities are counted, not listed; expected arrivals
  (entry) and resource-level field status are not part of the feed; incidents from competition
  discipline appear only when a module raises them as exceptions (no incident port exists).
  Coverage covers fixture and scheduling-event targets; catalog offering sessions are not scanned.
- **Case actions:** only refund and resend helpers exist; transfers and permission changes are
  run in their modules and linked. Whether a refund or a linked record must concern the case's
  subject or household is not checked (finance authorizes the refund itself; what counts as a
  related record is pending the §6.6 support decisions).

## Kernel boundary (SUP-02) and kernel limitations

- Every kernel record is read through a kernel API, and no kernel table is written here. The one
  exception is `services/audit-evidence.ts`: linking a command by its audit record id, or by the
  operation that ran it, needs an audit read by id and by operation, which `AuditReader` does not
  offer (only `forTarget`). Those two read-only selects of `audit_records` stay there until the
  kernel adds `AuditReader.byId` and a read by operation; `__tests__/kernel-boundary.spec.ts`
  fails on any other kernel-table access.
- `OperationsService.find` reads the root database, so support reads an operation's status
  (link evidence, settle evidence, the recovery guard) before its own transaction; the requester
  check uses `requestedBy` inside it.
- The kernel offers no list of organizations: migration 1103 requests a backfill for every
  organization present when it runs, and `TimelineBackfillService.request` requests one later.
- `OperationalExceptions.list` is newest first, so `GET /exceptions` is too (it was oldest first
  before SUP-02).
- Outbox handlers receive the transaction but not the kernel's transaction context; the module
  binds it with `runWithTransaction` so the owning modules' reads go through it.
