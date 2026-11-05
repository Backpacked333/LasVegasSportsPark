import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  addRosterMemberFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../modules/competition';
import { createPersonFixture, createRelationshipFixture } from '../../modules/identity';
import { at, seedPitchWithHalves } from '../../modules/scheduling';
import { adult, drain, get, journeyApp, ok, post, staff, type Actor } from './support';

/**
 * SPK-CAP-001 / SPK-CAP-003 (CMP-14), SPK-COMMS-002, SPK-SCHED-008, across competition (fixtures,
 * availability), scheduling (the fixture's event at the pitch), identity (who answers for a
 * child, who receives the child's messages) and communications (the protected notice), on the
 * assembled application.
 */
describe('SPK-CAP-001: a captain asks the team who can play (assembled application)', () => {
  it('a scheduled fixture shows on the team; the request reaches only players without an answer (a child through the guardian who receives messages); a reminder reaches fewer; requests close at kickoff', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2027-01-10T17:00:00Z' });
    try {
      const lm = await staff(t, ['league_manager']);
      const pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Pitch 1',
      });
      const season = await createSeasonFixture(t, {
        status: 'active',
        name: 'Winter league',
        startsOn: '2027-01-10',
        endsOn: '2027-04-10',
      });
      const team = async (name: string) => {
        const captain = await adult(t);
        const player = await adult(t);
        const entry = await createTeamEntryFixture(t, {
          seasonId: season.seasonId,
          captainPersonId: captain.personId,
          teamName: name,
        });
        for (const [personId, jerseyNumber] of [
          [captain.personId, 1],
          [player.personId, 9],
        ] as const) {
          await addRosterMemberFixture(t, {
            teamEntryId: entry.teamEntryId,
            personId,
            jerseyNumber,
          });
        }
        return { entryId: entry.teamEntryId, captain, player };
      };
      const lions = await team('Lions');
      const tigers = await team('Tigers');
      // A child on the Lions: one guardian answers and receives messages, a relative only pays.
      const kid = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2012-03-21' });
      await addRosterMemberFixture(t, {
        teamEntryId: lions.entryId,
        personId: kid,
        jerseyNumber: 7,
      });
      const guardian = await adult(t);
      await createRelationshipFixture(t, {
        actorPersonId: guardian.personId,
        subjectPersonId: kid,
        permissions: ['view', 'register', 'receive_messages'],
      });
      const payer: Actor = await adult(t);
      await createRelationshipFixture(t, {
        actorPersonId: payer.personId,
        subjectPersonId: kid,
        kind: 'caregiver',
        permissions: ['pay'],
      });

      // The league schedules the fixture at the pitch; the team sees it with its local time.
      const scheduled = await ok<{ fixture: { id: string } }>(
        post(t, '/v1/fixtures', lm.header, {
          seasonId: season.seasonId,
          homeEntryId: lions.entryId,
          awayEntryId: tigers.entryId,
          schedule: {
            facilityId: t.facilityId,
            resourceIds: [pitch.pitchId],
            scheduledStart: at('2027-01-16', '18:00'),
            scheduledEnd: at('2027-01-16', '19:00'),
          },
        }),
        201,
      );
      const fixtureId = scheduled.fixture.id;
      await drain(t);
      const fixture = await ok<{ venue: { timezone: string } | null }>(
        get(t, `/v1/fixtures/${fixtureId}`, lions.player.header),
      );
      expect(fixture.venue).toMatchObject({ timezone: 'America/Los_Angeles' });

      // The player has already answered; the captain asks the rest.
      await ok(
        post(t, `/v1/fixtures/${fixtureId}/availability`, lions.player.header, {
          state: 'available',
        }),
      );
      const requested = await ok<{ id: string; recipientCount: number }>(
        post(t, `/v1/fixtures/${fixtureId}/availability-requests`, lions.captain.header, {
          teamEntryId: lions.entryId,
          message: 'Who can make Saturday?',
        }),
        201,
      );
      expect(requested.recipientCount).toBe(2); // the captain and the child
      await drain(t);
      const asked = async (actor: Actor) =>
        (
          await ok<{ items: Array<{ kind: string }> }>(
            get(t, '/v1/me/inbox?limit=50', actor.header),
          )
        ).items.filter((i) => i.kind === 'availability_request').length;
      expect(await asked(lions.captain)).toBe(1);
      expect(await asked(guardian)).toBe(1);
      expect(await asked(lions.player)).toBe(0);
      expect(await asked(payer)).toBe(0);
      expect(await asked(tigers.captain)).toBe(0);

      // The guardian answers for the child; a reminder an hour later reaches only the captain.
      await ok(
        post(t, `/v1/fixtures/${fixtureId}/availability`, guardian.header, {
          state: 'tentative',
          personId: kid,
        }),
      );
      t.clock.advance(3_600_000);
      const reminder = await ok<{ recipientCount: number }>(
        post(t, `/v1/fixtures/${fixtureId}/availability-requests`, lions.captain.header, {
          teamEntryId: lions.entryId,
        }),
        201,
      );
      expect(reminder.recipientCount).toBe(1);
      await drain(t);
      expect(await asked(lions.captain)).toBe(2);
      expect(await asked(guardian)).toBe(1);
      // A player cannot ask, and the other side's captain cannot ask this side.
      for (const actor of [lions.player, tigers.captain]) {
        const refused = await post(
          t,
          `/v1/fixtures/${fixtureId}/availability-requests`,
          actor.header,
          {
            teamEntryId: lions.entryId,
          },
        );
        expect(refused.status).toBe(404);
      }

      // At kickoff answers and requests close.
      t.clock.set(new Date(at('2027-01-16', '18:00')));
      const late = await post(
        t,
        `/v1/fixtures/${fixtureId}/availability-requests`,
        lions.captain.header,
        {
          teamEntryId: lions.entryId,
        },
      );
      expect(late.status).toBe(409);
      expect(late.body.details).toMatchObject({ code: 'AVAILABILITY_CLOSED' });
    } finally {
      await t.close();
    }
  });
});
