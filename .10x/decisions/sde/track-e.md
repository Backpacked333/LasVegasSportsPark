# SDE hand-off: Track E (PA-05 message templates and sequences)

Feature `glass-demo-amendments`. Status words follow §6.7. The requirement (SPK-COMMS-009) is
**Proposed** and its open values are **Pending decision** (DEC-099: the set of messages per
program, K1; who sends and on which days, K2; which reminders are automatic, K3). What is
described as built is **Verified** by the tests named, on PGlite and, where section 7 says so, on
a local PostgreSQL 16. Capability: `message_sequences`.

## 1. What was built

| Layer        | Files                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration    | `packages/db/migrations/1013_communications_message_sequences.sql` (`1014` to `1019` unused)                                                                                                                                                                                                                                                                                         |
| Schema types | `packages/db/src/schema/communications-sequences.ts` (new)                                                                                                                                                                                                                                                                                                                           |
| Contracts    | `packages/contracts/src/api/communications-sequences.ts` (new: vocabulary, placeholders, schemas, routes), `state-machines.ts` (`ScheduledMessageMachine`, in `ALL_STATE_MACHINES`), `api/communications.ts` (one export, `CommunicationsRequestText`, so both files share the request-text checks), `communications-sequences.spec.ts` (new)                                        |
| API module   | `apps/api/src/modules/communications/sequences/` (new: policy, `due-time`, `subject-facts`, shared mappers, templates service, sequences service, schedule service, the sending job), `controllers/message-sequences.controller.ts` (new), `communications.actions.ts`, `communications.events.ts`, `communications.machines.ts`, `communications.module.ts`, `index.ts`, `ports.ts` |
| Other ports  | competition: `ports.ts` (`SeasonSummary`, `TeamEntryQueryPort.findSeason`), `services/team-entries.service.ts` (its implementation), `__tests__/season-port.spec.ts`. Enrollment: `services/session-participants.ts` (`participantsOfOffering`), `__tests__/offering-audience.spec.ts`                                                                                               |
| API tests    | `communications/__tests__/message-sequences.spec.ts` (13), `message-sequences-schema.spec.ts` (13), `sequences/due-time.spec.ts` (5), `communications.machines.spec.ts` (one added)                                                                                                                                                                                                  |
| Staff        | `apps/staff/src/screens/communications/sequences/` (new: templates, sequences and schedule screens, the schedule link, labels, routes, styles, `__tests__/MessageSequences.test.tsx` with 13 tests)                                                                                                                                                                                  |
| Docs         | `apps/api/src/modules/communications/README.md` (a section with Verified, Proposed and Pending decision)                                                                                                                                                                                                                                                                             |
| Generated    | `docs/api/openapi.json`, `packages/api-client/src/generated/paths.ts`, `docs/package-a/permission-matrix.generated.md`, `packages/db/src/schema/index.ts`, `packages/contracts/src/api/index.ts`, `apps/api/src/__tests__/event-handler-manifest.json`                                                                                                                               |

Routes of the API (18): `GET /message-placeholders`; `GET`, `POST /message-templates`; `GET`,
`PATCH /message-templates/{id}`; `GET`, `POST /message-sequences`; `GET`,
`PATCH /message-sequences/{id}`; `POST /message-sequences/{id}/steps`;
`PATCH /message-sequences/{id}/steps/{stepId}`; `POST .../steps/{stepId}/remove`;
`GET /message-schedules/{subjectType}/{subjectId}`; `POST .../generate`;
`GET /scheduled-messages/{id}`; `GET .../preview`; `POST .../edit`, `/confirm`, `/skip`, `/restore`.

Actions (6, proposed roles): `communications.read_message_schedule` (the staff who read notices),
and for league manager, program manager, general manager and system administrator
`manage_message_templates`, `manage_message_sequences`, `preview_scheduled_message`,
`confirm_scheduled_message`, `skip_scheduled_message`. Events (3, no subscriber):
`communications.message_schedule_generated`, `scheduled_message_changed`, `scheduled_message_sent`.
Periodic job: `communications.send_scheduled_messages` (300 s, failure owner support).

How it works, in one paragraph: a template is a title and a text with `{{placeholders}}`; a
sequence (for seasons or for offerings, at one facility, optionally for one competition or
program, switched off until staff switch it on) has steps, each a template and days before or
after an anchor date at a facility-local time. A new season or a published offering gets one
scheduled message per step. Staff preview, edit, skip or confirm each one. Confirming stores the
exact text with the record's details; the job sends that text when it is due through
`NotificationsService.composeAndQueueIn`, with the audience as a definition read at that moment.

## 2. Deviations from the architect contract, and why

1. **The branch base.** The worktree was created at `main`; it was fast-forwarded to `48b91452`
   before any work. Commits are listed against that base.
2. **Six handlers, not two.** Besides `competition.season_created` and
   `catalog.offering_published` (which produce a schedule), four keep existing messages truthful:
   `competition.season_updated`, `competition.fixture_changed` (the first game is an anchor date
   and a placeholder), `catalog.offering_updated` and `catalog.offering_archived`. They never
   create and never send. "The due time follows a moved anchor" needs them; the job repeats the
   same review just before sending, so a date that moved without its event having been handled
   sends nothing either.
3. **What is sent is what was confirmed.** `scheduled_messages` stores the confirmed title and
   body (`confirmed_*`) beside the edited copy (`edited_*`). A confirmed message whose text would
   now differ (the template, the step or the record changed) returns to needing confirmation
   (`attention: text_changed`), like one whose date moved (`anchor_moved`). The contract named
   only the edited copy.
4. **No `template_id` on a scheduled message.** It reads its template through its step, so a step
   moved to another template is followed. What was sent keeps its own text.
5. **An `attention` column** (`anchor_moved`, `text_changed`, `no_audience`,
   `audience_too_large`) says why a message that had been confirmed waits again.
6. **`canceled`** is what an archived season or offering, or a removed step, does to its unsent
   messages. Staff do not cancel; they skip (and can bring a skipped message back).
7. **A template's category is fixed** (contract and database): a message confirmed as essential
   is never sent as promotional or the reverse (SPK-COMMS-007).
8. **A command to produce a schedule on request**
   (`POST /message-schedules/{subjectType}/{subjectId}/generate`), for a record that existed
   before its sequence did, or after a step was added. It is idempotent.
9. **Skipping a message and removing a step are not gated** by the capability: they create
   nothing (as removing a rental roster member is not). Everything that creates or confirms is.
10. **No new notification kind.** A scheduled message is sent as a `staff_broadcast` in the
    template's category, so no migration touches the kind check and the inbox needs nothing new.
    An offering's notice is `protected` (who is enrolled is customer-private).
11. **Two read-only port methods in other modules**, each with a test:
    `TeamEntryQueryPort.findSeason` (competition; no port answered a season's own dates and names)
    and `SessionAudiencePort.participantsOfOffering` (declared in communications' `ports.ts`,
    implemented by enrollment's `SessionParticipants`, resolved lazily as the existing method is).
    `CommunicationsModule` now imports `CatalogModule` for `OFFERING_LOOKUP_PORT` (catalog imports
    neither communications nor anything that does).
12. **A season has no facility.** A sequence belongs to one facility, which gives the zone its
    times are read in and the scope of the staff who manage it. For an offering the sequence's
    facility must be the offering's.
13. **Shared files were edited in this track**, as its instructions allowed, although the staff
    engineer note leaves them to integration: the handler manifest, `App.tsx`,
    `COMMUNICATIONS_TABS`, and one link in each of the season and offering screens (section 3).
14. **The link is two lines in each screen** (an import and the element), not one, so that it is
    absent while the capability is off.

## 3. To register or check at integration

- **Staff routes** (in `screens/communications/sequences/routes.tsx`, registered in `App.tsx`
  with one import and `{messageSequenceRoutes()}` after `{packageGRoutes()}`):
  `/communications/templates`, `/communications/templates/:templateId`,
  `/communications/sequences`, `/communications/sequences/:sequenceId`,
  `/communications/schedules/:subjectType/:subjectId` (`season` or `offering`).
- **Tabs** added to `COMMUNICATIONS_TABS` (`features/operations/AreaTabs.tsx`, two lines):
  "Message templates" and "Message sequences". They show whether the capability is on or off (the
  tab strip knows no capability); with it off the screens show the turned-off notice.
- **Links**: `screens/leagues/SeasonScreen.tsx` (after `<SeasonLinks>`) and
  `screens/programs/OfferingSetupScreen.tsx` (in the offering's link row): an import and
  `<MessageScheduleLink subject=... id=... />` each.
- **Not touched**: `navigation/areas.ts`, `navigation/destinations.ts`, the demo tour, anything
  under `ui`, `layout`, `theme`. A quick-navigation destination for the two tabs is the owner's
  call. Mobile: nothing added; customers receive these messages in the inbox they have.
- **Event handlers added to the manifest**: `communications.schedule_season_messages`
  (`competition.season_created`), `communications.follow_season_messages`
  (`competition.season_updated`), `communications.follow_season_first_game`
  (`competition.fixture_changed`), `communications.schedule_offering_messages`
  (`catalog.offering_published`), `communications.follow_offering_messages`
  (`catalog.offering_updated`), `communications.cancel_archived_offering_messages`
  (`catalog.offering_archived`). Three of these events already had handlers of other modules; the
  manifest lists both.
- **Generated files** were regenerated here and must be regenerated again after the merge.
- **Likely merge points**: `competition/ports.ts` and `services/team-entries.service.ts` with
  Track C (an added interface, one added method next to `seasonForOffering`);
  `enrollment/services/session-participants.ts` with Track D (one added method);
  `packages/contracts/src/state-machines.ts` (a machine appended before `ALL_STATE_MACHINES`).

## 4. What the demo dataset needs (Track G)

To show a schedule with one message sent, one waiting and one skipped, through the services (all
take a staff principal with a manager role; none writes another module's tables):

1. Turn `message_sequences` on.
2. `MessageTemplatesService.create` three templates, for example a welcome
   (`Welcome to {{season_name}}`, text with `{{start_date}}` and `{{facility_name}}`), a
   registration notice (`{{registration_opens_date}}`, `{{registration_closes_date}}`) and a
   first-game notice (`{{first_game_date}}`, `{{first_game_time}}`, `{{field}}`).
3. `MessageSequencesService.create` (subject `season`, the demo facility, `scopeId` the demo
   competition), `addStep` per template, then `update({ active: true })`. Create the sequence
   **before** the season so `competition.season_created` produces the schedule once the outbox is
   dispatched; for a season that already exists call `MessageScheduleService.generate`.
4. The season needs approved team entries with rosters, or nobody is addressed and a due message
   returns to needing confirmation (`no_audience`).
5. **Sent**: choose a step whose due time is already past on the demo clock (for example
   `registration_opens`, 1 day after, with registration opened last week),
   `MessageScheduleService.confirm` it, then run the job once
   (`ScheduledMessageSender.run({ now, batchSize })` or the periodic runner) and dispatch the
   outbox, so the notice exists with its recipients and in-app deliveries.
6. **Skipped**: `MessageScheduleService.skip` another with a reason.
7. **Waiting**: leave one as it is. A first-game step on a season whose fixtures are not scheduled
   shows the missing-detail state; scheduling the first fixture fills it.
8. An offering schedule works the same with subject `offering`; it is produced when the offering
   is published, and its audience is the participants of its live enrollments.

## 5. Technical debt created

- `scope_id` (a competition or a program) is stored unverified: there is no cross-module key.
- One notice addresses at most 100 team entries or 500 people. A larger audience is not split
  over several notices; such a message is not sent and says why (`audience_too_large`).
- A send failure raises an exception for support that a later success does not close.
- `sequences/message-schedule.service.ts` is long (about 1,350 lines: reads, staff commands,
  following the record, sending). It would read better split in four.
- The follow handlers run for every `competition.fixture_changed` and `catalog.offering_updated`
  of every organization; with no scheduled message they cost one indexed read.
- The preview reads each recipient's preferences one at a time.
- Placeholder values are written in English in the facility's zone; an offering's first session
  is not an anchor.
- Staff screens: the template list is one read without paging; the competition or program select
  of a sequence offers the first 100 programs; the two tabs are visible with the capability off.
- A switched-off sequence leaves the messages it already produced in place.
- The "set of messages per program" (K1) ships as nothing: no template or sequence is seeded.

## 6. Decisions the facility still owes (not invented here)

DEC-099, with the assumed defaults kept as policy content in
`sequences/message-sequences.policy.ts`: nothing is automatic (`automaticSending: false`), a step
without its own time is due at 09:00 facility time, a season's messages go to the teams whose
entry is approved. The manager roles are proposed in the generated permission matrix.

## 7. Not verified

- The whole API suite was not run (by instruction). Run: the communications module, the two port
  tests, the static and contract checks named in the track brief, the packages' suites, and the
  journeys `facility-league`, `facility-class`, `spk-at-002` and `tournaments` (they create
  seasons, publish offerings and change fixtures with the new handlers registered).
- PostgreSQL 16 (`TEST_DATABASE_URL`, a local throwaway cluster): the communications module with
  the two new spec files, and the two port tests. The new spec includes two workers on one due
  message and two concurrent requests producing one schedule. Nothing else was run on PostgreSQL.
  **Found there and not fixed (not this track's):** two tests of
  `communications/__tests__/notice-titles.spec.ts` (the activity reminder of a long-titled event,
  and the reminder failure exception) fail under PostgreSQL. They fail in the same way at the base
  commit `48b91452`, and pass on PGlite. Everything else in the module passed (32 of 33 files).
- No screen was looked at in a browser, in either theme; the staff screens are verified by
  component tests only. The styles use only tokens of `ui/styles.css`.
- The customer app was not run: that these notices appear in its inbox follows from their being
  ordinary `staff_broadcast` notices, and is not tested here.
- The three gap journeys (`facility-class`, `facility-register`, `facility-league`) record no
  message-sequence gap, so they were not changed.
