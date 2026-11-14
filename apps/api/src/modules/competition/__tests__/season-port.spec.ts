import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import { CompetitionModule } from '../competition.module';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../ports';
import { createCompetitionFixture, createSeasonFixture } from '../testing/competition-fixtures';

/**
 * `TeamEntryQueryPort.findSeason` (SPK-COMMS-009, proposed amendment PA-05): the read-only season
 * facts communications fills message placeholders with and counts due times from.
 */
describe('TeamEntryQueryPort.findSeason (SPK-COMMS-009)', () => {
  let t: TestApp;
  let port: TeamEntryQueryPort;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CompetitionModule],
      principalResolver: 'module',
      clockStart: '2026-11-01T12:00:00Z',
    });
    port = t.app.get<TeamEntryQueryPort>(TEAM_ENTRY_QUERY_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  it("SPK-COMMS-009: answers the season's own dates and names, inside or outside a transaction, and writes nothing", async () => {
    const competitionId = await createCompetitionFixture(t, { name: 'Adult coed league' });
    const { seasonId } = await createSeasonFixture(t, {
      competitionId,
      name: 'Winter 2027',
      startsOn: '2027-01-10',
      endsOn: '2027-04-10',
      registrationOpensAt: new Date('2026-12-01T18:00:00Z'),
      registrationClosesAt: null,
      status: 'open',
    });
    const before = await t.db
      .selectFrom('seasons')
      .select(['revision', 'updated_at'])
      .where('id', '=', seasonId)
      .executeTakeFirstOrThrow();
    const expected = {
      id: seasonId,
      organizationId: t.organizationId,
      competitionId,
      competitionName: 'Adult coed league',
      name: 'Winter 2027',
      startsOn: '2027-01-10',
      endsOn: '2027-04-10',
      registrationOpensAt: new Date('2026-12-01T18:00:00Z'),
      registrationClosesAt: null,
      status: 'open',
      revision: 1,
    };
    expect(await port.findSeason(t.organizationId, seasonId)).toEqual(expected);
    const inside = await t.app
      .get(UnitOfWork)
      .run(({ trx }) => port.findSeason(t.organizationId, seasonId, trx));
    expect(inside).toEqual(expected);
    const after = await t.db
      .selectFrom('seasons')
      .select(['revision', 'updated_at'])
      .where('id', '=', seasonId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it('§4.3: an unknown season, or a season of another organization, is not found', async () => {
    expect(await port.findSeason(t.organizationId, newId())).toBeNull();
    const other = await seedOrganization(t.db, { slug: `other-${newId()}` });
    const foreign = await createSeasonFixture(t, { organizationId: other.organizationId });
    expect(await port.findSeason(t.organizationId, foreign.seasonId)).toBeNull();
    expect(await port.findSeason(other.organizationId, foreign.seasonId)).toMatchObject({
      id: foreign.seasonId,
      organizationId: other.organizationId,
    });
  });
});
