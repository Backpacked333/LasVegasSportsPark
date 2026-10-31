import { newId, systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationsService, Outbox, UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  addRosterMemberFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { IdentityEvents } from '../../identity';
import { CapacityService } from '../services/capacity.service';
import { RECONCILE_PLACEMENTS_JOB } from '../services/enrollment-jobs';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import {
  acknowledge,
  adult,
  basketWith,
  child,
  drain,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
} from './support';

/** ENR-07 (merge follow-up), ENR-08 (placement reconciler) and ENR-09 (enrollment notices). */
describe('enrollment follow-ups (ENR-07, ENR-08, ENR-09)', () => {
  let t: TestApp;
  let programManager: Actor;
  let leagueManager: Actor;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    programManager = await staff(t, ['program_manager']);
    leagueManager = await staff(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  // -------------------------------------------------------------------------------------------
  // ENR-07
  // -------------------------------------------------------------------------------------------

  async function merge(survivor: string, merged: string, mergeId = newId()) {
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: survivor })
      .where('id', '=', merged)
      .execute();
    await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app.get(Outbox).enqueue(trx, IdentityEvents.personsMerged, {
        organizationId: t.organizationId,
        aggregateType: 'person',
        aggregateId: survivor,
        payload: {
          mergeId,
          survivorPersonId: survivor,
          mergedPersonId: merged,
          operationId: newId(),
        },
      }),
    );
    await drain(t);
    return mergeId;
  }

  const duplicates = (survivor: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', 'enrollment.merged_duplicate_entitlement')
      .where('organization_id', '=', t.organizationId)
      .execute()
      .then((rows) =>
        rows.filter(
          (r) => (r.details as { survivorPersonId?: string }).survivorPersonId === survivor,
        ),
      );

  it('SPK-IAM-007: a merge leaving two equivalent active enrollments raises one exception and cancels nothing', async () => {
    const survivor = await adult(t);
    const duplicate = await adult(t);
    const setup = await offering(t);
    const kept = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: survivor.personId,
      equivalenceKey: `offering:${setup.offeringId}`,
    });
    const second = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: duplicate.personId,
      equivalenceKey: `offering:${setup.offeringId}`,
    });
    // An unrelated enrollment of the merged person is no duplicate.
    const other = await offering(t);
    await createEnrollmentFixture(t, {
      offeringId: other.offeringId,
      participantPersonId: duplicate.personId,
      equivalenceKey: `offering:${other.offeringId}`,
    });
    const mergeId = await merge(survivor.personId, duplicate.personId);
    const raised = await duplicates(survivor.personId);
    expect(raised).toEqual([
      expect.objectContaining({
        status: 'open',
        owner_queue: 'program_manager',
        affected_type: 'enrollment',
        affected_id: kept,
        details: expect.objectContaining({
          mergeId,
          survivorRecordId: kept,
          mergedRecordId: second,
          recordType: 'enrollment',
        }),
      }),
    ]);
    const statuses = await t.db
      .selectFrom('enrollments')
      .select(['id', 'status'])
      .where('id', 'in', [kept, second])
      .execute();
    expect(statuses.map((s) => s.status)).toEqual(['confirmed', 'confirmed']);
    // A second delivery of the same merge raises nothing more (idempotent by merge).
    await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app.get(Outbox).enqueue(trx, IdentityEvents.personsMerged, {
        organizationId: t.organizationId,
        aggregateType: 'person',
        aggregateId: survivor.personId,
        payload: {
          mergeId,
          survivorPersonId: survivor.personId,
          mergedPersonId: duplicate.personId,
          operationId: newId(),
        },
      }),
    );
    await drain(t);
    expect(await duplicates(survivor.personId)).toHaveLength(1);
  });

  it("SPK-IAM-007: the survivor's me-lists show the merged person's records", async () => {
    const survivor = await adult(t);
    const duplicate = await adult(t);
    const setup = await offering(t, { ageBand: { minAgeYears: 18 } });
    const applied = await post(t, '/v1/applications', duplicate.header, {
      offeringId: setup.offeringId,
      participantPersonId: duplicate.personId,
      intent: 'individual_league',
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const basket = await post(t, '/v1/baskets', duplicate.header, {
      ownerPersonId: duplicate.personId,
    });
    expect(basket.status).toBe(201);
    await merge(survivor.personId, duplicate.personId);
    const applications = await t.http.get('/v1/me/applications').set(survivor.header);
    expect(applications.body.items.map((a: { id: string }) => a.id)).toContain(applied.body.id);
    const baskets = await t.http.get('/v1/me/baskets').set(survivor.header);
    expect(baskets.body.items.map((b: { id: string }) => b.id)).toContain(basket.body.id);
  });

  // -------------------------------------------------------------------------------------------
  // ENR-08
  // -------------------------------------------------------------------------------------------

  async function interruptedAssignment(rosterAdded: boolean) {
    const seasonId = (await createSeasonFixture(t)).seasonId;
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: (await adult(t)).personId,
      teamName: 'Herons',
    });
    const pool = await post(t, '/v1/capacity-pools', programManager.header, {
      scopeType: 'team_entry',
      scopeId: entry.teamEntryId,
      unit: 'roster_places',
      capacity: 2,
    });
    expect(pool.status).toBe(201);
    const player = await adult(t, { dateOfBirth: '1996-06-06' });
    const requested = await post(t, '/v1/placement-requests', player.header, {
      participantPersonId: player.personId,
      seasonId,
    });
    const placementId = requested.body.id as string;
    const system = systemPrincipal(t.organizationId, 'test.interrupted_assignment');
    // Step 1 of an assignment committed, then the process stopped (before or after the roster add).
    const operationId = await t.app.get(UnitOfWork).run(async ({ trx }) => {
      await t.app.get(CapacityService).acquireHolds(trx, t.organizationId, {
        pools: [{ poolId: pool.body.id as string, quantity: 1 }],
        ownerKind: 'placement',
        ownerId: placementId,
        actor: system,
        expiresAt: new Date(t.clock.now().getTime() + 10 * 60_000),
      });
      const id = await t.app.get(OperationsService).create(trx, {
        organizationId: t.organizationId,
        kind: 'enrollment.assign_placement',
        requestedBy: system,
        input: { placementRequestId: placementId, teamEntryId: entry.teamEntryId },
        status: 'running',
      });
      await trx
        .updateTable('placement_requests')
        .set({ last_operation_id: id })
        .where('id', '=', placementId)
        .execute();
      return id;
    });
    const membershipId = rosterAdded
      ? await addRosterMemberFixture(t, {
          teamEntryId: entry.teamEntryId,
          personId: player.personId,
        })
      : null;
    return {
      placementId,
      operationId,
      membershipId,
      entry,
      player,
      poolId: pool.body.id as string,
    };
  }

  const reconcile = () => t.runPeriodicJobs([RECONCILE_PLACEMENTS_JOB]);

  it('SPK-AT-023: a placement interrupted after the roster addition is completed by the reconciler without a duplicate', async () => {
    const { placementId, operationId, membershipId, entry, player, poolId } =
      await interruptedAssignment(true);
    // Not yet: the operation is younger than ENROLLMENT_PLACEMENT_RECONCILE_AFTER_SECONDS.
    expect((await reconcile())[0]).toMatchObject({ processed: 0 });
    t.clock.advance(6 * 60_000);
    expect((await reconcile())[0]).toMatchObject({ processed: 1, failed: false });
    const placement = await t.http
      .get(`/v1/placement-requests/${placementId}`)
      .set(leagueManager.header);
    expect(placement.body).toMatchObject({
      status: 'assigned',
      assignedTeamEntryId: entry.teamEntryId,
      assignedTeamName: 'Herons',
      rosterMembershipRef: membershipId,
    });
    const operation = await t.db
      .selectFrom('operations')
      .select(['status', 'result'])
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({
      status: 'succeeded',
      result: { rosterMembershipId: membershipId },
    });
    const rosterRows = await t.db
      .selectFrom('roster_memberships')
      .select('id')
      .where('team_entry_id', '=', entry.teamEntryId)
      .where('person_id', '=', player.personId)
      .execute();
    expect(rosterRows).toHaveLength(1);
    const counts = await t.db
      .selectFrom('capacity_pools')
      .select(['committed', 'held'])
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();
    expect(counts).toEqual({ committed: 1, held: 0 });
    // Nothing is left to reconcile.
    expect((await reconcile())[0]).toMatchObject({ processed: 0 });
  });

  it('SPK-AT-023: an interrupted placement before the roster addition releases its hold', async () => {
    const { placementId, operationId, poolId } = await interruptedAssignment(false);
    t.clock.advance(6 * 60_000);
    expect((await reconcile())[0]).toMatchObject({ processed: 1 });
    const operation = await t.db
      .selectFrom('operations')
      .select(['status', 'error'])
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({ status: 'failed', error: { code: 'PLACEMENT_INTERRUPTED' } });
    const counts = await t.db
      .selectFrom('capacity_pools')
      .select(['committed', 'held'])
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();
    expect(counts).toEqual({ committed: 0, held: 0 });
    const placement = await t.db
      .selectFrom('placement_requests')
      .select('status')
      .where('id', '=', placementId)
      .executeTakeFirstOrThrow();
    expect(placement.status).toBe('unassigned');
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', 'enrollment.placement_interrupted')
      .where('affected_id', '=', placementId)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({ owner_queue: 'program_manager', status: 'open' });
  });

  // -------------------------------------------------------------------------------------------
  // ENR-09
  // -------------------------------------------------------------------------------------------

  it('SPK-COMMS-002: a staff-issued waitlist offer queues one waitlist_offer notice to the guardian with receive_messages', async () => {
    const setup = await offering(t, {
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const holder = await adult(t);
    const seated = await child(t, [holder]);
    await acknowledge(t, setup, seated, holder.personId);
    const first = await basketWith(t, holder, [
      { participantPersonId: seated, offeringId: setup.offeringId },
    ]);
    await post(t, `/v1/baskets/${first.id}/hold`, holder.header);
    const completed = await post(t, `/v1/baskets/${first.id}/complete`, holder.header);
    const guardian = await adult(t);
    const kid = await child(t, [guardian], {
      permissions: ['view', 'register', 'pay', 'receive_messages'],
    });
    await acknowledge(t, setup, kid, guardian.personId);
    const joined = await post(t, '/v1/waitlist-entries', guardian.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(joined.status).toBe(201);
    await post(
      t,
      `/v1/enrollments/${completed.body.lines[0].enrollmentId as string}/cancel`,
      holder.header,
      {
        reason: 'moved',
        expectedRevision: 2,
      },
    );
    const offered = await post(
      t,
      `/v1/waitlist-entries/${joined.body.id as string}/offer`,
      programManager.header,
      {
        reason: 'next in line',
      },
    );
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    await drain(t);
    const offerId = offered.body.offers[0].id as string;
    const notices = await t.db
      .selectFrom('notifications')
      .selectAll()
      .where('kind', '=', 'waitlist_offer')
      .where('subject_id', '=', offerId)
      .execute();
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice).toMatchObject({ protected: true, category: 'operational' });
    expect(notice.status).not.toBe('suppressed');
    expect(notice.body).toContain('America/Los_Angeles');
    const recipients = await t.db
      .selectFrom('notification_recipients')
      .select(['person_id', 'resolved_basis'])
      .where('notification_id', '=', notice.id)
      .execute();
    expect(recipients).toContainEqual({
      person_id: guardian.personId,
      resolved_basis: 'receive_messages',
    });
    expect(recipients.map((r) => r.person_id)).not.toContain(holder.personId);

    // A replayed waitlist_offer_made event queues nothing new.
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null, available_at: t.clock.now() })
      .where('event_type', '=', 'enrollment.waitlist_offer_made')
      .where('aggregate_id', '=', offerId)
      .execute();
    await drain(t);
    const after = await t.db
      .selectFrom('notifications')
      .select('id')
      .where('kind', '=', 'waitlist_offer')
      .where('subject_id', '=', offerId)
      .execute();
    expect(after).toHaveLength(1);
  });

  it('SPK-COMMS-002: application decisions and placements notify the participant’s family', async () => {
    const season = await offering(t, {
      kind: 'season',
      basePriceMinor: 0,
      ageBand: { minAgeYears: 18 },
    });
    const captain = await adult(t);
    const applied = await post(t, '/v1/applications', captain.header, {
      offeringId: season.offeringId,
      participantPersonId: captain.personId,
      intent: 'create_team_entry',
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const decided = await post(
      t,
      `/v1/applications/${applied.body.id as string}/accept`,
      programManager.header,
      {
        expectedRevision: applied.body.revision,
      },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    await drain(t);
    const outcome = await t.db
      .selectFrom('notifications')
      .select(['kind', 'title'])
      .where('subject_id', '=', applied.body.id as string)
      .execute();
    expect(outcome).toEqual([{ kind: 'registration_outcome', title: 'Registration approved' }]);

    const seasonId = (await createSeasonFixture(t)).seasonId;
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: (await adult(t)).personId,
      teamName: 'Kestrels',
    });
    const player = await adult(t, { dateOfBirth: '1997-07-07' });
    const requested = await post(t, '/v1/placement-requests', player.header, {
      participantPersonId: player.personId,
      seasonId,
    });
    const assigned = await post(
      t,
      `/v1/placement-requests/${requested.body.id as string}/assign`,
      leagueManager.header,
      {
        teamEntryId: entry.teamEntryId,
        expectedRevision: requested.body.revision,
      },
    );
    expect(assigned.status).toBe(200);
    await drain(t);
    const placement = await t.db
      .selectFrom('notifications')
      .select(['kind', 'body'])
      .where('subject_id', '=', requested.body.id as string)
      .executeTakeFirstOrThrow();
    expect(placement.kind).toBe('placement');
    expect(placement.body).toContain('Kestrels');
  });
});
