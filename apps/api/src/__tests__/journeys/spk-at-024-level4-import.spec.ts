import type { ImportEntityTypeValue, StagedRow } from '@sportspark/contracts';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import { createCompetitionFixture, createRuleSetFixture } from '../../modules/competition';
import {
  controlTotalsFor,
  stagedCredit,
  stagedEvent,
  stagedHousehold,
  stagedObligation,
  stagedPerson,
  stagedPreferences,
  stagedRelationship,
  stagedRoster,
  stagedSeason,
  stagedTeam,
  stagedTeamEntry,
} from '../../modules/migration';
import { at, seedPitchWithHalves } from '../../modules/scheduling';
import { drain, journeyApp, ok, post, staff, type Actor } from './support';

const CATEGORIES: readonly ImportEntityTypeValue[] = [
  'person',
  'household',
  'relationship_evidence',
  'program',
  'open_obligation',
  'credit',
  'season',
  'team',
  'roster',
  'future_schedule',
  'communication_preference',
];

/**
 * SPK-AT-024 (§5.3, §5.4, §5.5 level 4, §5.6): a migration snapshot imported twice keeps stable
 * identities and produces no repeated charges or messages, on the assembled application where
 * every module's event handlers listen: identity, catalog, competition, scheduling, finance and
 * communications records are created once, and nothing reaches a customer or a provider.
 */
describe('SPK-AT-024: a level-4 snapshot imported twice (assembled application)', () => {
  it('the second import matches every row; no notice, charge or provider call results from either import even after every follow-up runs', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2027-01-16T17:00:00Z' });
    try {
      const operator = await staff(t, ['general_manager']);
      const competitionId = await createCompetitionFixture(t, { name: 'Legacy Adult League' });
      const ruleSetId = (await createRuleSetFixture(t, {})).id;
      const pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Pitch 1',
      });
      // §5.6: the legacy system is the writer of every category imported (the operator says so).
      for (const recordCategory of CATEGORIES) {
        await ok(
          post(t, '/v1/authority-assignments', operator.header, {
            recordCategory,
            authoritativeSystem: 'legacy',
            reason: 'The legacy system keeps this record category until cutover',
          }),
          201,
        );
      }
      const rows: StagedRow[] = [
        stagedPerson('P-PARENT', {
          givenName: 'Pat',
          familyName: 'Parent',
          email: 'pat@example.test',
        }),
        stagedPerson('P-CHILD', {
          givenName: 'Kim',
          familyName: 'Parent',
          kind: 'child',
          dateOfBirth: '2015-05-05',
        }),
        stagedPerson('P-CAP', { givenName: 'Cara', familyName: 'Captain' }),
        stagedHousehold('H-1', 'Parent household', ['P-PARENT', 'P-CHILD']),
        stagedRelationship('R-1', { actorExternalId: 'P-PARENT', subjectExternalId: 'P-CHILD' }),
        {
          entityType: 'program',
          externalId: 'PRG-1',
          payload: { name: 'Imported Youth Program', activityType: 'soccer' },
        },
        stagedObligation('OB-1', { debtorExternalId: 'P-PARENT', amountMinor: 4_500 }),
        stagedCredit('CR-1', { ownerExternalId: 'P-PARENT', amountMinor: 1_000 }),
        stagedSeason('S-1', { competitionId, ruleSetId, name: 'Winter 2027' }),
        stagedTeam('T-1', { name: 'Imported Rovers', primaryColor: 'green' }),
        stagedTeamEntry('E-1', {
          teamExternalId: 'T-1',
          seasonExternalId: 'S-1',
          captainExternalId: 'P-CAP',
        }),
        stagedRoster('RO-1', {
          entryExternalId: 'E-1',
          personExternalId: 'P-CAP',
          jerseyNumber: 10,
        }),
        stagedEvent('EV-1', {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at('2027-02-06', '10:00'),
          scheduledEnd: at('2027-02-06', '11:00'),
          title: 'Rovers v Strikers',
        }),
        stagedPreferences('CP-1', {
          personExternalId: 'P-PARENT',
          preferences: [{ channel: 'email', category: 'promotional', enabled: false }],
        }),
      ];
      const importOnce = async (actor: Actor) => {
        const staged = await ok<{ id: string }>(
          post(t, '/v1/import-batches', actor.header, {
            sourceSystem: 'legacy-registration',
            snapshotTakenAt: '2027-01-16T08:00:00.000Z',
            transformationVersion: 'staging-v1',
            extraction: { tool: 'export-script', extractedBy: 'migration owner' },
            controlTotals: controlTotalsFor(rows),
            rows,
          }),
          201,
        );
        const validated = await ok<{ revision: number; exceptions: { open: number } }>(
          post(t, `/v1/import-batches/${staged.id}/validate`, actor.header, {}),
        );
        expect(validated.exceptions.open, JSON.stringify(validated)).toBe(0);
        await ok(
          post(t, `/v1/import-batches/${staged.id}/review`, actor.header, {
            expectedRevision: validated.revision,
          }),
        );
        const applied = await ok<{ status: string; outcomeCounts: Record<string, number> }>(
          post(t, `/v1/import-batches/${staged.id}/apply`, actor.header, {}),
        );
        expect(applied.status).toBe('applied');
        // Every follow-up any module subscribes to runs before anything is counted.
        await drain(t);
        return applied.outcomeCounts;
      };
      const count = async (table: string) =>
        Number(
          (await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(t.db))
            .rows[0]!.n,
        );
      const tables = [
        'persons',
        'households',
        'programs',
        'seasons',
        'teams',
        'team_entries',
        'roster_memberships',
        'events',
        'obligations',
        'credits',
        'communication_preferences',
        'notifications',
        'payment_attempts',
        'journals',
        'reservations',
      ] as const;
      const snapshot = async () =>
        Object.fromEntries(await Promise.all(tables.map(async (n) => [n, await count(n)])));
      const before = await snapshot();

      const first = await importOnce(operator);
      expect(first).toMatchObject({ created: rows.length, exception: 0 });
      const afterFirst = await snapshot();
      expect({
        persons: afterFirst.persons - before.persons,
        seasons: afterFirst.seasons - before.seasons,
        team_entries: afterFirst.team_entries - before.team_entries,
        events: afterFirst.events - before.events,
        obligations: afterFirst.obligations - before.obligations,
        credits: afterFirst.credits - before.credits,
      }).toEqual({
        persons: 3,
        seasons: 1,
        team_entries: 1,
        events: 1,
        obligations: 1,
        credits: 1,
      });
      // §5.4: the import sends nothing and charges nothing; its event is a draft holding no space.
      expect(afterFirst.notifications).toBe(before.notifications);
      expect(afterFirst.payment_attempts).toBe(before.payment_attempts);
      expect(afterFirst.reservations).toBe(before.reservations);

      t.clock.advance(60_000);
      const second = await importOnce(operator);
      expect(second).toMatchObject({ created: 0, matched: rows.length, exception: 0 });
      expect(await snapshot()).toEqual(afterFirst);
    } finally {
      await t.close();
    }
  });
});
