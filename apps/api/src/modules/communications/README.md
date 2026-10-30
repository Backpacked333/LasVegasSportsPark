# communications module

**Owns:** notifications, notification recipients, delivery attempts, communication preferences
(and their import records), notification acknowledgments, calendar feeds, push device registrations,
activity reminder marks, person-merge follow-ups, and its own calendar-entry projection of scheduled
events.

**Specification:** §3.18 (SPK-COMMS-001..008), §4.4 Communications (Notification, DeliveryAttempt,
Preference, Acknowledgment), §4.5 "Messages must represent actual delivery states", §4.7 invariant
10 ("No protected message dispatched using revoked authority"), SPK-IAM-006, SPK-AT-017,
SPK-UX-003/006 (inbox, failed urgent communications).

**Migration range:** `packages/db/migrations/1000_communications_*.sql` … `1099` (this module uses
`1000` to `1008`; stage 3 added `1004` to `1008`).

**Depends on:** identity (`PERSON_DIRECTORY_PORT` incl. `displayNames` and `personIdsResolvingTo`
(IF-09), `AUTHORITY_LOOKUP_PORT`, `STAFF_DIRECTORY_PORT`, `PeopleService` for contact points;
events `identity.access_grant_revoked`, `identity.access_restricted`, `identity.account_relinked`
(IF-17), `identity.persons_merged` (IF-21)), scheduling (`scheduling.event_changed` and
`scheduling.schedule_published` events, `EventDetails` shape), competition (`ROSTER_PORT`,
`TEAM_ENTRY_QUERY_PORT` incl. `roleHolders` (IF-15), `FIXTURE_PORT`; events
`competition.team_invitation_created`, `competition.result_published`,
`competition.availability_requested` (IF-45)), kernel (`INTEGRATION_REGISTRY` (IF-04),
`PeriodicJobRegistry` (IF-24), module settings (IF-43), import provenance (IF-40),
`FacilityDirectory`). It never writes another module's tables (§4.2).

**Status: implemented** — verified by `apps/api/src/modules/communications/__tests__` and the unit
specs next to the code (`communications.machines.spec.ts`, `calendar/ics.spec.ts`,
`providers/fake-messaging.provider.spec.ts`, `services/schedule-notices.spec.ts`), on PGlite and on
PostgreSQL (`TEST_DATABASE_URL`). Statements below are **verified** unless marked **proposed** or
**pending** (§6.7). The stage-3 work items (COM-01 … COM-06) are summarised in
[Stage 3](#stage-3-com-01--com-06).

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
  `delivered → read | acknowledged`; `read → acknowledged`. A retry of a `failed` attempt is a new
  attempt row naming it (`retry_of_attempt_id`, COM-02); the failed fact is never rewritten.
- PushDevice (COM-01): `active → revoked`; a revoked registration is never reactivated.

## Tables (migrations `1000` to `1008`)

| Table                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications`                                                               | kind (SPK-COMMS-002 triggers + `staff_broadcast`), category `operational/promotional` (SPK-COMMS-007), subject record, audience jsonb, title/body, `details_before/after` (SPK-COMMS-005), `protected`, `scheduled_for`, status, `supersedes_notification_id` / `superseded_by_notification_id`, suppression reason, operation, revision |
| `notification_recipients`                                                     | one row per person per notification: `resolved_basis` (`self`, `receive_messages`, `staff_role`, `team_member`, `explicit`), `basis_detail`, `subject_person_ids` (who justified inclusion), status `pending/authorized/revoked`, instants, revision                                                                                     |
| `delivery_attempts`                                                           | per recipient and channel (`in_app`, `push`, `email`, `sms`): provider, provider message id, status, `queued_at/attempted_at/accepted_at/delivered_at/failed_at/read_at/acknowledged_at`, provider response, failure code, error, lease (`ready_at`, `locked_until`), revision                                                           |
| `communication_preferences`                                                   | per person × channel × category: enabled flag; the database refuses `operational + in_app + false` (SPK-COMMS-007)                                                                                                                                                                                                                       |
| `notification_acknowledgments`                                                | append-only (`forbid_mutation`), at most one per recipient, `via`, note                                                                                                                                                                                                                                                                  |
| `calendar_feeds`                                                              | owner, label, `token_hash` (unique; the token itself is never stored), scope (other people in the feed), access counters, revocation (attributed), revision                                                                                                                                                                              |
| `calendar_entries` (+`_parties`)                                              | this module's projection of scheduled events built from `scheduling.event_changed`: stable `event_id` (the iCalendar UID), `sequence` bumped per change, status, parties (team / person)                                                                                                                                                 |
| `push_devices` (1004)                                                         | one registration per app install and account: person, account, platform, `token` (kept only while active), `token_hash` (SHA-256; one active registration per token), `token_hint`, app version, status `active/revoked`, last seen, revocation reason, revision                                                                         |
| `delivery_attempts.retry_of_attempt_id` (1005)                                | the failed attempt a retry repeats; trigger `delivery_attempts_retry_guard` refuses a source that is not `failed`, failed `RECIPIENT_REVOKED`/`SUPERSEDED`, or of another recipient or channel; one retry per source                                                                                                                     |
| `communication_preferences.source` (1006), `communication_preference_imports` | who last wrote a stored choice (`person` / `import`); one append-only import record per import record id with its content and outcome                                                                                                                                                                                                    |
| `reminder_marks` (1007)                                                       | append-only, one row per (scheduling event, event revision) reminded; `notifications.kind` gains `availability_request`, `activity_reminder`                                                                                                                                                                                             |
| `communication_merge_follow_ups` (1008)                                       | append-only, one row per person merge followed: survivor, merged person, the survivor's stored preference revisions at that moment, the conflicts found                                                                                                                                                                                  |

Database-enforced invariants (tests in `__tests__/schema-invariants.spec.ts`): organization scope
and composite `(organization_id, id)` foreign keys everywhere (an attempt or acknowledgment names a
recipient of its own notification, and an acknowledgment one of that recipient's attempts:
migration `1003`); status/kind/category/channel check
constraints equal to the machines; timestamps consistent with states (`failed ⇔ failed_at`,
`delivered/read/acknowledged ⇒ delivered_at`, …); `in_app ⇔ provider = 'in_app'`; one notice per
source domain event; one recipient per person per notification; at most one live (non-failed)
attempt per recipient and channel; a provider message id maps to one attempt; one acknowledgment per
recipient; unique token hashes; one calendar entry per event. Stage 3 (tests in the COM spec files
named below): one active push registration per device token, `token` present exactly while active,
revocation timestamped and explained; one retry per failed attempt and only of a retryable failure of
the same recipient and channel; preference sources limited to `person`/`import`; one reminder mark
per event revision; import records, reminder marks and merge follow-ups append-only
(`forbid_mutation`).

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/communications.ts`)

| Method | Path                                    | Who (action)                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/notifications`                        | composer roles (`communications.compose`): compose against an audience; `protected` marks participant-private content; `scheduledFor` makes a reminder                                                                                                                                                                    |
| GET    | `/notifications`, `/notifications/{id}` | reader roles (`communications.read_notification`), newest first, filters status/kind/facility, cursor paging                                                                                                                                                                                                              |
| GET    | `/notifications/{id}/recipients`        | composer roles (`communications.preview_recipients`): names, basis and a count from CURRENT permissions; never contact details (SPK-COMMS-006)                                                                                                                                                                            |
| POST   | `/notifications/{id}/send`              | composer roles (`communications.send`): resolves recipients now, suppresses obsolete unsent notices about the same subject, creates an operation, requests delivery                                                                                                                                                       |
| GET    | `/notifications/{id}/deliveries`        | reader roles: recipients (with `displayName`, COM-02) and attempts (with `retryOfAttemptId`) with their actual states (SPK-COMMS-004, SPK-UX-006)                                                                                                                                                                         |
| GET    | `/me/inbox`                             | self: in-app attempts newest first (`unreadOnly`), cursor paging (SPK-UX-003); each item carries `revision` and `subjectPersonIds` (COM-02); after a merge, also the merged person's notices (COM-05)                                                                                                                     |
| POST   | `/me/inbox/{id}/read`, `/acknowledge`   | self (`communications.acknowledge`); `expectedRevision` honoured (STALE_REVISION); another person's notice is NOT_FOUND; acknowledgment recorded once                                                                                                                                                                     |
| GET    | `/me/communication-preferences`         | self: the effective 4 × 2 matrix with `stored` and `locked` flags                                                                                                                                                                                                                                                         |
| PATCH  | `/me/communication-preferences`         | self (`communications.manage_preferences`); disabling operational in-app is refused by the service and the database                                                                                                                                                                                                       |
| GET    | `/me/calendar-feeds`                    | self: feeds without tokens                                                                                                                                                                                                                                                                                                |
| POST   | `/me/calendar-feeds`                    | self (`communications.manage_calendar_feeds`); including another person requires `view` over them (`communications.include_in_calendar_feed`, otherwise NOT_FOUND)                                                                                                                                                        |
| POST   | `/me/calendar-feeds/{id}/revoke`        | owner only; future fetches answer 404 (SPK-COMMS-008, SPK-IAM-006)                                                                                                                                                                                                                                                        |
| GET    | `/calendar-feeds/{token}.ics`           | public, token-authorized `text/calendar`; unknown, malformed or revoked tokens are NOT_FOUND; scope re-checked on every fetch                                                                                                                                                                                             |
| POST   | `/delivery-attempts/{id}/retry`         | general manager, system administrator, support (`communications.retry_delivery`, COM-02): one failed push/email/SMS attempt as a new queued attempt; `unknown` → INVALID_TRANSITION, revoked recipient → RESOURCE_CONFLICT `RECIPIENT_REVOKED`, second retry → `ALREADY_RETRIED`, obsolete notice → `NOTICE_SUPERSEDED`   |
| POST   | `/me/push-devices`                      | self (`communications.register_push_device`, COM-01): register `{ platform, token, appVersion? }`; same token and account refreshes the row; a token active for another account is moved (the older row revoked `reregistered`); the token is never returned (`tokenHint`)                                                |
| GET    | `/me/push-devices`                      | self: the signed-in account's devices, token hints only                                                                                                                                                                                                                                                                   |
| POST   | `/me/push-devices/{id}/revoke`          | self, own account's device only (another's is NOT_FOUND): `{ reason }`; erases the token, nothing more is pushed to it                                                                                                                                                                                                    |
| POST   | `/webhooks/messaging/{provider}`        | public, signed receipt from the (fake) messaging provider; recorded once in the kernel inbox (202 with `duplicate`), applied by the inbox worker. The fake provider's secret is a published test constant, so the endpoint answers NOT_FOUND in production; a receipt resolves only attempts of the provider that sent it |

Every consequential POST/PATCH is `@Idempotent()` and zod-validated; the stage-3 write routes carry
`@NoRecordAuthority('Not a §5.3 record category')` (IF-41); every write runs in
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
  lock lease (`FOR UPDATE SKIP LOCKED`), resolves the addresses — email and SMS through identity's
  `PeopleService` (contact points are never copied), push to every active registered device of the
  person (COM-01) — then in one transaction locks the recipient and the attempt,
  re-checks a protected recipient (invariant 10) and marks `attempted_at` only if the attempt is
  still queued, unmarked and held under this worker's lease (renewing it for the call); after that
  commits it calls the provider OUTSIDE any transaction and records exactly its answer:
  `provider_accepted`, `failed` (`PROVIDER_REJECTED`, `NO_ADDRESS`, `PROVIDER_ERROR`,
  `RECIPIENT_REVOKED`, `SUPERSEDED`) or `unknown`. An attempt of a notice found superseded inside
  that transaction fails `SUPERSEDED` and is never handed over. A revocation that commits first fails the attempt and nothing is
  sent; one processed later finds the hand-off committed and leaves it alone, so the record matches
  what the provider received. An attempt another poller re-claimed after the lease expired is
  skipped, so it reaches the provider once; an interrupted hand-off is recorded `unknown` and never
  retried blindly (§4.12). A failed essential notice raises a `front_desk` operational exception
  (SPK-UX-006); a revocation, a superseded (obsolete) notice, or a push to a person with no
  registered device (`NO_ADDRESS` on push, COM-01) is not raised.
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
  calendar projection last applied (a late retry or another worker's order) is ignored and
  composes nothing — ordered by the event `revision` the payload carries (stored as
  `calendar_entries.source_revision`, migration 1002), and by the UUID v7 outbox id only for
  changes without a revision or of equal revision, so clock skew between instances cannot reorder
  them — so it can neither roll the feed back with a higher `SEQUENCE` nor
  supersede the current notice; `scheduling.schedule_published`
  composes a staff summary for schedulers and league managers of the facility. Draft events
  produce nothing (SPK-SCHED-005).
- **Obsolete reminders** (SPK-COMMS-005): queuing a `schedule_changed` or `cancellation` about a
  subject suppresses unsent `schedule_published/schedule_changed` notices about the same subject
  (`obsolete`, `supersedes_notification_id`) and points dispatched ones at the newer notice
  (`superseded_by_notification_id`, shown in the inbox); their push/email/SMS attempts not yet
  handed to a provider are failed with `SUPERSEDED` in the same transaction (migration 1001), so
  a stale "moved" never arrives after the cancellation. Delivered in-app items stay.
- **Preferences** (SPK-COMMS-007): operational and promotional choices are separate rows; defaults
  come from `COMMUNICATIONS_POLICY`; the operational in-app notice is locked on.
- **Calendar feeds** (SPK-COMMS-008): 32 random bytes, hash stored; the ICS uses the scheduling
  event id as UID and `SEQUENCE` per change; every fetch re-checks `view` over each person in scope
  and includes the team entries each person is on; revocation stops future access (404) and cannot
  recall what an external calendar already fetched.

## Ports (`ports.ts`)

- `CHANNEL_PROVIDERS` (`ChannelProviderPort[]`): `send(request) → accepted | failed | unknown`,
  called outside any transaction; the request carries `addresses[]` (one email address or phone
  number, or every active push token). Shipped: `FakePushProvider`, `FakeEmailProvider`,
  `FakeSmsProvider` (`providers/fake-messaging.provider.ts`) with the four §5.2 scenarios — success,
  failure (`+fail` or scripted), timeout/unknown (`+unknown`, scripted `unknown` or `throw`) and
  duplicate (a second hand-off of an accepted attempt answers the same message id and sends
  nothing; a repeated receipt id is recorded once by the kernel inbox) — and signed receipts
  (`receipt()`) for the webhook. The push fake fans out per device (`deviceSends`). No vendor SDK
  (§5.2, DEC-020). All three are in the kernel integration register as
  `communications.{push,email,sms}_provider` (gate `messaging`, `productionAllowed: false`,
  reconciliation owner `front_desk`; COM-01, K-09).
- `TEAM_MEMBERSHIP_PORT` (`TeamMembershipPort`): `membersOf`, `isMember`, `teamEntriesOf`,
  implemented by `CompetitionTeamMembership` over competition's `ROSTER_PORT` and
  `TEAM_ENTRY_QUERY_PORT` at the clock: the effective roster plus the captain and co-captain role
  holders with or without a roster row (`roleHolders`, COM-03).
- `COMMUNICATIONS_POLICY` (`communications.policy.ts`): default channels per category, the
  category of each kind (`categoryByKind`, SPK-COMMS-007: every SPK-COMMS-002 trigger is
  operational, `renewal_opportunity` promotional, `staff_broadcast` must name its category; a
  contradicting category is `VALIDATION_FAILED` `CATEGORY_MISMATCH`, a missing one
  `CATEGORY_REQUIRED`; proposed split pending DEC-062), delivery lease and batch size,
  supersedable/superseding kinds, feed window, iCalendar product id.
- `CHANGE_NOTICE_CHECK_IMPL` (competition's `ChangeNoticeCheckPort`, `ChangeNoticeCheck`): fixture
  readiness "material change notifications" (SPK-READY-001) from this module's own evidence — the
  schedule-change notice of the fixture's scheduling event that describes its current time, and its
  delivery attempts: satisfied when every authorized recipient has a provider-accepted (or better)
  attempt, unsatisfied when nobody could be told or all attempts of a recipient failed, otherwise
  `unknown`. **Verified** (`apps/api/src/__tests__/cross-module-ports.spec.ts`).
- For other modules: `NotificationsService.compose / composeAndQueue / composeAndQueueIn(trx, …)`
  (the `ComposeInput` carries `sourceEventId` so a replayed handler never composes twice),
  `PreferencesService.enabledChannels`, `InboxService`, `CalendarFeedsService`,
  `CommunicationPreferencesService.importPreferences` (IF-40, the migration module's import
  provider; the same class as `PreferencesService`), `PushDevicesService`, `DeliveryRetryService`.
- Fixtures for downstream tests: `testing/communications-fixtures.ts` (`fakeProviders`,
  `dispatchOutbox`, `deliverQueued`, `composeAndDispatch`, `recordReceipt`, `attemptsOf`,
  `recipientsOf`, `inboxOf`, `registerPushDeviceFixture` — a test that expects a push to reach
  someone registers a device for them first); use with
  `createTestApp({ imports: [CommunicationsModule], principalResolver: 'module' })` and the
  identity fixtures.

### Session participants (SPK-AT-009, SPK-COMMS-002) — verified

`SESSION_AUDIENCE_PORT` (implemented by enrollment as `SESSION_AUDIENCE_IMPL`, resolved lazily, none
without enrollment): a scheduling event that commits no person or team (a youth session) still gets
its change or cancellation notice to the enrolled and booked participants of the catalog sessions
behind it (their guardians through `receive_messages`); such a notice is `protected`, so recipients
are re-checked before dispatch. A closure preview lists unsent notices about affected events
(`impact.messages`). **Verified**: `apps/api/src/__tests__/journeys/spk-at-009.spec.ts`.

## Events (`communications.events.ts`)

`communications.notification_composed`, `communications.notification_queued`,
`communications.delivery_requested` (consumed by this module's dispatch handler),
`communications.notification_dispatched`, `communications.notification_suppressed`,
`communications.recipient_revoked`, `communications.delivery_provider_accepted`,
`communications.delivery_delivered`, `communications.delivery_failed`,
`communications.delivery_unknown`, `communications.notification_read`,
`communications.notification_acknowledged`, `communications.calendar_feed_created`,
`communications.calendar_feed_revoked`, and (stage 3) `communications.delivery_retry_queued`,
`communications.push_device_registered`, `communications.push_device_revoked`. Payloads carry
identifiers only (never a push token).

Handlers registered: `communications.dispatch_notification` (`communications.delivery_requested`),
`communications.schedule_change_notice` (`scheduling.event_changed`),
`communications.schedule_published_summary` (`scheduling.schedule_published`),
`communications.reevaluate_revoked_grant` (`identity.access_grant_revoked`),
`communications.reevaluate_restricted_access` (`identity.access_restricted`),
`communications.revoke_push_on_relink` (`identity.account_relinked`, failure owner support),
`communications.follow_person_merge` (`identity.persons_merged`, failure owner support),
`communications.notify_team_invitation` (`competition.team_invitation_created`),
`communications.notify_result_published` (`competition.result_published`),
`communications.notify_availability_request` (`competition.availability_requested`) (the last three
with failure owner league manager), inbox handler `communications.delivery_receipt` (provider
`fake-messaging`). Periodic job `communications.compose_activity_reminders` (300 s, failure owner
support).

## Policy defaults (proposed, pending operator decisions DEC-012, DEC-020, DEC-062)

- Channel use is not yet approved by the operating team (SPK-COMMS-001). The mechanism exists; the
  defaults in `DEFAULT_COMMUNICATIONS_POLICY` are: operational → in-app (locked), push, email on,
  SMS off; promotional → in-app and email on, push and SMS off (so marketing never pushes over
  today's activity, SPK-UX-003).
- `schedule_published`, `schedule_changed` and (stage 3) `activity_reminder` notices are
  supersedable, by `schedule_changed` and `cancellation` notices about the same subject.
- `availability_request` and `activity_reminder` are operational kinds (proposed split, DEC-062).
- Calendar feeds cover 30 days back and 365 days ahead.
- **Pending (DEC-012): the activity reminder lead time.** `COMMUNICATIONS_ACTIVITY_REMINDER_LEAD_MINUTES`
  (module settings, IF-43) has no default; unset, no activity reminder is composed. Whether and when
  invitations to contact details are messaged by the platform is part of the same decision.
- **Pending (DEC-020, DEC-061): push.** The push provider is not selected (fake adapter only) and
  the app's push registration (bundle identifiers, permission prompts) waits for DEC-061; the device
  registry and addressing are built against the port.

## Stage 3 (COM-01 … COM-06)

No communications behaviour is a Package G capability: none of the K-12 capability switches
(DEC-016) applies to this module, so nothing here is behind a capability switch. What stays
undecided is policy and provider choice, kept as configuration without defaults or as fakes:
channel approval and the essential/promotional split (DEC-012, DEC-062), the reminder lead time
(DEC-012), the messaging provider (DEC-020) and app push registration (DEC-061).

- **COM-01 push devices — verified** (`__tests__/push-devices.spec.ts`): register, refresh on
  re-registration (one row), move a token from another account (older row revoked
  `reregistered`, one transaction, a racing duplicate insert retries once; concurrent registrations
  leave one active row on PGlite and PostgreSQL), list and revoke; the token is never returned,
  logged, audited or put in an event (`tokenHint`); push fans out to every active device and never
  to a revoked one; no device → `NO_ADDRESS` without a front-desk exception, the in-app notice is
  delivered; `identity.account_relinked` revokes the account's devices last registered or
  refreshed at or before the relink instant, the event's `occurredAt` (`account_relinked`,
  SPK-AT-025, §4.12, replay-safe; the audit records the instant). A device the recovered sign-in
  registers or refreshes before a late follow-up runs stays active. Not covered: a registration by
  the old sign-in whose request was authenticated before the relink committed, but whose
  transaction is stamped after the relink instant, also stays active (a window of milliseconds).
  The database refuses two active registrations of one token and inconsistent
  token/status/revocation columns; push, email and SMS fakes are in the integration register
  (DEC-020).
- **COM-02 retry, names, inbox revision — verified** (`__tests__/delivery-retry.spec.ts`): a failed
  external attempt is retried as a new queued attempt (the failed row untouched, audited with the
  reason, delivered by the next worker pass); front desk is refused; a second retry, an `unknown`, a
  queued, an in-app attempt and a revoked recipient (re-checked as at dispatch) are refused with
  nothing queued; the database trigger and unique index refuse the same; `GET …/deliveries` names
  every recipient (`displayName`, identity's `displayNames`); inbox items carry `revision` and
  `subjectPersonIds`, and read/acknowledge refuse a stale `expectedRevision`.
- **COM-03 team role holders and competition notices — verified**
  (`__tests__/competition-notices.spec.ts`): a co-captain (and a captain) without a roster row is a
  team-audience recipient while the role is effective, re-checked at dispatch when it ends;
  `competition.team_invitation_created` with a known recipient queues one protected
  `team_invitation` notice (the invitee if an adult, a child invitee's guardian through
  `receive_messages`), a contact-only invitation queues none; `competition.result_published` queues
  one `result_published` notice to both entries' team audiences.
- **COM-04 preference import — verified** (`__tests__/preference-import.spec.ts`):
  `importPreferences` is refused for any principal but the batch's import principal; importing twice
  writes once (same outcome, one record, one audit); different content is
  `IMPORT_CONTENT_MISMATCH`; the mandatory operational in-app notice stays on whatever is imported;
  a person's own later choice is kept by later imports.
- **COM-05 person merge follow-up — verified** (`__tests__/person-merge.spec.ts`, merges through
  identity's API): the survivor's inbox lists, reads and acknowledges the merged person's notices
  (a protected one re-checked for the survivor) without rewriting a row; disagreeing explicit
  preferences resolve to opted out and raise one `communications.merged_preference_conflict`
  exception for support; the mandatory in-app notice still goes out; the survivor's own later
  choice wins; a replayed merge event raises nothing new. **Proposed:** identity's merge chain is
  consulted only when a merge involves the person (their canonical id differs, or this module has
  followed a merge into them), so until the follow-up of a fresh merge has run the survivor reads
  only their own rows (`services/merged-persons.ts`).
- **COM-06 availability requests and activity reminders — verified**
  (`__tests__/competition-notices.spec.ts`, `__tests__/activity-reminders.spec.ts`):
  `competition.availability_requested` queues one protected `availability_request` notice per
  request (adult players themselves, guardians of child players), with the fixture start in the
  facility's zone; a replayed event queues nothing; without
  `COMMUNICATIONS_ACTIVITY_REMINDER_LEAD_MINUTES` the reminder job composes nothing; with it each
  published event revision starting within the lead time is reminded once (a second pass or a
  concurrent worker composes nothing, a moved event is reminded again for its new revision and its
  old reminder's unsent part is superseded); the database refuses a second mark per revision and
  any change to a mark.

**Integration notes (stage-3 branch).** `PersonDirectoryPort.displayNames` /
`personIdsResolvingTo` (identity, ID-01) and `TeamEntryQueryPort.roleHolders` (competition,
CMP-01) are declared on the core branch and implemented on their owners' branches; this module's
tests run with `__tests__/support.ts` doubles that answer from the owner's implementation when
present and otherwise follow the declared contract. On this branch alone, other modules' flows that
resolve a team audience or read `GET /notifications/{id}/deliveries` reach the declared stubs until
those branches are merged. The new routes need `docs/api/openapi.json` regenerated
(`pnpm build && pnpm openapi`) and are classified with `@NoRecordAuthority`, which the migration
module's route classification counts once MIG-00 lands.

## Kernel notes

- The kernel's outbox dispatcher runs every handler inside a transaction with its consumption
  record, so the provider call cannot live in the `communications.delivery_requested` handler
  itself (§4.11). The handler does the transactional half (recipient re-check, attempts) and
  `DeliveryWorker` performs the hand-off outside any transaction, nudged after commit and otherwise
  driven by its own poll loop (`start()` in every non-test process; tests call `runOnce()`).
- Webhook receipts are authenticated with the fake provider's HMAC secret (`FakeMessagingProvider`);
  a real adapter verifies its own signature scheme before `Inbox.record`.

## Known gaps

- Pending: a per-person authority basis for protected notices to explicitly chosen people (an
  identity port for "active staff at facility"); until then protected content goes only through
  subject persons, team entries (roster and captain/co-captain holders) and staff roles.
- Customer audiences (subject persons, team entries, person ids) are not scoped by facility: persons
  are organization-wide, and what makes a customer audience "authorized" for a composer is
  POL-024 / DEC-012 (pending decision). Only the facility dimension is enforced today.
- A grant revocation that commits while the worker's hand-off claim transaction is open is ordered
  after that hand-off (identity's relationship authority reads grants without `FOR SHARE`); the
  record stays truthful, the window is one short transaction.
- A child leaving a team's roster is caught by the re-checks at dispatch, at the hand-off and in the
  inbox; there is no `competition.roster_changed` consumer failing queued attempts promptly.
- Activity reminders cover published events of this module's calendar projection that carry an
  event revision (entries projected before migration 1002 are reminded after their next change);
  composed reminders go out at once, not at a chosen instant before the start.
- A retry re-sends one attempt; there is no re-route to another channel and no bulk retry. Queuing
  a retry does not close the failed attempt's `communications.delivery_failed` exception; closing it
  stays a staff step.
- Triggers other than schedule publication/change/cancellation, team invitations, results and
  availability requests (registration outcome, placement, waitlist offer, payment attention,
  assignment offer, renewal, approved youth feedback) are composed by their owning modules through
  `NotificationsService.composeAndQueueIn` (IF-22); invitations addressed only to a contact detail
  are not messaged by the platform (DEC-012).
- Push: a provider's "token no longer valid" answer does not revoke the device yet (the fake has no
  such outcome); a merged person's devices keep addressing the merged person until the app
  re-registers under the survivor's account (a refresh takes the account's current person over).
- A protected notice reached through a team role or roster row of a merged person is not served to
  the survivor's inbox (team membership is checked for the survivor's own id); unprotected ones are.
- The ICS feed is a projection of `scheduling.event_changed`; it carries the facility zone in the
  description and UTC instants, not VTIMEZONE blocks.
