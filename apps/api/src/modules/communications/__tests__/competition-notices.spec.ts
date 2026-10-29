import { newId, systemPrincipal, type DomainEvent, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, UnitOfWork } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  CompetitionEvents,
  CompetitionModule,
  MatchEvents,
  addRosterMemberFixture,
  assignTeamRoleFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import {
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { CompetitionNotices } from '../services/competition-notices';
import { NotificationsService } from '../services/notifications.service';
import { dispatchOutbox, recipientsOf } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

/**
 * COM-03 and COM-06 (handlers): team role holders in team audiences (SPK-COMMS-003) and the
 * notices this module composes about competition facts (SPK-COMMS-002 team_invitation,
 * result_published; SPK-CAP-001 availability requests). The competition facts are announced
 * through the outbox exactly as competition emits them.
 */
describe('competition notices and team role holders (COM-03, COM-06)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let notifications: NotificationsService;
  let people: OrganizationPeople;
  let seasonId: string;

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule, CompetitionModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    notifications = t.app.get(NotificationsService);
    people = await createOrganizationPeople(t, { staffRoles: ['league_manager'] });
    seasonId = (await createSeasonFixture(t, {})).seasonId;
  });
  afterAll(async () => {
    await t.close();
  });

  async function adult(): Promise<string> {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId });
    return personId;
  }

  async function team(name: string) {
    const captain = await adult();
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: captain,
      teamName: name,
    });
    return { captain, teamEntryId: entry.teamEntryId };
  }

  /** Announces a competition fact through the outbox and dispatches it; returns the event id. */
  async function announce<P extends Record<string, unknown>>(
    definition: { type: string },
    aggregateId: string,
    payload: P,
  ): Promise<string> {
    await t.app.get(UnitOfWork).run(async ({ trx }) => {
      await t.app.get(Outbox).enqueue(trx, definition as never, {
        organizationId: org,
        aggregateType: 'competition',
        aggregateId,
        payload: payload as never,
      });
    });
    const row = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', definition.type)
      .where('aggregate_id', '=', aggregateId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    const summary = await dispatchOutbox(t.app);
    expect(summary.dead).toBe(0);
    return row.id;
  }

  const noticesFrom = (sourceEventId: string) =>
    t.db
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', org)
      .where('source_event_id', '=', sourceEventId)
      .execute();

  it('SPK-COMMS-003: a co-captain without a roster row receives a team notice', async () => {
    const { captain, teamEntryId } = await team('Falcons');
    const player = await adult();
    const coCaptain = await adult();
    await addRosterMemberFixture(t, { teamEntryId, personId: player });
    await assignTeamRoleFixture(t, { teamEntryId, personId: coCaptain, role: 'co_captain' });

    const notice = await notifications.composeAndQueue(system, {
      kind: 'staff_broadcast',
      category: 'operational',
      audience: { teamEntryIds: [teamEntryId] },
      title: 'Falcons: kit collection',
      body: 'Collect your kit on Saturday.',
    });
    await dispatchOutbox(t.app);
    const recipients = await recipientsOf(t.db, org, notice.id);
    const byPerson = Object.fromEntries(recipients.map((r) => [r.person_id, r]));
    // neither the captain nor the co-captain has a roster row; both hold a team role at the clock
    expect(byPerson[coCaptain]).toMatchObject({
      resolved_basis: 'team_member',
      basis_detail: teamEntryId,
      status: 'authorized',
    });
    expect(byPerson[captain]).toMatchObject({
      resolved_basis: 'team_member',
      status: 'authorized',
    });
    expect(byPerson[player]).toMatchObject({ resolved_basis: 'team_member' });

    // invariant 10: a protected team notice queued while they were co-captain is re-checked at
    // dispatch against the role at the clock
    const protectedNotice = await notifications.composeAndQueue(system, {
      kind: 'result_published',
      audience: { teamEntryIds: [teamEntryId] },
      title: 'Falcons: match notes',
      body: 'Private notes for the team.',
      protected: true,
    });
    await t.db
      .updateTable('team_roles')
      .set({ effective_to: t.clock.now() })
      .where('team_entry_id', '=', teamEntryId)
      .where('person_id', '=', coCaptain)
      .execute();
    await dispatchOutbox(t.app);
    const after = await recipientsOf(t.db, org, protectedNotice.id);
    expect(after.find((r) => r.person_id === coCaptain)).toMatchObject({ status: 'revoked' });
    expect(after.find((r) => r.person_id === captain)?.status).toBe('authorized');

    // a later team notice no longer reaches the former co-captain
    const later = await notifications.composeAndQueue(system, {
      kind: 'staff_broadcast',
      category: 'operational',
      audience: { teamEntryIds: [teamEntryId] },
      title: 'Falcons: next week',
      body: 'Training as usual.',
    });
    expect((await recipientsOf(t.db, org, later.id)).map((r) => r.person_id)).not.toContain(
      coCaptain,
    );
  });

  it('SPK-CAP-001: a team invitation to a known person queues one team_invitation notice; a contact-only invitation queues none', async () => {
    const { teamEntryId } = await team('Herons');
    const invitee = await adult();
    const invitationId = newId();
    const eventId = await announce(CompetitionEvents.teamInvitationCreated, invitationId, {
      invitationId,
      teamEntryId,
      recipientPersonId: invitee,
      recipientContactKind: null,
      expiresAt: '2026-10-26T12:00:00.000Z',
    });
    const [notice, ...more] = await noticesFrom(eventId);
    expect(more).toHaveLength(0);
    expect(notice).toMatchObject({
      kind: 'team_invitation',
      category: 'operational',
      protected: true,
      subject_type: 'team_invitation',
      subject_id: invitationId,
      status: 'dispatched',
    });
    expect(notice?.title).toBe('Team invitation: Herons');
    expect((await recipientsOf(t.db, org, notice?.id as string)).map((r) => r.person_id)).toEqual([
      invitee,
    ]);
    const inbox = await t.http.get('/v1/me/inbox').set(await authHeaderForPerson(t, invitee));
    expect(inbox.body.items.map((i: { notificationId: string }) => i.notificationId)).toContain(
      notice?.id,
    );

    // a child invitee: their guardian (receive_messages) is told, never the child directly
    const childInvitation = newId();
    const childEvent = await announce(CompetitionEvents.teamInvitationCreated, childInvitation, {
      invitationId: childInvitation,
      teamEntryId,
      recipientPersonId: people.child.personId,
      recipientContactKind: null,
      expiresAt: '2026-10-26T12:00:00.000Z',
    });
    const [childNotice] = await noticesFrom(childEvent);
    expect(
      (await recipientsOf(t.db, org, childNotice?.id as string)).map((r) => [
        r.person_id,
        r.resolved_basis,
      ]),
    ).toEqual([[people.adult.personId, 'receive_messages']]);

    const contactOnly = newId();
    const contactEvent = await announce(CompetitionEvents.teamInvitationCreated, contactOnly, {
      invitationId: contactOnly,
      teamEntryId,
      recipientPersonId: null,
      recipientContactKind: 'email',
      expiresAt: '2026-10-26T12:00:00.000Z',
    });
    expect(await noticesFrom(contactEvent)).toHaveLength(0);
  });

  it('SPK-COMMS-002: a published result is one result_published notice to both entries’ team audiences', async () => {
    const home = await team('Owls');
    const away = await team('Ravens');
    const homePlayer = await adult();
    const awayPlayer = await adult();
    await addRosterMemberFixture(t, { teamEntryId: home.teamEntryId, personId: homePlayer });
    await addRosterMemberFixture(t, { teamEntryId: away.teamEntryId, personId: awayPlayer });
    const fixtureId = await createFixtureFixture(t, {
      seasonId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
    });
    const resultRevisionId = newId();
    const eventId = await announce(MatchEvents.resultPublished, resultRevisionId, {
      resultRevisionId,
      fixtureId,
      seasonId,
      divisionId: null,
      status: 'official',
      classification: 'completed',
      supersededRevisionId: null,
      standingsProjectionId: null,
      reviewExceptionId: null,
      affectedBracketNodeIds: [],
      affectedFixtureIds: [],
      operationId: newId(),
    });
    const notices = await noticesFrom(eventId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'result_published',
      subject_type: 'fixture',
      subject_id: fixtureId,
      title: 'Result published: Owls vs Ravens',
      status: 'dispatched',
    });
    const recipients = (await recipientsOf(t.db, org, notices[0]?.id as string)).map(
      (r) => r.person_id,
    );
    expect(recipients.sort()).toEqual([home.captain, away.captain, homePlayer, awayPlayer].sort());
  });

  it('SPK-CAP-001: an availability request queues one notice per recipient and a guardian with receive_messages gets the child’s', async () => {
    const { teamEntryId } = await team('Swifts');
    const player = await adult();
    const requestId = newId();
    const fixtureId = newId();
    const eventId = await announce(CompetitionEvents.availabilityRequested, requestId, {
      requestId,
      fixtureId,
      teamEntryId,
      recipientPersonIds: [player, people.child.personId],
      scheduledStart: '2026-10-31T17:00:00.000Z',
      facilityId: t.facilityId,
    });
    const notices = await noticesFrom(eventId);
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    expect(notice).toMatchObject({
      kind: 'availability_request',
      category: 'operational',
      protected: true,
      facility_id: t.facilityId,
      subject_type: 'fixture',
      subject_id: fixtureId,
      status: 'dispatched',
    });
    // facility-local time (America/Los_Angeles): 17:00Z is 10:00 AM
    expect(notice?.body).toContain('Sat, Oct 31, 10:00 AM');
    const recipients = await recipientsOf(t.db, org, notice?.id as string);
    expect(recipients.map((r) => [r.person_id, r.resolved_basis]).sort()).toEqual(
      [
        [player, 'self'],
        [people.adult.personId, 'receive_messages'],
      ].sort(),
    );
    // each recipient has the notice in their inbox; the child is never addressed directly
    for (const personId of [player, people.adult.personId]) {
      const inbox = await t.http.get('/v1/me/inbox').set(await authHeaderForPerson(t, personId));
      const item = inbox.body.items.find(
        (i: { notificationId: string }) => i.notificationId === notice?.id,
      );
      expect(item, personId).toBeDefined();
    }
    const guardianItem = (
      await t.http.get('/v1/me/inbox').set(await authHeaderForPerson(t, people.adult.personId))
    ).body.items.find((i: { notificationId: string }) => i.notificationId === notice?.id);
    expect(guardianItem.subjectPersonIds).toEqual([people.child.personId]);
    expect(recipients.map((r) => r.person_id)).not.toContain(people.child.personId);
  });

  it('a replayed availability_requested event queues nothing new', async () => {
    const { teamEntryId } = await team('Kites');
    const player = await adult();
    const requestId = newId();
    const payload = {
      requestId,
      fixtureId: newId(),
      teamEntryId,
      recipientPersonIds: [player],
      scheduledStart: '2026-11-07T17:00:00.000Z',
      facilityId: null,
    };
    const eventId = await announce(CompetitionEvents.availabilityRequested, requestId, payload);
    expect(await noticesFrom(eventId)).toHaveLength(1);
    // the dispatcher redelivers the event
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null })
      .where('id', '=', eventId)
      .execute();
    await dispatchOutbox(t.app);
    // and the handler itself is called again with the same event
    const event: DomainEvent<typeof payload> = {
      id: eventId,
      type: CompetitionEvents.availabilityRequested.type,
      organizationId: org,
      aggregateType: 'competition',
      aggregateId: requestId,
      payload,
      correlationId: null,
      operationId: null,
      occurredAt: t.clock.now().toISOString(),
    } as unknown as DomainEvent<typeof payload>;
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) => t.app.get(CompetitionNotices).onAvailabilityRequested(trx, event as never));
    expect(await noticesFrom(eventId)).toHaveLength(1);
    const all = await t.db
      .selectFrom('notifications')
      .select('id')
      .where('organization_id', '=', org)
      .where('kind', '=', 'availability_request')
      .where('subject_id', '=', payload.fixtureId)
      .execute();
    expect(all).toHaveLength(1);
  });
});
