# communications module

**Owns:** notifications, notification recipients, delivery attempts, communication preferences,
notification acknowledgments, calendar feeds, and its own calendar-entry projection of scheduled
events.

**Specification:** §3.18 (SPK-COMMS-001..008), §4.4 Communications (Notification, DeliveryAttempt,
Preference, Acknowledgment), §4.5 "Messages must represent actual delivery states", §4.7 invariant
10 ("No protected message dispatched using revoked authority"), SPK-IAM-006, SPK-AT-017,
SPK-UX-003/006 (inbox, failed urgent communications).

**Migration range:** `packages/db/migrations/1000_communications_*.sql` … `1099` (this module uses
`1000`).

**Depends on:** identity (`PERSON_DIRECTORY_PORT`, `AUTHORITY_LOOKUP_PORT`, `STAFF_DIRECTORY_PORT`,
`PeopleService` for display names and contact points), scheduling (`scheduling.event_changed` and
`scheduling.schedule_published` events, `EventDetails` shape), competition (`ROSTER_PORT`,
`TEAM_ENTRY_QUERY_PORT` for team audiences and calendar scopes). It never writes another module's
tables (§4.2).

**Status: implemented** — verified by `apps/api/src/modules/communications/__tests__` and the unit
specs next to the code (`communications.machines.spec.ts`, `calendar/ics.spec.ts`,
`providers/fake-messaging.provider.spec.ts`, `services/schedule-notices.spec.ts`). Statements below
are verified unless marked proposed or pending.

## Model

A notification is composed once (by staff or by another module's handler), its **audience** is a
definition (subject persons, team entries, staff roles, explicit person ids), never a stored list of
people. Recipients are resolved from **current** permissions when the send is confirmed, re-checked
when the follow-up dispatches, and — for protected content — re-checked once more immediately before
an external provider is called (SPK-COMMS-003). Every hand-off to a channel is a **delivery attempt**
whose state is exactly what the platform knows (SPK-COMMS-004): `queued`, `provider_accepted`,
`delivered` (confirmed by the platform for in-app, by a receipt for external channels), `failed`,
`unknown` (kept explicit until a receipt resolves it), `read`, `acknowledged`. A push is never marked
delivered without a receipt.

Lifecycles (`communications.machines.ts`; the database check constraints list exactly these states):

- Notification: `composed → queued → dispatched`; `composed | queued → suppressed` (obsolete,
  no recipients, authority revoked).
- Recipient: `pending → authorized | revoked`; `authorized → revoked` while nothing external has
  been handed over.
- DeliveryAttempt: `queued → provider_accepted | delivered | failed | unknown`;
  `provider_accepted → delivered | failed | unknown`; `unknown → provider_accepted | delivered | failed`;
  `delivered → read | acknowledged`; `read → acknowledged`.

## Tables (migration `1000_communications_core.sql`)

| Table                            | Purpose                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications`                  | kind (SPK-COMMS-002 triggers + `staff_broadcast`), category `operational/promotional` (SPK-COMMS-007), subject record, audience jsonb, title/body, `details_before/after` (SPK-COMMS-005), `protected`, `scheduled_for`, status, `supersedes_notification_id` / `superseded_by_notification_id`, suppression reason, operation, revision |
| `notification_recipients`        | one row per person per notification: `resolved_basis` (`self`, `receive_messages`, `staff_role`, `team_member`, `explicit`), `basis_detail`, `subject_person_ids` (who justified inclusion), status `pending/authorized/revoked`, instants, revision                                                                                     |
| `delivery_attempts`              | per recipient and channel (`in_app`, `push`, `email`, `sms`): provider, provider message id, status, `queued_at/attempted_at/accepted_at/delivered_at/failed_at/read_at/acknowledged_at`, provider response, failure code, error, lease (`ready_at`, `locked_until`), revision                                                           |
| `communication_preferences`      | per person × channel × category: enabled flag; the database refuses `operational + in_app + false` (SPK-COMMS-007)                                                                                                                                                                                                                       |
| `notification_acknowledgments`   | append-only (`forbid_mutation`), at most one per recipient, `via`, note                                                                                                                                                                                                                                                                  |
| `calendar_feeds`                 | owner, label, `token_hash` (unique; the token itself is never stored), scope (other people in the feed), access counters, revocation (attributed), revision                                                                                                                                                                              |
| `calendar_entries` (+`_parties`) | this module's projection of scheduled events built from `scheduling.event_changed`: stable `event_id` (the iCalendar UID), `sequence` bumped per change, status, parties (team / person)                                                                                                                                                 |

Database-enforced invariants (tests in `__tests__/schema-invariants.spec.ts`): organization scope
and composite `(organization_id, id)` foreign keys everywhere; status/kind/category/channel check
constraints equal to the machines; timestamps consistent with states (`failed ⇔ failed_at`,
`delivered/read/acknowledged ⇒ delivered_at`, …); `in_app ⇔ provider = 'in_app'`; one notice per
source domain event; one recipient per person per notification; at most one live (non-failed)
attempt per recipient and channel; a provider message id maps to one attempt; one acknowledgment per
recipient; unique token hashes; one calendar entry per event.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/communications.ts`)

| Method | Path                                    | Who (action)                                                                                                                                                        |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/notifications`                        | composer roles (`communications.compose`): compose against an audience; `protected` marks participant-private content; `scheduledFor` makes a reminder              |
| GET    | `/notifications`, `/notifications/{id}` | reader roles (`communications.read_notification`), newest first, filters status/kind/facility, cursor paging                                                        |
| GET    | `/notifications/{id}/recipients`        | composer roles (`communications.preview_recipients`): names, basis and a count from CURRENT permissions; never contact details (SPK-COMMS-006)                      |
| POST   | `/notifications/{id}/send`              | composer roles (`communications.send`): resolves recipients now, suppresses obsolete unsent notices about the same subject, creates an operation, requests delivery |
| GET    | `/notifications/{id}/deliveries`        | reader roles: recipients and attempts with their actual states (SPK-COMMS-004, SPK-UX-006)                                                                          |
| GET    | `/me/inbox`                             | self: in-app attempts newest first (`unreadOnly`), cursor paging (SPK-UX-003)                                                                                       |
| POST   | `/me/inbox/{id}/read`, `/acknowledge`   | self (`communications.acknowledge`); another person's notice is NOT_FOUND; acknowledgment recorded once                                                             |
| GET    | `/me/communication-preferences`         | self: the effective 4 × 2 matrix with `stored` and `locked` flags                                                                                                   |
| PATCH  | `/me/communication-preferences`         | self (`communications.manage_preferences`); disabling operational in-app is refused by the service and the database                                                 |
| GET    | `/me/calendar-feeds`                    | self: feeds without tokens                                                                                                                                          |
| POST   | `/me/calendar-feeds`                    | self (`communications.manage_calendar_feeds`); including another person requires `view` over them (`communications.include_in_calendar_feed`, otherwise NOT_FOUND)  |
| POST   | `/me/calendar-feeds/{id}/revoke`        | owner only; future fetches answer 404 (SPK-COMMS-008, SPK-IAM-006)                                                                                                  |
| GET    | `/calendar-feeds/{token}.ics`           | public, token-authorized `text/calendar`; unknown, malformed or revoked tokens are NOT_FOUND; scope re-checked on every fetch                                       |
| POST   | `/webhooks/messaging/{provider}`        | public, signed receipt from the (fake) messaging provider; recorded once in the kernel inbox (202 with `duplicate`), applied by the inbox worker                    |

Every consequential POST/PATCH is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and outbox follow-ups. Confirming a send creates an operation
(`communications.send_notification`, readable at `GET /v1/operations/{id}`) that succeeds when the
dispatch creates the attempts or suppresses the notice.

## Behaviour — verified

- **Audience resolution** (`services/audience-resolver.ts`, SPK-COMMS-003): subject persons → the
  person themself when an active adult (`self`) plus every active person currently holding
  `receive_messages` over them (identity's `AUTHORITY_LOOKUP_PORT`); team entries → the effective
  roster from competition's `ROSTER_PORT` treated as subject persons (`team_member`, guardians of
  child players through `receive_messages`); staff roles → identity's `STAFF_DIRECTORY_PORT` within
  the optional facility; explicit person ids. `isStillAuthorized` re-evaluates one recipient against
  the same sources: a recipient reached several ways is stored once with its first basis and every
  subject merged in, and the re-check requires each one (the `receive_messages` grant over every
  subject other than the person themself, and that subject still in the audience, so a guardian
  stops receiving a team's protected notices when the child leaves the roster); staff roles are
  re-checked in the audience's facility scope, the one resolution used.
- **Composition scope** (SPK-COMMS-006, §4.14): compose, preview and send authorize the audience's
  facility as well as the notification's own, and a facility-scoped composer cannot address a staff
  role across every facility. A protected notice refuses explicit person ids
  (`PROTECTED_EXPLICIT_RECIPIENT`): a person named by id carries no authority that could be
  re-checked, so an explicit basis never justifies protected content. `GET /notifications` lists,
  for a facility-scoped reader, only organization-wide notices and those of their facilities (the
  rows `GET /notifications/{id}` would allow).
- **Dispatch** (`communications.delivery_requested` handler → `NotificationsService.dispatch`): a
  protected notice re-checks every pending recipient; a recipient without authority becomes
  `revoked` and gets no attempt; the rest become `authorized`, an in-app attempt is created
  `delivered` (the platform delivers its own channel) and one `queued` attempt per external channel
  the person's preferences enable. A notice nobody may receive is `suppressed`
  (`authority_revoked` or `no_recipients`).
- **Delivery worker** (`services/delivery-worker.ts`, §4.11): claims queued external attempts with a
  lock lease (`FOR UPDATE SKIP LOCKED`), resolves the address through identity's `PeopleService`
  (contact points are never copied), then in one transaction locks the recipient and the attempt,
  re-checks a protected recipient (invariant 10) and marks `attempted_at` only if the attempt is
  still queued, unmarked and held under this worker's lease (renewing it for the call); after that
  commits it calls the provider OUTSIDE any transaction and records exactly its answer:
  `provider_accepted`, `failed` (`PROVIDER_REJECTED`, `NO_ADDRESS`, `PROVIDER_ERROR`,
  `RECIPIENT_REVOKED`) or `unknown`. A revocation that commits first fails the attempt and nothing is
  sent; one processed later finds the hand-off committed and leaves it alone, so the record matches
  what the provider received. An attempt another poller re-claimed after the lease expired is
  skipped, so it reaches the provider once; an interrupted hand-off is recorded `unknown` and never
  retried blindly (§4.12). A failed essential notice raises a `front_desk` operational exception
  (SPK-UX-006); a revocation is not a failure.
- **Receipts** (`DeliveryWorker.applyReceipt`, inbox provider `fake-messaging`): resolve
  `queued/provider_accepted/unknown` into `provider_accepted/delivered/failed`; duplicates and
  out-of-order receipts are ignored rather than rewriting a later fact.
- **Revocation** (SPK-IAM-006, SPK-AT-017): `identity.access_grant_revoked` (for `receive_messages`)
  and `identity.access_restricted` re-evaluate every pending or authorized recipient of a protected
  notice that is still queued or whose external attempts have not been handed over; those lose
  their attempts (`RECIPIENT_REVOKED`). The delivered in-app fact is not rewritten, but the inbox
  stops serving a protected notice to a recipient who no longer holds the authority that justified
  it, re-checked on every read; reading or acknowledging it then answers NOT_FOUND.
- **Schedule notices** (`services/schedule-notices.ts`, SPK-COMMS-002/005): `scheduling.event_changed`
  for a published event composes `schedule_published`, `schedule_changed` (old and new practical
  details rendered in facility-local time) or `cancellation` addressed to the committed parties,
  keyed on the source event id so a replay never composes twice; a change older than the one the
  calendar projection last applied (a late retry or another worker's order; outbox ids are UUID v7)
  is ignored and composes nothing, so it can neither roll the feed back with a higher `SEQUENCE` nor
  supersede the current notice; `scheduling.schedule_published`
  composes a staff summary for schedulers and league managers of the facility. Draft events
  produce nothing (SPK-SCHED-005).
- **Obsolete reminders** (SPK-COMMS-005): queuing a `schedule_changed` or `cancellation` about a
  subject suppresses unsent `schedule_published/schedule_changed` notices about the same subject
  (`obsolete`, `supersedes_notification_id`) and points delivered ones at the newer notice
  (`superseded_by_notification_id`, shown in the inbox).
- **Preferences** (SPK-COMMS-007): operational and promotional choices are separate rows; defaults
  come from `COMMUNICATIONS_POLICY`; the operational in-app notice is locked on.
- **Calendar feeds** (SPK-COMMS-008): 32 random bytes, hash stored; the ICS uses the scheduling
  event id as UID and `SEQUENCE` per change; every fetch re-checks `view` over each person in scope
  and includes the team entries each person is on; revocation stops future access (404) and cannot
  recall what an external calendar already fetched.

## Ports (`ports.ts`)

- `CHANNEL_PROVIDERS` (`ChannelProviderPort[]`): `send(request) → accepted | failed | unknown`,
  called outside any transaction. Shipped: `FakePushProvider`, `FakeEmailProvider`,
  `FakeSmsProvider` (`providers/fake-messaging.provider.ts`) with scripted outcomes, a `throw`
  scenario and signed receipts (`receipt()`) for the webhook. No vendor SDK (§5.2, DEC-020).
- `TEAM_MEMBERSHIP_PORT` (`TeamMembershipPort`): `membersOf`, `isMember`, `teamEntriesOf`,
  implemented by `CompetitionTeamMembership` over competition's `ROSTER_PORT` and
  `TEAM_ENTRY_QUERY_PORT` at the clock.
- `COMMUNICATIONS_POLICY` (`communications.policy.ts`): default channels per category, delivery
  lease and batch size, supersedable/superseding kinds, feed window, iCalendar product id.
- `CHANGE_NOTICE_CHECK_IMPL` (competition's `ChangeNoticeCheckPort`, `ChangeNoticeCheck`): fixture
  readiness "material change notifications" (SPK-READY-001) from this module's own evidence — the
  schedule-change notice of the fixture's scheduling event that describes its current time, and its
  delivery attempts: satisfied when every authorized recipient has a provider-accepted (or better)
  attempt, unsatisfied when nobody could be told or all attempts of a recipient failed, otherwise
  `unknown`. **Verified** (`apps/api/src/__tests__/cross-module-ports.spec.ts`).
- For other modules: `NotificationsService.compose / composeAndQueue / composeAndQueueIn(trx, …)`
  (the `ComposeInput` carries `sourceEventId` so a replayed handler never composes twice),
  `PreferencesService.enabledChannels`, `InboxService`, `CalendarFeedsService`.
- Fixtures for downstream tests: `testing/communications-fixtures.ts` (`fakeProviders`,
  `dispatchOutbox`, `deliverQueued`, `composeAndDispatch`, `recordReceipt`, `attemptsOf`,
  `recipientsOf`, `inboxOf`); use with
  `createTestApp({ imports: [CommunicationsModule], principalResolver: 'module' })` and the
  identity fixtures.

## Events (`communications.events.ts`)

`communications.notification_composed`, `communications.notification_queued`,
`communications.delivery_requested` (consumed by this module's dispatch handler),
`communications.notification_dispatched`, `communications.notification_suppressed`,
`communications.recipient_revoked`, `communications.delivery_provider_accepted`,
`communications.delivery_delivered`, `communications.delivery_failed`,
`communications.delivery_unknown`, `communications.notification_read`,
`communications.notification_acknowledged`, `communications.calendar_feed_created`,
`communications.calendar_feed_revoked`. Payloads carry identifiers only.

Handlers registered: `communications.dispatch_notification` (`communications.delivery_requested`),
`communications.schedule_change_notice` (`scheduling.event_changed`),
`communications.schedule_published_summary` (`scheduling.schedule_published`),
`communications.reevaluate_revoked_grant` (`identity.access_grant_revoked`),
`communications.reevaluate_restricted_access` (`identity.access_restricted`), inbox handler
`communications.delivery_receipt` (provider `fake-messaging`).

## Policy defaults (proposed, pending operator decisions DEC-012, DEC-020, DEC-062)

- Channel use is not yet approved by the operating team (SPK-COMMS-001). The mechanism exists; the
  defaults in `DEFAULT_COMMUNICATIONS_POLICY` are: operational → in-app (locked), push, email on,
  SMS off; promotional → in-app and email on, push and SMS off (so marketing never pushes over
  today's activity, SPK-UX-003).
- Only `schedule_published` and `schedule_changed` notices are supersedable, by `schedule_changed`
  and `cancellation` notices about the same subject.
- Calendar feeds cover 30 days back and 365 days ahead.
- Push addressing uses the person id as the registration handle until the native apps register
  devices (Package E); a real push adapter maps device tokens in `RecipientAddresses`.

## Kernel notes

- The kernel's outbox dispatcher runs every handler inside a transaction with its consumption
  record, so the provider call cannot live in the `communications.delivery_requested` handler
  itself (§4.11). The handler does the transactional half (recipient re-check, attempts) and
  `DeliveryWorker` performs the hand-off outside any transaction, nudged after commit and otherwise
  driven by its own poll loop (`start()` in every non-test process; tests call `runOnce()`).
- Webhook receipts are authenticated with the fake provider's HMAC secret (`FakeMessagingProvider`);
  a real adapter verifies its own signature scheme before `Inbox.record`.

## Known gaps

- Team audiences resolve to the effective roster (players with their roles); a captain or
  co-captain who holds a team role without a roster row is not reached through a team audience
  (competition exposes no "role holders of an entry" port yet). Name them explicitly in an
  unprotected notice or wait for that port; a protected notice cannot name explicit recipients.
- Pending: a per-person authority basis for protected notices to explicitly chosen people (an
  identity port for "active staff at facility", a competition port for team-role holders); until
  then protected content goes only through subject persons, team entries and staff roles.
- Customer audiences (subject persons, team entries, person ids) are not scoped by facility: persons
  are organization-wide, and what makes a customer audience "authorized" for a composer is
  POL-024 / DEC-012 (pending decision). Only the facility dimension is enforced today.
- A grant revocation that commits while the worker's hand-off claim transaction is open is ordered
  after that hand-off (identity's relationship authority reads grants without `FOR SHARE`); the
  record stays truthful, the window is one short transaction.
- A child leaving a team's roster is caught by the re-checks at dispatch, at the hand-off and in the
  inbox; there is no `competition.roster_changed` consumer failing queued attempts promptly.
- Reminders are a composed notice with `scheduledFor`; there is no recurring reminder scheduler.
- No retry/re-route command for failed deliveries (`communications.retry_delivery` in the
  permission matrix is proposed); a retry is a new attempt row once the command exists.
- Triggers other than schedule publication/change/cancellation (registration outcome, team
  invitation, placement, waitlist offer, payment attention, assignment offer, result publication,
  renewal, approved youth feedback) are composed by their owning modules through
  `NotificationsService.composeAndQueueIn`; the kinds exist, the handlers land with those modules.
- The ICS feed is a projection of `scheduling.event_changed`; it carries the facility zone in the
  description and UTC instants, not VTIMEZONE blocks.
