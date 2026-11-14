import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, UnitOfWork } from '../../../kernel';
import { createTestApp, drainOutboxChecked, type TestApp } from '../../../testing';
import { CatalogEvents, CatalogModule, createOfferingFixture } from '../../catalog';
import {
  CompetitionEvents,
  CompetitionModule,
  addRosterMemberFixture,
  createCompetitionFixture,
  createFixtureFixture,
  createRuleSetFixture,
  createTeamEntryFixture,
} from '../../competition';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../../identity';
import {
  EventsService,
  createScheduledEvent,
  seedOperatingHours,
  seedResource,
} from '../../scheduling';
import { CommunicationsModule } from '../communications.module';
import { SESSION_AUDIENCE_IMPL, type SessionAudiencePort } from '../ports';
import {
  DEFAULT_MESSAGE_SEQUENCE_POLICY,
  MESSAGE_SEQUENCE_POLICY,
} from '../sequences/message-sequences.policy';
import { SEND_SCHEDULED_MESSAGES_JOB } from '../sequences/message-schedule.service';
import { ScheduledMessageSender } from '../sequences/scheduled-message-sender';
import { attemptsOf, recipientsOf } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

type Header = { Authorization: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const key = () => `k-${newId()}`;
const CLOCK_START = '2026-11-01T12:00:00.000Z';

/**
 * SPK-COMMS-009 (proposed amendment PA-05; capability `message_sequences`, DEC-099 pending):
 * message templates and sequences, the message schedule of a season and of an offering, and the
 * periodic job that sends confirmed messages when they are due. Seasons are created and changed
 * through competition's API, so the schedule follows the events competition really emits.
 */
describe('message templates and sequences (SPK-COMMS-009, proposed amendment PA-05)', () => {
  let t: TestApp;
  let org: string;
  let manager: Header;
  let managerPersonId: string;
  let frontDesk: Header;
  /** The enrollment side of an offering's audience, as this test sets it (SESSION_AUDIENCE_IMPL). */
  const enrolled = new Map<string, string[]>();
  const offeringAudience: SessionAudiencePort = {
    participantsOfSchedulingEvent: async () => [],
    participantsOfOffering: async (_db, _organizationId, offeringId) => [
      ...(enrolled.get(offeringId) ?? []),
    ],
  };

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule, CompetitionModule, CatalogModule],
      providers: [{ provide: SESSION_AUDIENCE_IMPL, useValue: offeringAudience }],
      principalResolver: 'module',
      clockStart: CLOCK_START,
      capabilities: ['message_sequences'],
    });
    org = t.organizationId;
    const lead = await createStaffMemberFixture(t, {
      roles: ['league_manager', 'program_manager'],
    });
    managerPersonId = lead.personId;
    manager = await authHeaderForPerson(t, lead.personId);
    const desk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    frontDesk = await authHeaderForPerson(t, desk.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  // ---- HTTP helpers ----
  const post = (path: string, body: Json = {}, header: Header = manager) =>
    t.http.post(`/v1${path}`).set(header).set('Idempotency-Key', key()).send(body);
  const patch = (path: string, body: Json, header: Header = manager) =>
    t.http.patch(`/v1${path}`).set(header).set('Idempotency-Key', key()).send(body);
  const get = (path: string, header: Header = manager) => t.http.get(`/v1${path}`).set(header);

  async function ok(request: Promise<{ status: number; body: Json }>, status = 200): Promise<Json> {
    const res = await request;
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body;
  }

  // ---- fixtures through the API ----
  let names = 0;
  const unique = (label: string) => `${label} ${(names += 1)}`;

  const makeTemplate = (over: Json = {}) =>
    ok(
      post('/message-templates', {
        name: unique('Template'),
        category: 'operational',
        title: 'Welcome to {{season_name}}',
        body: '{{competition_name}} starts on {{start_date}} at {{facility_name}}.',
        ...over,
      }),
      201,
    );

  interface StepInput {
    templateId: string;
    anchor: string;
    offsetDays: number;
    sendTimeLocal?: string;
  }
  async function makeSequence(input: {
    subjectType: 'season' | 'offering';
    scopeId?: string;
    steps: StepInput[];
    active?: boolean;
  }): Promise<Json> {
    let sequence = await ok(
      post('/message-sequences', {
        name: unique('Sequence'),
        facilityId: t.facilityId,
        subjectType: input.subjectType,
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
      }),
      201,
    );
    expect(sequence.active).toBe(false);
    for (const step of input.steps) {
      sequence = await ok(post(`/message-sequences/${sequence.id}/steps`, step), 201);
    }
    if (input.active === false) return sequence;
    return ok(
      patch(`/message-sequences/${sequence.id}`, {
        active: true,
        expectedRevision: sequence.revision,
      }),
    );
  }

  async function league(): Promise<{ competitionId: string; ruleSetId: string }> {
    const competitionId = await createCompetitionFixture(t, { name: unique('Winter league') });
    const ruleSet = await createRuleSetFixture(t, {});
    return { competitionId, ruleSetId: ruleSet.id };
  }

  /** A season created through competition's API; its `competition.season_created` is dispatched. */
  async function createSeason(
    in_: { competitionId: string; ruleSetId: string },
    over: Json = {},
  ): Promise<Json> {
    const season = await ok(
      post('/seasons', {
        competitionId: in_.competitionId,
        ruleSetId: in_.ruleSetId,
        name: unique('Season'),
        startsOn: '2027-01-10',
        endsOn: '2027-04-10',
        registrationOpensAt: '2026-12-01T18:00:00.000Z',
        registrationClosesAt: '2027-01-05T08:00:00.000Z',
        ...over,
      }),
      201,
    );
    await drainOutboxChecked(t);
    return season;
  }

  async function updateSeason(seasonId: string, changes: Json): Promise<Json> {
    const current = await ok(get(`/seasons/${seasonId}`));
    const season = await ok(
      patch(`/seasons/${seasonId}`, { ...changes, expectedRevision: current.revision }),
    );
    await drainOutboxChecked(t);
    return season;
  }

  const scheduleOf = (type: 'season' | 'offering', id: string, header: Header = manager) =>
    ok(get(`/message-schedules/${type}/${id}`, header));
  const messageOf = (id: string) => ok(get(`/scheduled-messages/${id}`));
  const previewOf = (id: string) => ok(get(`/scheduled-messages/${id}/preview`));
  const confirm = (message: Json) =>
    ok(post(`/scheduled-messages/${message.id}/confirm`, { expectedRevision: message.revision }));

  async function adult(): Promise<string> {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId });
    return personId;
  }

  async function team(seasonId: string, players = 1) {
    const captain = await adult();
    const entry = await createTeamEntryFixture(t, { seasonId, captainPersonId: captain });
    const roster: string[] = [];
    for (let i = 0; i < players; i += 1) {
      const player = await adult();
      await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: player });
      roster.push(player);
    }
    return { captain, teamEntryId: entry.teamEntryId, roster };
  }

  /** Announces a fact through the outbox as its module emits it, and dispatches it. */
  async function announce(definition: { type: string }, aggregateId: string, payload: Json) {
    await t.app.get(UnitOfWork).run(async ({ trx }) => {
      await t.app.get(Outbox).enqueue(trx, definition as never, {
        organizationId: org,
        aggregateType: 'test',
        aggregateId,
        payload: payload as never,
      });
    });
    await drainOutboxChecked(t);
  }

  /**
   * One pass of the sending job at the clock, then the dispatch of what it queued. The job's own
   * `run` is called, as the kernel's runner calls it: each test tells its own timeline on the
   * shared clock, and the runner (rightly) starts no run earlier than its last one. The first
   * test drives the job through the runner itself (`runJob`).
   */
  async function runSender(): Promise<{ processed: number; remaining: number }> {
    const result = await t.app
      .get(ScheduledMessageSender)
      .run({ now: t.clock.now(), batchSize: 50 });
    await drainOutboxChecked(t);
    return result;
  }

  /** The registered periodic job, run by the kernel's runner at the clock (K-06). */
  async function runJob() {
    const [summary] = await t.runPeriodicJobs([SEND_SCHEDULED_MESSAGES_JOB]);
    expect(summary).toMatchObject({ ran: true, failed: false, error: null });
    await drainOutboxChecked(t);
    return summary;
  }

  const noticesAbout = (subjectId: string) =>
    t.db
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', org)
      .where('subject_id', '=', subjectId)
      .orderBy('created_at')
      .execute();

  const rowsOf = (subjectId: string) =>
    t.db
      .selectFrom('scheduled_messages')
      .selectAll()
      .where('organization_id', '=', org)
      .where('subject_id', '=', subjectId)
      .orderBy('due_at')
      .execute();

  const auditOf = (targetId: string, action: string) =>
    t.db
      .selectFrom('audit_records')
      .select(['action', 'details', 'reason'])
      .where('organization_id', '=', org)
      .where('target_id', '=', targetId)
      .where('action', '=', action)
      .orderBy('occurred_at')
      .execute();

  // =============================================================================================
  it('SPK-COMMS-009: a sequence produces the dated schedule of a new season with real details; staff preview, edit, skip and confirm; a confirmed message is sent when due and the schedule shows what was sent', async () => {
    t.clock.set(CLOCK_START);
    const welcome = await makeTemplate();
    const opening = await makeTemplate({
      title: 'Registration is open for {{season_name}}',
      body: 'Register from {{registration_opens_date}} to {{registration_closes_date}}.',
    });
    const thanks = await makeTemplate({
      title: 'Thank you for playing in {{season_name}}',
      body: 'The season ended on {{end_date}}.',
    });
    const in_ = await league();
    const sequence = await makeSequence({
      subjectType: 'season',
      scopeId: in_.competitionId,
      steps: [
        { templateId: welcome.id, anchor: 'starts', offsetDays: -7 },
        {
          templateId: opening.id,
          anchor: 'registration_opens',
          offsetDays: 1,
          sendTimeLocal: '08:00',
        },
        { templateId: thanks.id, anchor: 'ends', offsetDays: 1 },
      ],
    });
    expect(sequence.active).toBe(true);
    expect(
      sequence.steps.map((s: Json) => [s.position, s.anchor, s.effectiveSendTimeLocal]),
    ).toEqual([
      [1, 'starts', '09:00'], // the policy's time when the step names none
      [2, 'registration_opens', '08:00'],
      [3, 'ends', '09:00'],
    ]);

    const season = await createSeason(in_, { name: 'Winter 2027' });
    const squad = await team(season.id, 2);

    const schedule = await scheduleOf('season', season.id);
    expect(schedule.subjectName).toBe('Winter 2027');
    expect(schedule.timezone).toBe('America/Los_Angeles');
    expect(schedule.sequences).toEqual([{ id: sequence.id, name: sequence.name }]);
    expect(
      schedule.messages.map((m: Json) => [m.templateName, m.anchor, m.dueAt, m.status]),
    ).toEqual([
      // the day after registration opens (2026-12-01 10:00 Pacific), at 08:00 Pacific
      [opening.name, 'registration_opens', '2026-12-02T16:00:00.000Z', 'needs_confirmation'],
      // seven days before the season starts, at 09:00 Pacific
      [welcome.name, 'starts', '2027-01-03T17:00:00.000Z', 'needs_confirmation'],
      // the day after it ends, by then on daylight time
      [thanks.name, 'ends', '2027-04-11T16:00:00.000Z', 'needs_confirmation'],
    ]);
    const [openingMessage, welcomeMessage, thanksMessage] = schedule.messages as Json[];
    const competition = await t.db
      .selectFrom('competitions')
      .select('name')
      .where('id', '=', in_.competitionId)
      .executeTakeFirstOrThrow();
    expect(welcomeMessage).toMatchObject({
      title: 'Welcome to Winter 2027',
      body: `${competition.name} starts on Sunday, January 10, 2027 at Main complex.`,
      sourceTitle: 'Welcome to {{season_name}}',
      missingPlaceholders: [],
      edited: false,
      category: 'operational',
      delivery: null,
    });
    expect(openingMessage?.body).toBe(
      'Register from Tuesday, December 1, 2026 to Tuesday, January 5, 2027.',
    );

    // Nothing is sent without a confirmation, however long ago it was due.
    // (the day after the first one was due)
    t.clock.set('2026-12-03T16:00:00.000Z');
    expect((await runJob())?.processed).toBe(0);
    expect(await noticesAbout(season.id)).toEqual([]);

    // Preview: the text with real details, and who would receive it now (names and a count).
    const preview = await previewOf(welcomeMessage!.id);
    expect(preview).toMatchObject({
      title: 'Welcome to Winter 2027',
      missingPlaceholders: [],
      blockers: [],
      dueAt: '2027-01-03T17:00:00.000Z',
    });
    expect(preview.recipients.count).toBe(3);
    expect(preview.recipients.reachableCount).toBe(3);
    expect(preview.recipients.entries.map((e: Json) => e.personId).sort()).toEqual(
      [squad.captain, ...squad.roster].sort(),
    );
    expect(JSON.stringify(preview)).not.toMatch(/@|contactPoints|phone/);

    // Edit: an edited copy for this message only; the template is not changed.
    const edited = await ok(
      post(`/scheduled-messages/${welcomeMessage!.id}/edit`, {
        title: 'Welcome back to {{season_name}}',
        body: 'Games start on {{start_date}}. Bring shin guards.',
        expectedRevision: welcomeMessage!.revision,
      }),
    );
    expect(edited).toMatchObject({
      edited: true,
      status: 'needs_confirmation',
      title: 'Welcome back to Winter 2027',
      body: 'Games start on Sunday, January 10, 2027. Bring shin guards.',
      sourceTitle: 'Welcome back to {{season_name}}',
    });
    expect((await ok(get(`/message-templates/${welcome.id}`))).title).toBe(
      'Welcome to {{season_name}}',
    );

    // Skip: it is not sent; restoring brings it back to needing confirmation.
    const skipped = await ok(
      post(`/scheduled-messages/${thanksMessage!.id}/skip`, {
        reason: 'A printed letter goes out instead',
        expectedRevision: thanksMessage!.revision,
      }),
    );
    expect(skipped).toMatchObject({
      status: 'skipped',
      skipReason: 'A printed letter goes out instead',
    });
    const refused = await post(`/scheduled-messages/${skipped.id}/confirm`, {
      expectedRevision: skipped.revision,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');

    // Confirm: the exact text is stored and waits for its time.
    const confirmed = await confirm(edited);
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      attention: null,
      title: 'Welcome back to Winter 2027',
      dueAt: '2027-01-03T17:00:00.000Z',
    });
    expect(confirmed.confirmedAt).toBe('2026-12-03T16:00:00.000Z');
    const audit = await auditOf(confirmed.id, 'communications.confirm_scheduled_message');
    expect(audit.map((a) => (a.details as Json).operation).sort()).toEqual(['confirm', 'edit']);

    // The periodic job under the fixed clock: a minute early nothing, at the due time once.
    t.clock.set('2027-01-03T16:59:00.000Z');
    expect((await runJob())?.processed).toBe(0);
    expect((await messageOf(confirmed.id)).status).toBe('confirmed');
    t.clock.set('2027-01-03T17:00:00.000Z');
    expect((await runJob())?.processed).toBe(1);
    const sent = await messageOf(confirmed.id);
    expect(sent).toMatchObject({
      status: 'sent',
      sentAt: '2027-01-03T17:00:00.000Z',
      title: 'Welcome back to Winter 2027',
      body: 'Games start on Sunday, January 10, 2027. Bring shin guards.',
    });
    expect(sent.delivery).toMatchObject({
      notificationStatus: 'dispatched',
      suppressionReason: null,
      recipientCount: 3,
    });
    const [notice] = await noticesAbout(season.id);
    expect(notice).toMatchObject({
      id: sent.delivery.notificationId,
      kind: 'staff_broadcast',
      category: 'operational',
      subject_type: 'season',
      facility_id: t.facilityId,
      title: 'Welcome back to Winter 2027',
      protected: false,
    });
    expect(notice?.audience).toMatchObject({ teamEntryIds: [squad.teamEntryId] });
    // the existing delivery path did the rest: an in-app notice for every recipient
    const attempts = await attemptsOf(t.db, org, notice!.id);
    expect(attempts.filter((a) => a.channel === 'in_app' && a.status === 'delivered')).toHaveLength(
      3,
    );
    // a second pass, and a pass much later, send nothing more
    expect((await runJob())?.processed).toBe(0);
    t.clock.set('2027-06-01T12:00:00.000Z');
    expect((await runJob())?.processed).toBe(0);
    expect(await noticesAbout(season.id)).toHaveLength(1);
    // the schedule shows what was sent, what waits and what was skipped
    const after = await scheduleOf('season', season.id);
    expect(after.messages.map((m: Json) => m.status)).toEqual([
      'needs_confirmation',
      'sent',
      'skipped',
    ]);
    // a sent message is final for staff too
    const again = await post(`/scheduled-messages/${sent.id}/edit`, {
      title: 'Too late',
      body: 'Too late',
      expectedRevision: sent.revision,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    // restoring the skipped one asks for a confirmation again
    const restored = await ok(
      post(`/scheduled-messages/${skipped.id}/restore`, { expectedRevision: skipped.revision }),
    );
    expect(restored).toMatchObject({ status: 'needs_confirmation', skipReason: null });
    t.clock.set(CLOCK_START);
  });

  it('SPK-COMMS-009: the handlers are idempotent under replay, and a repeated request to produce the schedule creates nothing twice', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate();
    const in_ = await league();
    const sequence = await makeSequence({
      subjectType: 'season',
      scopeId: in_.competitionId,
      steps: [
        { templateId: template.id, anchor: 'starts', offsetDays: -7 },
        { templateId: template.id, anchor: 'starts', offsetDays: -1 },
      ],
    });
    const season = await createSeason(in_);
    const first = await rowsOf(season.id);
    expect(first).toHaveLength(2);

    const created = {
      seasonId: season.id,
      competitionId: in_.competitionId,
      ruleSetId: in_.ruleSetId,
    };
    await announce(CompetitionEvents.seasonCreated, season.id, created);
    await announce(CompetitionEvents.seasonCreated, season.id, created);
    await announce(CompetitionEvents.seasonUpdated, season.id, {
      seasonId: season.id,
      competitionId: in_.competitionId,
      status: 'draft',
      previousStatus: 'draft',
      revision: 1,
    });
    const produced = await ok(post(`/message-schedules/season/${season.id}/generate`));
    expect(produced.messages).toHaveLength(2);

    const second = await rowsOf(season.id);
    expect(second.map((r) => [r.id, r.revision, r.status])).toEqual(
      first.map((r) => [r.id, r.revision, r.status]),
    );
    // produced once: one audit record and one event, and no later change of any message
    expect(
      (await auditOf(season.id, 'communications.manage_message_sequences')).map(
        (a) => (a.details as Json).operation,
      ),
    ).toEqual(['generate_schedule']);
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('organization_id', '=', org)
      .where('event_type', 'like', 'communications.%message%')
      .where('aggregate_id', 'in', [season.id, ...first.map((r) => r.id)])
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['communications.message_schedule_generated']);
    expect((events[0]?.payload as Json).scheduledMessageIds.sort()).toEqual(
      first.map((r) => r.id).sort(),
    );

    // A step added later is produced on request, once, and existing messages are kept.
    await ok(
      post(`/message-sequences/${sequence.id}/steps`, {
        templateId: template.id,
        anchor: 'ends',
        offsetDays: 0,
      }),
      201,
    );
    expect(
      (await ok(post(`/message-schedules/season/${season.id}/generate`))).messages,
    ).toHaveLength(3);
    expect(
      (await ok(post(`/message-schedules/season/${season.id}/generate`))).messages,
    ).toHaveLength(3);
    expect((await rowsOf(season.id)).slice(0, 2).map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it('SPK-COMMS-009: only an active sequence that applies produces a schedule (its competition, or every season)', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate();
    const mine = await league();
    const other = await league();
    await makeSequence({
      subjectType: 'season',
      scopeId: other.competitionId,
      steps: [{ templateId: template.id, anchor: 'starts', offsetDays: -3 }],
    });
    const inactive = await makeSequence({
      subjectType: 'season',
      scopeId: mine.competitionId,
      steps: [{ templateId: template.id, anchor: 'starts', offsetDays: -2 }],
      active: false,
    });
    await makeSequence({
      subjectType: 'offering',
      steps: [{ templateId: template.id, anchor: 'starts', offsetDays: -2 }],
      active: false,
    });
    const season = await createSeason(mine);
    expect(await rowsOf(season.id)).toEqual([]);
    expect((await scheduleOf('season', season.id)).sequences).toEqual([]);
    // switched on later, the schedule is produced on request
    await ok(
      patch(`/message-sequences/${inactive.id}`, {
        active: true,
        expectedRevision: inactive.revision,
      }),
    );
    const produced = await ok(post(`/message-schedules/season/${season.id}/generate`));
    expect(produced.messages.map((m: Json) => m.sequenceId)).toEqual([inactive.id]);
    // a first game cannot anchor an offering's step
    const offeringSequence = await ok(
      post('/message-sequences', {
        name: unique('Sequence'),
        facilityId: t.facilityId,
        subjectType: 'offering',
      }),
      201,
    );
    const badAnchor = await post(`/message-sequences/${offeringSequence.id}/steps`, {
      templateId: template.id,
      anchor: 'first_game',
      offsetDays: -1,
    });
    expect(badAnchor.status).toBe(400);
    expect(badAnchor.body.details).toMatchObject({ code: 'ANCHOR_NOT_AVAILABLE' });
  });

  it('SPK-COMMS-009: when the anchor date moves before a message is sent, its due time follows and it returns to needing confirmation', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate();
    const closing = await makeTemplate({
      title: 'Thank you for playing in {{season_name}}',
      body: 'The season ended on {{end_date}}.',
    });
    const in_ = await league();
    await makeSequence({
      subjectType: 'season',
      scopeId: in_.competitionId,
      steps: [
        { templateId: template.id, anchor: 'starts', offsetDays: -7 },
        { templateId: template.id, anchor: 'starts', offsetDays: -1 },
        { templateId: closing.id, anchor: 'ends', offsetDays: 1 },
      ],
    });
    const season = await createSeason(in_);
    await team(season.id);
    const [weekBefore, dayBefore, afterEnd] = (await scheduleOf('season', season.id))
      .messages as Json[];
    const confirmedWeek = await confirm(weekBefore!);
    const confirmedEnd = await confirm(afterEnd!);
    expect(confirmedWeek.dueAt).toBe('2027-01-03T17:00:00.000Z');

    // The season starts a week later: both "starts" messages move; the confirmed one must be
    // confirmed again. The "ends" message did not move and stays confirmed.
    await updateSeason(season.id, { startsOn: '2027-01-17' });
    const moved = await messageOf(confirmedWeek.id);
    expect(moved).toMatchObject({
      status: 'needs_confirmation',
      attention: 'anchor_moved',
      dueAt: '2027-01-10T17:00:00.000Z',
      confirmedAt: null,
    });
    expect(moved.body).toContain('Sunday, January 17, 2027');
    expect(await messageOf(dayBefore!.id)).toMatchObject({
      status: 'needs_confirmation',
      attention: null,
      dueAt: '2027-01-16T17:00:00.000Z',
    });
    expect(await messageOf(confirmedEnd.id)).toMatchObject({
      status: 'confirmed',
      dueAt: confirmedEnd.dueAt,
      revision: confirmedEnd.revision,
    });
    const reopened = await auditOf(confirmedWeek.id, 'communications.follow_scheduled_message');
    expect(reopened.map((a) => a.details)).toEqual([
      expect.objectContaining({
        operation: 'reopen',
        attention: 'anchor_moved',
        previousDueAt: '2027-01-03T17:00:00.000Z',
        dueAt: '2027-01-10T17:00:00.000Z',
      }),
    ]);
    // Neither at the old due time nor at the new one is anything sent without a confirmation.
    t.clock.set('2027-01-11T00:00:00.000Z');
    expect((await runSender()).processed).toBe(0);
    expect(await noticesAbout(season.id)).toEqual([]);

    // The job checks the date itself before sending: a date that moved without its event having
    // been handled yet sends nothing either.
    t.clock.set(CLOCK_START);
    const reconfirmed = await confirm(moved);
    expect(reconfirmed.dueAt).toBe('2027-01-10T17:00:00.000Z');
    await t.db
      .updateTable('seasons')
      .set({ starts_on: '2027-01-24' })
      .where('id', '=', season.id)
      .execute();
    t.clock.set('2027-01-10T17:00:00.000Z');
    expect((await runSender()).processed).toBe(1);
    expect(await messageOf(reconfirmed.id)).toMatchObject({
      status: 'needs_confirmation',
      attention: 'anchor_moved',
      dueAt: '2027-01-17T17:00:00.000Z',
    });
    expect(await noticesAbout(season.id)).toEqual([]);
    // leave nothing confirmed behind for the tests that follow
    const left = await messageOf(confirmedEnd.id);
    await ok(post(`/scheduled-messages/${left.id}/skip`, { expectedRevision: left.revision }));
    t.clock.set(CLOCK_START);
  });

  it('SPK-COMMS-009, SPK-COMMS-003, SPK-COMMS-007: recipients are resolved when the message is sent: someone who opted out after the confirmation receives nothing, someone who joined receives it', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate({
      category: 'promotional',
      title: 'Sign up again for {{competition_name}}',
      body: '{{season_name}} starts on {{start_date}}.',
    });
    const in_ = await league();
    await makeSequence({
      subjectType: 'season',
      scopeId: in_.competitionId,
      steps: [{ templateId: template.id, anchor: 'starts', offsetDays: -7 }],
    });
    const season = await createSeason(in_);
    const squad = await team(season.id, 2);
    const [stays, optsOut] = squad.roster as [string, string];
    const [message] = (await scheduleOf('season', season.id)).messages as Json[];

    const before = await previewOf(message!.id);
    expect(before.category).toBe('promotional');
    expect(before.recipients.entries.map((e: Json) => e.personId).sort()).toEqual(
      [squad.captain, stays, optsOut].sort(),
    );
    const confirmed = await confirm(message!);

    // After the confirmation: one player switches promotional messages off on every channel,
    // and a new player joins the team.
    const optOut = await t.http
      .patch('/v1/me/communication-preferences')
      .set(await authHeaderForPerson(t, optsOut))
      .set('Idempotency-Key', key())
      .send({
        preferences: [
          { channel: 'in_app', category: 'promotional', enabled: false },
          { channel: 'email', category: 'promotional', enabled: false },
        ],
      });
    expect(optOut.status, JSON.stringify(optOut.body)).toBe(200);
    const joined = await adult();
    await addRosterMemberFixture(t, { teamEntryId: squad.teamEntryId, personId: joined });
    // the preview already shows both
    const now = await previewOf(confirmed.id);
    expect(now.recipients.count).toBe(4);
    expect(now.recipients.reachableCount).toBe(3);
    expect(now.recipients.entries.find((e: Json) => e.personId === optsOut).reachable).toBe(false);

    t.clock.set('2027-01-03T17:00:00.000Z');
    expect((await runSender()).processed).toBe(1);
    const sent = await messageOf(confirmed.id);
    expect(sent.status).toBe('sent');
    const noticeId = sent.delivery.notificationId as string;
    const recipients = await recipientsOf(t.db, org, noticeId);
    const attempts = await attemptsOf(t.db, org, noticeId);
    const channelsOf = (personId: string) => {
      const recipient = recipients.find((r) => r.person_id === personId);
      return attempts
        .filter((a) => a.recipient_id === recipient?.id)
        .map((a) => a.channel)
        .sort();
    };
    // the one who opted out receives nothing, on any channel
    expect(channelsOf(optsOut)).toEqual([]);
    // the one who joined after the confirmation receives it; so do the others
    expect(channelsOf(joined)).toEqual(['email', 'in_app']);
    expect(channelsOf(stays)).toEqual(['email', 'in_app']);
    expect(channelsOf(squad.captain)).toEqual(['email', 'in_app']);
    const notice = await t.db
      .selectFrom('notifications')
      .select(['category', 'kind'])
      .where('id', '=', noticeId)
      .executeTakeFirstOrThrow();
    expect(notice).toEqual({ category: 'promotional', kind: 'staff_broadcast' });
    t.clock.set(CLOCK_START);
  });

  it('SPK-COMMS-009: a placeholder that cannot be filled is named by the preview, blocks confirmation, and is never sent as raw text', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate({
      title: 'First game of {{season_name}}',
      body: 'We play on {{first_game_date}} at {{first_game_time}} on {{field}}.',
    });
    const in_ = await league();
    await makeSequence({
      subjectType: 'season',
      scopeId: in_.competitionId,
      steps: [
        { templateId: template.id, anchor: 'starts', offsetDays: -7 },
        { templateId: template.id, anchor: 'first_game', offsetDays: -1 },
      ],
    });
    const season = await createSeason(in_);
    const home = await team(season.id);
    const away = await team(season.id);
    const [byStart, byFirstGame] = (await scheduleOf('season', season.id)).messages as Json[];
    // no game is scheduled yet: nothing to fill the placeholders with, and no date to count from
    expect(byStart).toMatchObject({
      anchor: 'starts',
      missingPlaceholders: ['first_game_date', 'first_game_time', 'field'],
      body: 'We play on {{first_game_date}} at {{first_game_time}} on {{field}}.',
    });
    expect(byFirstGame).toMatchObject({ anchor: 'first_game', dueAt: null, anchorAt: null });
    const preview = await previewOf(byStart!.id);
    expect(preview.missingPlaceholders).toEqual([
      { name: 'first_game_date', label: 'First game date' },
      { name: 'first_game_time', label: 'First game time' },
      { name: 'field', label: 'Field' },
    ]);
    expect(preview.blockers).toEqual(['missing_placeholder']);
    expect((await previewOf(byFirstGame!.id)).blockers).toEqual([
      'missing_placeholder',
      'no_due_time',
    ]);

    const refused = await post(`/scheduled-messages/${byStart!.id}/confirm`, {
      expectedRevision: byStart!.revision,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    expect(refused.body.details).toMatchObject({
      code: 'UNFILLED_PLACEHOLDER',
      missing: ['first_game_date', 'first_game_time', 'field'],
    });
    const undated = await post(`/scheduled-messages/${byFirstGame!.id}/confirm`, {
      expectedRevision: byFirstGame!.revision,
    });
    expect(undated.status).toBe(400);
    expect(undated.body.details).toMatchObject({ code: 'NO_DUE_TIME', anchor: 'first_game' });
    expect((await rowsOf(season.id)).map((r) => r.status)).toEqual([
      'needs_confirmation',
      'needs_confirmation',
    ]);

    // An unknown or mistyped placeholder never gets into a template or an edited copy.
    for (const body of ['See you at {{feild}}.', 'See you at {{ field }.', 'A stray }} mark']) {
      const bad = await post('/message-templates', {
        name: unique('Template'),
        category: 'operational',
        title: 'Title',
        body,
      });
      expect(bad.status, body).toBe(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
      const badEdit = await post(`/scheduled-messages/${byStart!.id}/edit`, {
        title: 'Title',
        body,
        expectedRevision: byStart!.revision,
      });
      expect(badEdit.status, body).toBe(400);
    }

    // Way out 1: edit the text of this message so it needs nothing the season cannot give.
    const edited = await ok(
      post(`/scheduled-messages/${byStart!.id}/edit`, {
        title: 'First game of {{season_name}}',
        body: 'The schedule follows soon.',
        expectedRevision: byStart!.revision,
      }),
    );
    expect(edited.missingPlaceholders).toEqual([]);
    const confirmed = await confirm(edited);
    expect(confirmed.status).toBe('confirmed');
    expect(`${confirmed.title}${confirmed.body}`).not.toMatch(/\{\{|\}\}/);

    // Way out 2: the record gets the detail. The first game is scheduled on a named field.
    const field = await seedResource(t.db, {
      organizationId: org,
      facilityId: t.facilityId,
      name: 'Field 2',
    });
    await seedOperatingHours(t.db, { organizationId: org, facilityId: t.facilityId });
    const start = '2027-01-13T02:30:00.000Z'; // Tuesday 12 January, 6:30 PM Pacific
    const end = '2027-01-13T03:30:00.000Z';
    const event = await createScheduledEvent(t.app.get(EventsService), {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [field.resourceId],
      start,
      end,
    });
    const fixtureId = await createFixtureFixture(t, {
      seasonId: season.id,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      status: 'scheduled',
      schedulingEventId: event.id,
      scheduledStart: start,
      scheduledEnd: end,
    });
    const fixtureChanged = (status: string, previousStatus: string, change: string) =>
      announce(CompetitionEvents.fixtureChanged, fixtureId, {
        fixtureId,
        seasonId: season.id,
        homeEntryId: home.teamEntryId,
        awayEntryId: away.teamEntryId,
        status,
        previousStatus,
        schedulingEventId: event.id,
        scheduledStart: start,
        scheduledEnd: end,
        change,
        reason: null,
      });
    await fixtureChanged('scheduled', 'unscheduled', 'scheduled');
    const dated = await messageOf(byFirstGame!.id);
    expect(dated).toMatchObject({
      status: 'needs_confirmation',
      anchorAt: start,
      dueAt: '2027-01-11T17:00:00.000Z', // the day before, at 09:00 Pacific
      missingPlaceholders: [],
      body: 'We play on Tuesday, January 12, 2027 at 6:30 PM on Field 2.',
    });
    const confirmedGame = await confirm(dated);
    expect(confirmedGame.status).toBe('confirmed');

    // The game is called off after the confirmation: the confirmed text no longer stands, so
    // the message is not sent and asks for attention instead.
    await t.db
      .updateTable('fixtures')
      .set({ status: 'canceled' })
      .where('id', '=', fixtureId)
      .execute();
    await fixtureChanged('canceled', 'scheduled', 'canceled');
    const withdrawn = await messageOf(confirmedGame.id);
    expect(withdrawn).toMatchObject({
      status: 'needs_confirmation',
      attention: 'anchor_moved',
      dueAt: null,
      missingPlaceholders: ['first_game_date', 'first_game_time', 'field'],
    });
    t.clock.set('2027-01-11T17:00:00.000Z');
    await runSender();
    const sentTexts = (await noticesAbout(season.id)).map((n) => `${n.title} ${n.body}`);
    // only the edited message went out, and no raw placeholder ever did
    expect(sentTexts).toEqual([`${confirmed.title} ${confirmed.body}`]);
    t.clock.set(CLOCK_START);
  });

  it('SPK-COMMS-009: a changed template or step asks for a new confirmation of what was confirmed from it; a removed step cancels its unsent messages; what was sent is kept', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate({
      title: 'Kick-off for {{season_name}}',
      body: 'See you on {{start_date}}.',
    });
    const in_ = await league();
    const sequence = await makeSequence({
      subjectType: 'season',
      scopeId: in_.competitionId,
      steps: [
        { templateId: template.id, anchor: 'starts', offsetDays: -7 },
        { templateId: template.id, anchor: 'starts', offsetDays: -2 },
        {
          templateId: template.id,
          anchor: 'registration_opens',
          offsetDays: 0,
          sendTimeLocal: '12:00',
        },
      ],
    });
    const season = await createSeason(in_);
    await team(season.id);
    const [early, weekBefore, twoDays] = (await scheduleOf('season', season.id)).messages as Json[];
    // the earliest one is sent first
    const earlyConfirmed = await confirm(early!);
    t.clock.set(earlyConfirmed.dueAt);
    expect((await runSender()).processed).toBe(1);
    const sentText = (await messageOf(early!.id)).body as string;
    t.clock.set(CLOCK_START);

    const confirmedWeek = await confirm(weekBefore!);
    // an edited copy does not depend on the template's text
    const ownText = await ok(
      post(`/scheduled-messages/${twoDays!.id}/edit`, {
        title: 'Two days to go',
        body: 'Fields open at eight.',
        expectedRevision: twoDays!.revision,
      }),
    );
    const confirmedOwn = await confirm(ownText);

    const changed = await ok(
      patch(`/message-templates/${template.id}`, {
        body: 'See you on {{start_date}} at {{facility_name}}.',
        expectedRevision: template.revision,
      }),
    );
    expect(changed.revision).toBe(template.revision + 1);
    expect(await messageOf(confirmedWeek.id)).toMatchObject({
      status: 'needs_confirmation',
      attention: 'text_changed',
      body: 'See you on Sunday, January 10, 2027 at Main complex.',
    });
    expect((await messageOf(confirmedOwn.id)).status).toBe('confirmed');
    // the sent message keeps the text that was sent
    expect(await messageOf(early!.id)).toMatchObject({ status: 'sent', body: sentText });

    // A step moved to three days before: its unsent message follows.
    const stepOfOwn = sequence.steps.find((s: Json) => s.id === confirmedOwn.stepId) as Json;
    await ok(
      patch(`/message-sequences/${sequence.id}/steps/${stepOfOwn.id}`, {
        offsetDays: -3,
        expectedRevision: stepOfOwn.revision,
      }),
    );
    expect(await messageOf(confirmedOwn.id)).toMatchObject({
      status: 'needs_confirmation',
      attention: 'anchor_moved',
      dueAt: '2027-01-07T17:00:00.000Z',
      edited: true,
    });

    // A removed step cancels what was not sent and produces nothing for later seasons.
    const stepOfWeek = sequence.steps.find((s: Json) => s.id === confirmedWeek.stepId) as Json;
    const after = await ok(
      post(`/message-sequences/${sequence.id}/steps/${stepOfWeek.id}/remove`, {
        expectedRevision: stepOfWeek.revision,
      }),
    );
    expect(after.steps.find((s: Json) => s.id === stepOfWeek.id).retiredAt).toBe(CLOCK_START);
    expect(await messageOf(confirmedWeek.id)).toMatchObject({
      status: 'canceled',
      cancelReason: 'step_removed',
    });
    const stepOfEarly = sequence.steps.find((s: Json) => s.id === early!.stepId) as Json;
    await ok(
      post(`/message-sequences/${sequence.id}/steps/${stepOfEarly.id}/remove`, {
        expectedRevision: stepOfEarly.revision,
      }),
    );
    expect((await messageOf(early!.id)).status).toBe('sent');
    const next = await createSeason(in_);
    expect((await rowsOf(next.id)).map((r) => r.sequence_step_id)).toEqual([stepOfOwn.id]);
    // an archived template cannot start a new step
    await ok(
      patch(`/message-templates/${template.id}`, {
        status: 'archived',
        expectedRevision: changed.revision,
      }),
    );
    const archived = await post(`/message-sequences/${sequence.id}/steps`, {
      templateId: template.id,
      anchor: 'starts',
      offsetDays: -1,
    });
    expect(archived.status).toBe(400);
    expect(archived.body.details).toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
  });

  it('SPK-COMMS-009: a published offering gets its schedule; its message goes to the participants enrolled when it is sent, as a protected notice, and an archived offering cancels what was not sent', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate({
      title: '{{offering_name}} starts soon',
      body: 'First day: {{start_date}} at {{field}}, {{facility_name}}.',
    });
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      name: 'Spring break camp',
      kind: 'camp',
      publicationState: 'published',
      startsOn: '2027-03-22',
      endsOn: '2027-03-26',
      registrationOpensAt: new Date('2027-01-15T17:00:00Z'),
      registrationClosesAt: new Date('2027-03-15T17:00:00Z'),
    });
    await t.db
      .updateTable('offerings')
      .set({ location: json({ label: 'Indoor field A' }) })
      .where('id', '=', offering.offeringId)
      .execute();
    const sequence = await makeSequence({
      subjectType: 'offering',
      scopeId: offering.programId,
      steps: [
        { templateId: template.id, anchor: 'starts', offsetDays: -3, sendTimeLocal: '10:30' },
        { templateId: template.id, anchor: 'registration_closes', offsetDays: -1 },
      ],
    });
    const published = {
      offeringId: offering.offeringId,
      programId: offering.programId,
      facilityId: offering.facilityId,
      kind: 'camp',
      revision: 1,
      registrationOpensAt: '2027-01-15T17:00:00.000Z',
      registrationClosesAt: '2027-03-15T17:00:00.000Z',
    };
    await announce(CatalogEvents.offeringPublished, offering.offeringId, published);
    await announce(CatalogEvents.offeringPublished, offering.offeringId, published); // a replay

    const schedule = await scheduleOf('offering', offering.offeringId);
    expect(schedule).toMatchObject({
      subjectName: 'Spring break camp',
      facilityId: t.facilityId,
      sequences: [{ id: sequence.id }],
    });
    expect(schedule.messages.map((m: Json) => [m.anchor, m.dueAt, m.title, m.body])).toEqual([
      [
        'registration_closes',
        '2027-03-14T16:00:00.000Z', // the day before it closes, 09:00 Pacific daylight time
        'Spring break camp starts soon',
        'First day: Monday, March 22, 2027 at Indoor field A, Main complex.',
      ],
      [
        'starts',
        '2027-03-19T17:30:00.000Z', // three days before, 10:30 Pacific daylight time
        'Spring break camp starts soon',
        'First day: Monday, March 22, 2027 at Indoor field A, Main complex.',
      ],
    ]);
    const [beforeClose, beforeStart] = schedule.messages as Json[];

    // A child is enrolled; their guardian receives messages for them.
    const guardian = await adult();
    const child = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: guardian,
      subjectPersonId: child,
      permissions: ['view', 'receive_messages'],
    });
    enrolled.set(offering.offeringId, [child]);
    const preview = await previewOf(beforeStart!.id);
    expect(preview.recipients.entries).toEqual([
      expect.objectContaining({ personId: guardian, basis: 'receive_messages', reachable: true }),
    ]);
    const confirmedStart = await confirm(beforeStart!);
    const confirmedClose = await confirm(beforeClose!);

    // Nobody is enrolled when the first one is due: it is not sent, and says why.
    enrolled.set(offering.offeringId, []);
    t.clock.set('2027-03-14T16:00:00.000Z');
    expect((await runSender()).processed).toBe(1);
    expect(await messageOf(confirmedClose.id)).toMatchObject({
      status: 'needs_confirmation',
      attention: 'no_audience',
    });
    expect(await noticesAbout(offering.offeringId)).toEqual([]);

    // A second family enrolls after the confirmation: both receive the message.
    const lateAdult = await adult();
    enrolled.set(offering.offeringId, [child, lateAdult]);
    t.clock.set('2027-03-19T17:30:00.000Z');
    expect((await runSender()).processed).toBe(1);
    const sent = await messageOf(confirmedStart.id);
    expect(sent.status).toBe('sent');
    const [notice] = await noticesAbout(offering.offeringId);
    expect(notice).toMatchObject({
      protected: true,
      subject_type: 'offering',
      title: 'Spring break camp starts soon',
    });
    expect((notice?.audience as Json).subjectPersonIds.sort()).toEqual([child, lateAdult].sort());
    const recipients = await recipientsOf(t.db, org, notice!.id);
    expect(recipients.map((r) => r.person_id).sort()).toEqual([guardian, lateAdult].sort());

    // Archived: the message that was waiting is canceled; the sent one stays.
    await t.db
      .updateTable('offerings')
      .set({ publication_state: 'archived', archived_at: t.clock.now() })
      .where('id', '=', offering.offeringId)
      .execute();
    await announce(CatalogEvents.offeringArchived, offering.offeringId, {
      offeringId: offering.offeringId,
      programId: offering.programId,
      facilityId: offering.facilityId,
      kind: 'camp',
      revision: 2,
    });
    expect(await messageOf(confirmedClose.id)).toMatchObject({
      status: 'canceled',
      cancelReason: 'record_archived',
    });
    expect((await messageOf(confirmedStart.id)).status).toBe('sent');
    const refused = await post(`/message-schedules/offering/${offering.offeringId}/generate`);
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ code: 'RECORD_ARCHIVED' });
    t.clock.set(CLOCK_START);
  });

  it('SPK-COMMS-009 with the capability off: the handlers create nothing, the job sends nothing, the commands are refused with the capability error, and reads, skipping and ordinary notices are untouched', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate();
    const in_ = await league();
    const sequence = await makeSequence({
      subjectType: 'season',
      scopeId: in_.competitionId,
      steps: [
        { templateId: template.id, anchor: 'starts', offsetDays: -7 },
        { templateId: template.id, anchor: 'starts', offsetDays: -1 },
        { templateId: template.id, anchor: 'ends', offsetDays: 1 },
      ],
    });
    const before = await createSeason(in_);
    await team(before.id);
    const [first, second, third] = (await scheduleOf('season', before.id)).messages as Json[];
    const confirmed = await confirm(first!);
    const skipped = await ok(
      post(`/scheduled-messages/${third!.id}/skip`, { expectedRevision: third!.revision }),
    );

    await t.disableCapability('message_sequences');
    try {
      // the handler creates nothing for a season created while the switch is off
      const during = await createSeason(in_);
      expect(await rowsOf(during.id)).toEqual([]);

      // every command that creates something is refused with the capability error
      const step = sequence.steps[0] as Json;
      const refusals = [
        () =>
          post('/message-templates', {
            name: unique('Template'),
            category: 'operational',
            title: 'T',
            body: 'B',
          }),
        () =>
          patch(`/message-templates/${template.id}`, {
            title: 'Changed',
            expectedRevision: template.revision,
          }),
        () =>
          post('/message-sequences', {
            name: unique('Sequence'),
            facilityId: t.facilityId,
            subjectType: 'season',
          }),
        () =>
          patch(`/message-sequences/${sequence.id}`, {
            active: false,
            expectedRevision: sequence.revision,
          }),
        () =>
          post(`/message-sequences/${sequence.id}/steps`, {
            templateId: template.id,
            anchor: 'starts',
            offsetDays: 0,
          }),
        () =>
          patch(`/message-sequences/${sequence.id}/steps/${step.id}`, {
            offsetDays: -8,
            expectedRevision: step.revision,
          }),
        () => post(`/message-schedules/season/${during.id}/generate`),
        () =>
          post(`/scheduled-messages/${second!.id}/confirm`, { expectedRevision: second!.revision }),
        () =>
          post(`/scheduled-messages/${second!.id}/edit`, {
            title: 'T',
            body: 'B',
            expectedRevision: second!.revision,
          }),
        () =>
          post(`/scheduled-messages/${skipped.id}/restore`, { expectedRevision: skipped.revision }),
      ];
      for (const refusal of refusals) {
        const res = await refusal();
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(res.body.details).toMatchObject({
          code: 'CAPABILITY_DISABLED',
          capability: 'message_sequences',
        });
      }
      expect(await rowsOf(during.id)).toEqual([]);

      // the job sends nothing, even for a message confirmed before the switch went off
      t.clock.set('2027-01-03T17:00:00.000Z');
      expect((await runSender()).processed).toBe(0);
      expect(await messageOf(confirmed.id)).toMatchObject({
        status: 'confirmed',
        revision: confirmed.revision,
      });
      expect(await noticesAbout(before.id)).toEqual([]);

      // reads stay, and so do skipping a message and removing a step (they create nothing)
      expect((await scheduleOf('season', before.id)).messages).toHaveLength(3);
      expect((await ok(get('/message-templates'))).items.length).toBeGreaterThan(0);
      expect((await ok(get(`/message-sequences/${sequence.id}`))).id).toBe(sequence.id);
      expect((await ok(get('/message-placeholders'))).items.map((p: Json) => p.name)).toContain(
        'season_name',
      );
      expect((await previewOf(second!.id)).blockers).toEqual([]);
      expect(
        (
          await ok(
            post(`/scheduled-messages/${second!.id}/skip`, { expectedRevision: second!.revision }),
          )
        ).status,
      ).toBe('skipped');
      const lastStep = sequence.steps[2] as Json;
      await ok(
        post(`/message-sequences/${sequence.id}/steps/${lastStep.id}/remove`, {
          expectedRevision: lastStep.revision,
        }),
      );
      expect((await messageOf(skipped.id)).status).toBe('canceled');

      // a message that exists still follows its season: nothing is sent, the date stays true
      await updateSeason(before.id, { startsOn: '2027-02-07' });
      expect(await messageOf(confirmed.id)).toMatchObject({
        status: 'needs_confirmation',
        attention: 'anchor_moved',
        dueAt: '2027-01-31T17:00:00.000Z',
      });

      // existing notification behaviour is untouched: a staff member composes and sends a notice
      const recipient = await adult();
      const composed = await ok(
        post('/notifications', {
          kind: 'staff_broadcast',
          category: 'operational',
          audience: { personIds: [recipient] },
          title: 'Field closed today',
          body: 'Field 2 is closed for repairs.',
        }),
        201,
      );
      const queued = await ok(
        post(`/notifications/${composed.id}/send`, { expectedRevision: composed.revision }),
      );
      expect(queued.status).toBe('queued');
      await drainOutboxChecked(t);
      expect((await attemptsOf(t.db, org, composed.id)).map((a) => a.channel).sort()).toEqual([
        'email',
        'in_app',
        'push',
      ]);
    } finally {
      await t.enableCapability('message_sequences');
    }

    // Switched on again: the message is confirmed again and sent when due.
    t.clock.set(CLOCK_START);
    const again = await confirm(await messageOf(confirmed.id));
    t.clock.set(again.dueAt);
    expect((await runSender()).processed).toBe(1);
    expect((await messageOf(confirmed.id)).status).toBe('sent');
    t.clock.set(CLOCK_START);
  });

  it('SPK-COMMS-009, §4.14: managers manage; other staff read; a manager of another facility does not manage this one; unknown records are not found', async () => {
    t.clock.set(CLOCK_START);
    const template = await makeTemplate();
    const in_ = await league();
    const sequence = await makeSequence({
      subjectType: 'season',
      scopeId: in_.competitionId,
      steps: [{ templateId: template.id, anchor: 'starts', offsetDays: -7 }],
    });
    const season = await createSeason(in_);
    const [message] = (await scheduleOf('season', season.id)).messages as Json[];

    // the front desk reads the schedule and the templates, and changes nothing
    expect((await scheduleOf('season', season.id, frontDesk)).messages).toHaveLength(1);
    expect((await get('/message-templates', frontDesk)).status).toBe(200);
    for (const denied of [
      () =>
        post(
          '/message-templates',
          { name: 'N', category: 'operational', title: 'T', body: 'B' },
          frontDesk,
        ),
      () =>
        post(
          `/message-sequences/${sequence.id}/steps`,
          { templateId: template.id, anchor: 'ends', offsetDays: 0 },
          frontDesk,
        ),
      () =>
        post(
          `/scheduled-messages/${message!.id}/confirm`,
          { expectedRevision: message!.revision },
          frontDesk,
        ),
      () =>
        post(
          `/scheduled-messages/${message!.id}/skip`,
          { expectedRevision: message!.revision },
          frontDesk,
        ),
      () => post(`/message-schedules/season/${season.id}/generate`, {}, frontDesk),
      () => get(`/scheduled-messages/${message!.id}/preview`, frontDesk),
    ]) {
      const res = await denied();
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details?.code).not.toBe('CAPABILITY_DISABLED');
    }
    // a customer reads nothing
    const customer = await authHeaderForPerson(t, await adult());
    expect((await get(`/message-schedules/season/${season.id}`, customer)).status).toBe(403);

    // a league manager scoped to another facility sees no message of this one and manages none
    const elsewhere = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: elsewhere,
        organization_id: org,
        slug: `annex-${elsewhere}`,
        name: 'Annex',
        timezone: 'America/Denver',
        address: null,
      })
      .execute();
    const scoped = await createStaffMemberFixture(t, {
      roles: ['league_manager'],
      facilityIds: [elsewhere],
    });
    const scopedHeader = await authHeaderForPerson(t, scoped.personId);
    expect((await scheduleOf('season', season.id, scopedHeader)).messages).toEqual([]);
    expect((await ok(get('/message-sequences', scopedHeader))).items).toEqual([]);
    expect(
      (
        await post(
          `/scheduled-messages/${message!.id}/confirm`,
          { expectedRevision: message!.revision },
          scopedHeader,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          '/message-sequences',
          { name: unique('Sequence'), facilityId: t.facilityId, subjectType: 'season' },
          scopedHeader,
        )
      ).status,
    ).toBe(403);
    // their own facility's sequence reads its times in that facility's zone
    const theirs = await ok(
      post(
        '/message-sequences',
        {
          name: unique('Sequence'),
          facilityId: elsewhere,
          subjectType: 'season',
          scopeId: in_.competitionId,
        },
        scopedHeader,
      ),
      201,
    );
    await ok(
      post(
        `/message-sequences/${theirs.id}/steps`,
        { templateId: template.id, anchor: 'starts', offsetDays: -7 },
        scopedHeader,
      ),
      201,
    );
    await ok(
      patch(`/message-sequences/${theirs.id}`, { active: true, expectedRevision: 1 }, scopedHeader),
    );
    const produced = await ok(
      post(`/message-schedules/season/${season.id}/generate`, {}, scopedHeader),
    );
    expect(produced.messages.map((m: Json) => [m.facilityId, m.dueAt])).toEqual([
      [elsewhere, '2027-01-03T16:00:00.000Z'], // 09:00 Mountain time
    ]);
    expect((await scheduleOf('season', season.id)).messages).toHaveLength(2);

    // unknown records, a stale revision and duplicate names
    expect((await get(`/message-schedules/season/${newId()}`)).status).toBe(404);
    expect((await get(`/scheduled-messages/${newId()}`)).status).toBe(404);
    expect((await get(`/message-templates/${newId()}`)).status).toBe(404);
    const stale = await post(`/scheduled-messages/${message!.id}/confirm`, {
      expectedRevision: message!.revision + 5,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const duplicate = await post('/message-templates', {
      name: template.name.toUpperCase(),
      category: 'operational',
      title: 'T',
      body: 'B',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.details).toMatchObject({ code: 'TEMPLATE_NAME_TAKEN' });
    const missingKey = await t.http
      .post(`/v1/scheduled-messages/${message!.id}/confirm`)
      .set(manager)
      .send({ expectedRevision: message!.revision });
    expect(missingKey.status).toBe(400);
  });

  it('SPK-COMMS-009: the assumed defaults are policy content, and nothing is automatic (DEC-099 pending)', () => {
    const policy = t.app.get(MESSAGE_SEQUENCE_POLICY);
    expect(policy).toEqual(DEFAULT_MESSAGE_SEQUENCE_POLICY);
    expect(policy).toMatchObject({
      defaultSendTimeLocal: '09:00',
      automaticSending: false,
      seasonAudienceEntryStatuses: ['approved'],
      noticeKind: 'staff_broadcast',
    });
  });
});
