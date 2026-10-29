import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, OutboxDispatcher, UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { IdentityEvents } from '../../identity';
import { at, createScheduledEvent, EventsService } from '../../scheduling';
import { MERGED_PERSON_OVERLAP } from '../workforce.policy';
import {
  createAssignmentFixture,
  createAvailabilityFixture,
  createQualificationFixture,
  createRequirementFixture,
} from '../testing/workforce-fixtures';
import {
  adultCustomer,
  competitionWorld,
  drainOutbox,
  post,
  scheduleFixture,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

/**
 * Person merge follow-up (WRK-05; SPK-IAM-007, SPK-STAFF-001, §4.2, IF-21, IF-09): workforce never
 * rewrites a person id; reads resolve merges through the person directory, and a merge that leaves
 * one person holding overlapping accepted assignments raises one scheduler exception.
 */
describe('person merge follow-up (WRK-05)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let events: EventsService;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    events = t.app.get(EventsService);
  });
  afterAll(async () => {
    await t.close();
  });

  /** What identity's merge does to the persons table (identity owns it; a fixture here). */
  async function markMerged(mergedPersonId: string, survivorPersonId: string): Promise<void> {
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: survivorPersonId })
      .where('id', '=', mergedPersonId)
      .execute();
  }

  /** Announces identity.persons_merged through the outbox and delivers it. */
  async function announceMerge(payload: {
    mergeId: string;
    survivorPersonId: string;
    mergedPersonId: string;
  }): Promise<void> {
    await t.app.get(UnitOfWork).run(async ({ trx }) => {
      await t.app.get(Outbox).enqueue(trx, IdentityEvents.personsMerged, {
        organizationId: t.organizationId,
        aggregateType: 'person',
        aggregateId: payload.survivorPersonId,
        payload: { ...payload, operationId: newId() },
      });
    });
    const summary = await t.app.get(OutboxDispatcher).runOnce(200);
    expect(summary.dead).toBe(0);
  }

  const overlapExceptions = (survivorPersonId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', MERGED_PERSON_OVERLAP)
      .where('affected_id', '=', survivorPersonId)
      .execute();

  async function acceptedCoaching(
    personId: string,
    half: 'north' | 'south',
    date: string,
    from: string,
    to: string,
  ) {
    const north = half === 'north';
    const event = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [north ? world.pitch.northHalfId : world.pitch.southHalfId],
      start: at(date, from),
      end: at(date, to),
      kind: 'practice',
      title: `Practice ${date} ${from}`,
    });
    return createAssignmentFixture(t, {
      targetType: 'event',
      targetId: event.id,
      personId,
      kind: 'coach',
      role: 'head_coach',
      status: 'accepted',
      scheduledStart: event.scheduledStart,
      scheduledEnd: event.scheduledEnd,
    });
  }

  const assignmentRows = (ids: string[]) =>
    t.db
      .selectFrom('assignments')
      .select(['id', 'person_id', 'status', 'revision'])
      .where('id', 'in', ids)
      .orderBy('id')
      .execute();

  it('SPK-IAM-007: overlapping accepted assignments of the two persons raise one scheduler exception and change nothing', async () => {
    const survivor = await adultCustomer(t);
    const merged = await adultCustomer(t);
    // 09:00-10:00 and 09:30-10:30 on 2027-03-06 overlap; 2027-03-07 does not overlap anything
    const kept = await acceptedCoaching(survivor.personId, 'north', '2027-03-06', '09:00', '10:00');
    const clashing = await acceptedCoaching(
      merged.personId,
      'south',
      '2027-03-06',
      '09:30',
      '10:30',
    );
    const apart = await acceptedCoaching(merged.personId, 'north', '2027-03-07', '09:00', '10:00');
    const before = await assignmentRows([kept, clashing, apart]);

    const mergeId = newId();
    await markMerged(merged.personId, survivor.personId);
    await announceMerge({
      mergeId,
      survivorPersonId: survivor.personId,
      mergedPersonId: merged.personId,
    });

    const raised = await overlapExceptions(survivor.personId);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      owner_queue: 'scheduler',
      status: 'open',
      severity: 'high',
      affected_type: 'person',
      facility_id: t.facilityId,
      details: {
        mergeId,
        survivorPersonId: survivor.personId,
        mergedPersonId: merged.personId,
        assignmentIds: [kept, clashing].sort(),
        overlaps: [{ survivorAssignmentId: kept, mergedAssignmentId: clashing }],
      },
    });
    // no assignment row is rewritten
    expect(await assignmentRows([kept, clashing, apart])).toEqual(before);
  });

  it('a replayed merge event raises nothing new', async () => {
    const survivor = await adultCustomer(t);
    const merged = await adultCustomer(t);
    await acceptedCoaching(survivor.personId, 'north', '2027-03-13', '09:00', '10:00');
    await acceptedCoaching(merged.personId, 'south', '2027-03-13', '09:00', '10:00');
    const payload = {
      mergeId: newId(),
      survivorPersonId: survivor.personId,
      mergedPersonId: merged.personId,
    };
    await markMerged(merged.personId, survivor.personId);
    await announceMerge(payload);
    expect(await overlapExceptions(survivor.personId)).toHaveLength(1);
    // the same delivery replayed
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', locked_until: null, dispatched_at: null })
      .where('event_type', '=', 'identity.persons_merged')
      .where('aggregate_id', '=', survivor.personId)
      .execute();
    await drainOutbox(t);
    // the same merge announced again under another event id (idempotent by merge id)
    await announceMerge(payload);
    expect(await overlapExceptions(survivor.personId)).toHaveLength(1);
    // a merge without overlapping work raises nothing
    const quiet = await adultCustomer(t);
    const folded = await adultCustomer(t);
    await acceptedCoaching(folded.personId, 'north', '2027-03-14', '09:00', '10:00');
    await markMerged(folded.personId, quiet.personId);
    await announceMerge({
      mergeId: newId(),
      survivorPersonId: quiet.personId,
      mergedPersonId: folded.personId,
    });
    expect(await overlapExceptions(quiet.personId)).toEqual([]);
  });

  it('a qualification verified for the merged person satisfies a requirement for the survivor', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-03-20' });
    await createRequirementFixture(t, {
      targetType: 'fixture',
      targetId: game.fixtureId,
      kind: 'official',
      role: 'referee',
      requiredQualifications: ['referee_level_one'],
    });
    const survivor: Actor = await adultCustomer(t);
    const merged = await adultCustomer(t);
    await createQualificationFixture(t, { personId: merged.personId, kind: 'referee_level_one' });
    const propose = () =>
      post(t, '/v1/assignments', world.leagueManager, {
        personId: survivor.personId,
        kind: 'official',
        targetType: 'fixture',
        targetId: game.fixtureId,
        role: 'referee',
      });
    const refused = await propose();
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.details.reasons).toEqual([
      expect.objectContaining({ code: 'qualification_missing', kind: 'referee_level_one' }),
    ]);

    await markMerged(merged.personId, survivor.personId);
    const allowed = await propose();
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    // the evidence is read, not moved: the qualification still names the merged person
    const evidence = await t.http
      .get(`/v1/qualifications?personId=${survivor.personId}`)
      .set(world.leagueManager.header);
    expect(evidence.status).toBe(200);
    expect(evidence.body).toEqual([
      expect.objectContaining({ personId: merged.personId, kind: 'referee_level_one' }),
    ]);

    // declared unavailability of the merged person holds for the survivor as well
    const later = await scheduleFixture(t, world, { date: '2027-03-21' });
    await createAvailabilityFixture(t, {
      personId: merged.personId,
      start: at('2027-03-21', '12:00'),
      end: at('2027-03-21', '23:00'),
      kind: 'unavailable',
    });
    const unavailable = await post(t, '/v1/assignments', world.leagueManager, {
      personId: survivor.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: later.fixtureId,
      role: 'referee',
    });
    expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(409);
    expect(unavailable.body.details.conflicts).toEqual([
      expect.objectContaining({ code: 'person_unavailable' }),
    ]);
  });
});
