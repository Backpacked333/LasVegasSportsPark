import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, OutboxDispatcher, UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { IdentityEvents } from '../../identity';
import { SUSPENSION_CHECK_PORT, type SuspensionCheckPort } from '../ports';
import { createSuspensionFixture } from '../testing/competition-matches-fixtures';
import {
  addRosterMemberFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, staffMember, type Actor } from './support';

/**
 * Person merge follow-up (CMP-08; SPK-IAM-007, SPK-COMP-005, §4.7 invariant 2, §4.2): competition
 * never rewrites a person id; reads resolve merges through the person directory
 * (personIdsResolvingTo, IF-09), and a merge that leaves the survivor and the merged person on one
 * entry raises one league-manager exception per merge.
 */
describe('person merge follow-up (CMP-08; SPK-IAM-007)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let season: SeasonFixture;

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    season = await createSeasonFixture(t, { status: 'open' });
  });
  afterAll(async () => {
    await t.close();
  });

  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);

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
    const uow = t.app.get(UnitOfWork);
    const outbox = t.app.get(Outbox);
    await uow.run(async ({ trx }) => {
      await outbox.enqueue(trx, IdentityEvents.personsMerged, {
        organizationId: t.organizationId,
        aggregateType: 'person',
        aggregateId: payload.survivorPersonId,
        payload: { ...payload, operationId: newId() },
      });
    });
    const summary = await t.app.get(OutboxDispatcher).runOnce(200);
    expect(summary.dead).toBe(0);
  }

  it('SPK-IAM-007: a suspension of the merged person blocks the survivor', async () => {
    const captain = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
    });
    const survivor = await adultCustomer(t);
    const merged = await adultCustomer(t);
    const suspensionId = await createSuspensionFixture(t, {
      subjectPersonId: merged.personId,
      status: 'active',
      scope: 'all',
    });
    const eligibility = () =>
      get(
        `/team-entries/${entry.teamEntryId}/eligibility?personId=${survivor.personId}&status=active`,
        leagueManager,
      );
    const before = await eligibility();
    expect(before.status).toBe(200);
    expect(before.body.reasons.map((r: { code: string }) => r.code)).not.toContain('suspended');

    await markMerged(merged.personId, survivor.personId);
    const after = await eligibility();
    expect(after.status).toBe(200);
    expect(after.body.eligible).toBe(false);
    const suspended = after.body.reasons.find((r: { code: string }) => r.code === 'suspended');
    expect(suspended).toBeDefined();
    // the suspension port answers for the survivor too (the suspension row is not rewritten)
    const port = t.app.get<SuspensionCheckPort>(SUSPENSION_CHECK_PORT);
    const active = await port.activeSuspensions(
      t.organizationId,
      survivor.personId,
      t.clock.now(),
      {
        competitionId: season.competitionId,
        seasonId: season.seasonId,
        teamEntryId: entry.teamEntryId,
      },
    );
    expect(active.map((s) => s.id)).toEqual([suspensionId]);
    const row = await t.db
      .selectFrom('suspensions')
      .select('subject_person_id')
      .where('id', '=', suspensionId)
      .executeTakeFirstOrThrow();
    expect(row.subject_person_id).toBe(merged.personId);
  });

  it('CMP-08: a merge leaving two roster rows in one entry raises one league-manager exception and rewrites nothing', async () => {
    const captainA = await adultCustomer(t);
    const captainB = await adultCustomer(t);
    const shared = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captainA.personId,
    });
    const separate = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captainB.personId,
    });
    const survivor = await adultCustomer(t);
    const merged = await adultCustomer(t);
    await addRosterMemberFixture(t, {
      teamEntryId: shared.teamEntryId,
      personId: survivor.personId,
    });
    await addRosterMemberFixture(t, { teamEntryId: shared.teamEntryId, personId: merged.personId });
    await addRosterMemberFixture(t, {
      teamEntryId: separate.teamEntryId,
      personId: merged.personId,
    });
    const rosterBefore = await t.db
      .selectFrom('roster_memberships')
      .select(['id', 'person_id', 'team_entry_id', 'effective_to', 'status'])
      .where('person_id', 'in', [survivor.personId, merged.personId])
      .orderBy('id')
      .execute();

    await markMerged(merged.personId, survivor.personId);
    const mergeId = newId();
    await announceMerge({
      mergeId,
      survivorPersonId: survivor.personId,
      mergedPersonId: merged.personId,
    });
    const raised = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', 'competition.merged_roster_duplicate')
      .execute();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      owner_queue: 'league_manager',
      affected_type: 'person_merge',
      affected_id: mergeId,
      status: 'open',
    });
    expect(raised[0]?.details).toMatchObject({
      mergeId,
      survivorPersonId: survivor.personId,
      mergedPersonId: merged.personId,
      teamEntryIds: [shared.teamEntryId],
    });
    // nothing is rewritten: roster rows keep the ids they were recorded with
    expect(
      await t.db
        .selectFrom('roster_memberships')
        .select(['id', 'person_id', 'team_entry_id', 'effective_to', 'status'])
        .where('person_id', 'in', [survivor.personId, merged.personId])
        .orderBy('id')
        .execute(),
    ).toEqual(rosterBefore);

    // replayed and redelivered: still one exception for the merge
    await announceMerge({
      mergeId,
      survivorPersonId: survivor.personId,
      mergedPersonId: merged.personId,
    });
    expect(
      await t.db
        .selectFrom('operational_exceptions')
        .select('id')
        .where('category', '=', 'competition.merged_roster_duplicate')
        .execute(),
    ).toHaveLength(1);
  });

  it('CMP-08: a merge without a shared entry raises nothing', async () => {
    const captain = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
    });
    const survivor = await adultCustomer(t);
    const merged = await adultCustomer(t);
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: merged.personId });
    await markMerged(merged.personId, survivor.personId);
    const mergeId = newId();
    await announceMerge({
      mergeId,
      survivorPersonId: survivor.personId,
      mergedPersonId: merged.personId,
    });
    expect(
      await t.db
        .selectFrom('operational_exceptions')
        .select('id')
        .where('affected_id', '=', mergeId)
        .execute(),
    ).toEqual([]);
  });
});
