import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  CompetitionModule,
  addRosterMemberFixture,
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
import {
  EventsService,
  SchedulingModule,
  at,
  createScheduledEvent,
  seedPitchWithHalves,
  teamCommitment,
  type PitchFixture,
} from '../../scheduling';
import { CommunicationsModule } from '../communications.module';
import { NotificationsService } from '../services/notifications.service';
import {
  attemptsOf,
  deliverQueued,
  dispatchOutbox,
  fakeProviders,
  recipientsOf,
  type FakeProviders,
} from '../testing/communications-fixtures';

const key = () => `k-${newId()}`;

/**
 * SPK-COMMS-003 for team audiences: recipients are the CURRENT effective roster of a season team
 * entry (competition's exported roster port), adults themselves and the guardians of child members
 * through `receive_messages`; a player removed from the roster stops receiving protected notices
 * even when the notice was already queued (invariant 10). Calendar feeds follow team commitments.
 */
describe('team audiences (SPK-COMMS-003 via competition roster port, SPK-COMMS-008 team entries)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let fakes: FakeProviders;
  let notifications: NotificationsService;
  let events: EventsService;
  let pitch: PitchFixture;
  let people: OrganizationPeople;
  let staff: { Authorization: string };
  let captain: string;
  let adultPlayer: string;
  let teamEntryId: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CommunicationsModule, SchedulingModule, CompetitionModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    fakes = fakeProviders(t.app);
    notifications = t.app.get(NotificationsService);
    events = t.app.get(EventsService);
    pitch = await seedPitchWithHalves(t.db, { organizationId: org, facilityId: t.facilityId });
    people = await createOrganizationPeople(t, { staffRoles: ['league_manager'] });
    staff = await authHeaderForPerson(t, people.staff.personId);
    captain = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: captain });
    adultPlayer = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: adultPlayer });
    const season = await createSeasonFixture(t, {});
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain,
      teamName: 'Lions',
    });
    teamEntryId = entry.teamEntryId;
    await addRosterMemberFixture(t, { teamEntryId, personId: captain });
    await addRosterMemberFixture(t, { teamEntryId, personId: adultPlayer });
    await addRosterMemberFixture(t, {
      teamEntryId,
      personId: people.child.personId,
      status: 'guest',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const recipientFor = async (notificationId: string, personId: string) =>
    (await recipientsOf(t.db, org, notificationId)).find((r) => r.person_id === personId);

  it('resolves a team entry to its effective roster: adults as team members, guardians of child members through receive_messages; a former player is not a recipient', async () => {
    const former = await createPersonFixture(t, { kind: 'adult' });
    await addRosterMemberFixture(t, {
      teamEntryId,
      personId: former,
      effectiveFrom: new Date('2026-09-01T00:00:00Z'),
      effectiveTo: new Date('2026-10-01T00:00:00Z'),
    });
    const composed = await t.http
      .post('/v1/notifications')
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        kind: 'team_invitation',
        audience: { teamEntryIds: [teamEntryId] },
        title: 'Lions: season kickoff',
        body: 'First practice is next week.',
      });
    expect(composed.status).toBe(201);
    const preview = await t.http.get(`/v1/notifications/${composed.body.id}/recipients`).set(staff);
    expect(preview.status).toBe(200);
    const byPerson = Object.fromEntries(
      preview.body.recipients.map((r: { personId: string }) => [r.personId, r]),
    );
    expect(preview.body.count).toBe(3);
    expect(byPerson[captain]).toMatchObject({ basis: 'team_member', basisDetail: teamEntryId });
    expect(byPerson[adultPlayer]).toMatchObject({ basis: 'team_member', basisDetail: teamEntryId });
    // the child is not addressed directly; the guardian holding receive_messages is
    expect(byPerson[people.child.personId]).toBeUndefined();
    expect(byPerson[people.adult.personId]).toMatchObject({
      basis: 'receive_messages',
      basisDetail: teamEntryId,
      subjectPersonIds: [people.child.personId],
    });
    expect(byPerson[former]).toBeUndefined();
    expect(JSON.stringify(preview.body)).not.toContain('contactPoints');
  });

  it('invariant 10: a player removed from the roster after a protected team notice was queued is marked revoked at dispatch and nothing is sent to them', async () => {
    const notice = await notifications.composeAndQueue(system, {
      kind: 'result_published',
      audience: { teamEntryIds: [teamEntryId] },
      title: 'Match report (roster only)',
      body: 'Private match notes for the roster.',
      protected: true,
    });
    expect((await recipientFor(notice.id, adultPlayer))?.status).toBe('pending');
    // the roster row closes before the follow-up runs (removal keeps the row, SPK-COMP-005)
    await t.db
      .updateTable('roster_memberships')
      .set({
        status: 'removed',
        status_before_removal: 'active',
        effective_to: t.clock.now(),
        removed_at: t.clock.now(),
        removed_by: JSON.stringify({ kind: 'system' }),
        removal_reason: 'left the team',
      })
      .where('team_entry_id', '=', teamEntryId)
      .where('person_id', '=', adultPlayer)
      .execute();
    await dispatchOutbox(t.app);
    expect((await notifications.get(system, notice.id)).status).toBe('dispatched');
    expect(await recipientFor(notice.id, adultPlayer)).toMatchObject({
      status: 'revoked',
      revocation_reason: 'authority_revoked_before_dispatch',
    });
    expect((await recipientFor(notice.id, captain))?.status).toBe('authorized');
    expect((await recipientFor(notice.id, people.adult.personId))?.status).toBe('authorized');
    const removedRecipient = await recipientFor(notice.id, adultPlayer);
    const attempts = await attemptsOf(t.db, org, notice.id);
    expect(attempts.filter((a) => a.recipient_id === removedRecipient?.id)).toHaveLength(0);
    await deliverQueued(t.app);
    expect(fakes.push.sent.some((r) => r.personId === adultPlayer)).toBe(false);
    expect(fakes.push.sent.some((r) => r.personId === captain)).toBe(true);
  });

  it('SPK-COMMS-008: a player’s private feed includes the events their team entry is committed to', async () => {
    const game = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-14', '10:00'),
      end: at('2026-11-14', '11:00'),
      title: 'Lions vs Tigers',
      commitments: [teamCommitment(teamEntryId, 'home_team')],
    });
    await dispatchOutbox(t.app);
    const created = await t.http
      .post('/v1/me/calendar-feeds')
      .set(await authHeaderForPerson(t, captain))
      .set('Idempotency-Key', key())
      .send({ label: 'Team' });
    expect(created.status).toBe(201);
    const feed = await t.http.get(created.body.path);
    expect(feed.status).toBe(200);
    expect(feed.text).toContain(`UID:${game.id}`);
    expect(feed.text).toContain('SUMMARY:Lions vs Tigers');
    // the guardian's own feed does not include the team game: the guardian is not on the roster
    const guardianFeed = await t.http
      .post('/v1/me/calendar-feeds')
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send({});
    expect((await t.http.get(guardianFeed.body.path)).text).not.toContain(`UID:${game.id}`);
    // ...until the child is in scope: the child is a guest member of the team entry
    const familyFeed = await t.http
      .post('/v1/me/calendar-feeds')
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send({ subjectPersonIds: [people.child.personId] });
    expect((await t.http.get(familyFeed.body.path)).text).toContain(`UID:${game.id}`);
  });
});
