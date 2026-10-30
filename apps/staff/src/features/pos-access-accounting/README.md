# Point of sale, access hardware and accounting export (SCR-S-55 to SCR-S-57)

Staff screens of three conditional Package G capabilities (§1.6, §3.16, §6.5): SCR-S-55 Point of
sale (`src/screens/package-g/point-of-sale/`), SCR-S-56 Access hardware
(`src/screens/package-g/access-hardware/`) and SCR-S-57 Accounting export batches
(`src/screens/package-g/accounting-exports/`). This directory holds what the three share. Status
legend as in `apps/staff/README.md` (§6.7): **Verified** = implemented and asserted by a jsdom test
here; **Proposed** = engineering proposal; **Pending decision** = needs an operator answer (owners in
`docs/package-a/decision-register.md`). jsdom tests are not staff acceptance (§6.3).

Whether the complex uses each capability is **Pending decision** DEC-016 with DEC-079 (point of
sale), DEC-080 (access hardware) and DEC-081 (accounting), Product owner. Every switch starts off
and only a system administrator changes one (K-12). Each screen is inside
`<CapabilityGate whenOff="notice">`: while a switch is off the API keeps existing records readable
and never gates retirements, voids, returns, a tender settling a sale already open, closing a
register session or canceling a batch, so those stay offered and only commands that start a new
commitment are hidden. A command refused
meanwhile with ACCESS_DENIED `details.code: 'CAPABILITY_DISABLED'` shows "turned off".

## Shared pieces

| File                  | What it does                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `facilities.tsx`      | `GET /v1/facilities` (K-04): names, IANA time zones (SPK-SCHED-008) and the viewer's staff scope; the facility picker. Nothing is assumed when several facilities are in scope.                                                |
| `permission.tsx`      | Which commands to offer from `GET /v1/me/permissions`: offered unless the read says the action is not held at the facility or the switch is off; the API still decides. Action ids are the API's (`finance.*`, `entry.*`).     |
| `CommandError.tsx`    | Every `details.code` refusal of these commands explained with the API's figures (remaining to pay, still refundable, unmapped accounts); four-eyes refusals say another person approves. The rest is Finance's `CommandError`. |
| `intent.ts`           | One idempotency key per intent: while an outcome is unknown the form is locked and "Try again" resends the same request with the same key.                                                                                     |
| `ReasonAction.tsx`    | Retire, withdraw, void and cancel ask for the reason in a labelled form; nothing happens on one click.                                                                                                                         |
| `AuditTrail.tsx`      | The audit history of one record (`GET /v1/audit-records?targetType=&targetId=`), read only when asked because the read is itself audited (§4.14); offered unless core.view_audit is not held.                                  |
| `labels.ts`           | Machine-state labels with glyph and text (`StatusBadge`), never colour alone.                                                                                                                                                  |
| `dev/`                | Development builds only: the fake payment provider's card scenarios. Release builds take no card tender and show DEC-019 (checked by `scripts/check-release-bundle.mjs`, marker `pm_fake_`).                                   |
| `me.ts`, `fields.tsx` | The signed-in person (four eyes), route ids (a malformed id is "Link not available"), money fields that name their currency, and opening a record by its reference.                                                            |

## SCR-S-55 Point of sale (`/finance/point-of-sale/*`)

**Verified** in jsdom (`point-of-sale/__tests__/PointOfSaleScreen.test.tsx`, `SalePage.test.tsx`):

- Registers by facility (`GET /v1/pos-registers`, paged) with their open session; creating
  (`POST /v1/pos-registers`) and retiring (`POST /v1/pos-registers/{id}/retire`, never gated, with
  the reason and `expectedRevision`; REGISTER_SESSION_OPEN explained with its code) a register;
  opening a session with its opening float (`POST /v1/pos-registers/{id}/sessions`). The
  session currency is typed, or taken from the facility's products when they share one: never a
  client default.
- Products (`GET /v1/pos-products`, paged): create with SKU, kind, price in minor units and currency,
  and the approved tax and fee keys the catalog lists
  (`GET /v1/policy-versions?kind=tax_fee&approvalStatus=approved`; none approved says products sell
  without charges, DEC-057); change name, price or charges with `expectedRevision`
  (STALE_REVISION offers Reload); retire with a reason and `expectedRevision` (never gated;
  STALE_REVISION offers Reload; the list is read again and shows it retired).
- A register session (`GET /v1/pos-register-sessions/{id}`): float, expected cash, times in the
  facility's zone; start a sale naming the customer or not (`POST /v1/pos-sales`); close with the
  counted cash and `expectedRevision` (`POST .../close`, never gated). A difference is shown and is
  raised by the API for finance (POL-018: no tolerance approved); open sales block the close with
  their count (SESSION_HAS_OPEN_SALES).
- A sale (`GET /v1/pos-sales/{id}`): lines at the product's price with the approved charges the API
  applied (no price is sent, SPK-PAY-001; CHARGE_POLICY_NOT_APPROVED is a validation failure naming
  the tax), totals, tenders and returns. Cash and external tenders (evidence reference required,
  SPK-PAY-012) and, in development builds, card tenders (`POST /v1/pos-sales/{id}/tenders`). A
  tender is offered on an open sale also while the switch is off (a tender settles an existing sale,
  CAPABILITIES-01); adding a line is not. Every line, tender, return and void sends the sale's
  `expectedRevision` (§4.9): one decided on a sale that changed meanwhile (another tender, a
  provider outcome) is refused STALE_REVISION and offers Reload. A card
  tender with an unknown outcome leaves the sale open: "recovery required", do not take the card
  again, link to the payment attempt to reconcile (SPK-PAY-007); processing is "not paid yet" with
  no void or receipt; a declined card says nothing was taken; the sale is "paid" only when the API
  says so. No answer locks the form and retries with the same key. A tender refused with
  PAYMENT_OUTCOME_UNKNOWN keeps the card intent locked and offers "Reload the sale": the sale then
  shows the payment to reconcile and a cash or external tender for what remains is a new intent
  (new key). A line or tender refused as stale (INVALID_TRANSITION, the sale paid or voided
  elsewhere) offers Reload.
- Void with a reason (`POST /v1/pos-sales/{id}/void`), not offered once a card was charged
  (SALE_HAS_CARD_TENDER); returns of paid units by a tender kind the sale was paid with
  (`POST /v1/pos-sales/{id}/returns`), the API computing the amount and refusing more than was paid
  that way (RETURN_EXCEEDS_TENDER with what is still refundable); a card return larger than one
  card payment can refund (REFUND_EXCEEDS_REFUNDABLE with `availableMinor`) shows that payment's
  available, captured and refunded amounts and advises fewer units, and without figures says no
  card payment can be refunded. A card refund not final shows its status and links to the refund
  (SPK-PAY-008): requested or processing is not final, unknown is recovery required (do not refund
  again), failed or canceled says the customer was not refunded; never success unless it is.
- The receipt (`GET /v1/pos-sales/{id}/receipt`); an unpaid sale has none (RECEIPT_NOT_AVAILABLE).

**Pending decision**: card tenders at the register need the processor and its card-present flow
(DEC-019): release builds offer cash and external tenders only. Which taxes and fees exist (DEC-057)
and the cash procedure and variance tolerance (POL-018) are decided by Finance. Offline nothing is
queued (§4.15: no new payments offline); commands are disabled and say so.

## SCR-S-56 Access hardware (`/admin/access-hardware/*`)

**Verified** in jsdom (`access-hardware/__tests__/AccessHardwareScreen.test.tsx`):

- Devices of a facility (`GET /v1/access-devices?facilityId=`, paged) with observed health and the
  age of the last heartbeat; an outage is shown with its age; with no heartbeat timeout configured
  the health is never judged (no default timeout). Registering a device
  (`POST /v1/access-devices`): it is sent deny-all until a policy is approved.
- A device: rename it or set or clear its heartbeat timeout with `expectedRevision`
  (`PATCH /v1/access-devices/{id}`); retire it with a reason and `expectedRevision` (never gated); a
  stale retirement offers Reload, the device is read again and the next attempt sends the revision
  just read. Its audit history (`GET /v1/audit-records?targetType=access_device&targetId=`):
  nothing is read until "Show audit history" is pressed, then one read by target; not offered
  without core.view_audit, a refused read is "not available". Each policy has the same
  (`targetType=access_policy`).
- Policies (`GET /v1/access-devices/{id}/policies`): a draft with holder kinds and weekly windows
  in the facility's local time (`POST /v1/access-devices/{id}/policies`), each window problem on
  the control that has it (days, from, to; SPK-UX-009); approval by another
  person with `expectedRevision` (`POST /v1/access-policies/{id}/approve`; the author is told
  another person approves it, and the API's author_cannot_approve is explained); withdrawing a draft
  or retiring the active policy (`POST /v1/access-policies/{id}/retire`, never gated, Reload when
  stale), which sends deny-all without a replacement.
- The command queue with delivery outcomes (`GET /v1/access-devices/{id}/commands`, paged, status
  filter): delivered, failed, unknown (asked again by the API) and superseded; nothing is resent from
  the screen.
- Recovery required ("events not ingested with owner"): the unresolved hardware exceptions at the
  facility (`GET /v1/exceptions?facilityId=`, open and acknowledged, every queue the viewer may
  see), filtered on the page to the entry categories device offline, command not delivered,
  unregistered device (events not ingested) and access outcome unknown, each with the owner queue
  the exception records (the facilities operator queue, or the facility operations queue the API
  files an unknown outcome to; no queue is assumed by the client) and linked to its exception page.
- Event ingestion: the access events the inbox received (`GET /v1/provider-events`,
  core.view_provider_events; event type and status filters), never their payloads; failed, dead
  and ignored events are marked not ingested with the API's last error. Not read without the
  permission, which is named; a refused read is "not available", another error shows its code.

Hardware access is a facility arrival only, never attendance, a check-in or pickup authority
(SPK-COND-004), and the page says so. **Pending decision**: the vendor and its protocols (DEC-023;
commands go to the API's fake adapter), offline device behaviour and credential caches (DEC-032),
and the access hardware policy (POL-043).

## SCR-S-57 Accounting export batches (`/finance/accounting-exports/*`)

**Verified** in jsdom (`accounting-exports/__tests__/AccountingExportsScreen.test.tsx`):

- Batches by status (`GET /v1/accounting-export-batches`, paged) with period, line count and
  per-currency totals; preparing one for a period (`POST /v1/accounting-export-batches`). An
  unmapped account refuses the preparation (ACCOUNTING_MAPPING_REQUIRED) and each account links to
  proposing its mapping; NOTHING_TO_EXPORT says the period has nothing left. Periods are entered and
  shown in UTC: an export period is organization-wide and no facility zone applies.
- A batch with its lines (`GET /v1/accounting-export-batches/{id}`); submitting a prepared batch with
  `expectedRevision` (`POST .../submit`); no answer locks it and retries with the same key; the
  API's unknown outcome is "recovery required" owned by the finance operator queue and reconciled by
  the API, never resent; rejected lists its lines as not exported, to be exported again; canceling
  a prepared batch with a reason and `expectedRevision` (`POST .../cancel`, never gated;
  STALE_REVISION offers Reload).
- Mappings (`GET /v1/accounting-mappings`, paged, status and account filters) with the ledger
  accounts still without an approved mapping (shown once every approved mapping is loaded);
  proposing one (`POST /v1/accounting-mappings`); approval by another person with
  `expectedRevision` (the proposer is told another person approves; FOUR_EYES_REQUIRED explained);
  withdrawing or retiring with a reason and `expectedRevision` (never gated).

**Pending decision**: the accounting system, its connection and export format, revenue recognition
(DEC-022): only the API's fake connection exists.

## API issues found while building these screens

- No `GET /v1/access-devices/{id}`: the device page finds the device in its facility's list
  (`apps/api/src/modules/entry/controllers/access-hardware.controller.ts`).
- No list of the sales of a register session, nor of a register's past sessions: a sale is reached
  from the page that started it or by its reference, and closing reports only the count of open
  sales (`apps/api/src/modules/finance/controllers/pos.controller.ts`).
- `GET /v1/exceptions` cannot filter by category or affected record, so the hardware exceptions are
  the facility's unresolved exceptions filtered on the page; one may sit on a later page (the page
  says "on the loaded pages"). An inbox dead letter (`reliability.inbox_dead_letter`) has no
  facility, so a facility's list never shows a dead access event's exception.
- `GET /v1/provider-events` filters `eventType` by exact value and has no facility or device
  filter: the event ingestion list is organization-wide and filtered to hardware event types on the
  page.
- The entry module's facility operations queue (`front_desk`, an engineering proposal pending
  DEC-015) cannot be set per facility (`entry.policy.ts`); the page shows whatever queue the
  exception records.
- A POS sale, tender, return and register session name people by id only (`openedByPersonId`,
  `recordedByPersonId`, ...); names come from the identity read per person.
