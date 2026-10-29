import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import { createOfferingFixture } from '../../modules/catalog';
import {
  addRosterMemberFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../modules/competition';
import { createEnrollmentFixture } from '../../modules/enrollment';
import { createObligationFixture } from '../../modules/finance';
import { createPersonFixture } from '../../modules/identity';
import { at, createScheduledEvent, EventsService, seedResource } from '../../modules/scheduling';
import { createAssignmentFixture } from '../../modules/workforce';
import { adult, drain, get, journeyApp, ok, post, staff } from './support';

/**
 * SPK-IAM-007 (§4.10, §4.14): one merge of a duplicate person record, decided by a system
 * administrator through identity's HTTP command, reaches every module that holds records of
 * people, on the assembled application. Nothing is rewritten: each module either reads through
 * identity's merge links (the survivor sees the merged record's history) or raises one
 * exception for a human when the merge leaves two of something that should exist once.
 */
describe('SPK-IAM-007: person merge across modules (assembled application)', () => {
  it('a merge re-points reads to the survivor, raises one exception per duplicated entitlement, pass, roster row and overlapping assignment, and rewrites nothing', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2027-01-16T17:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const support = await staff(t, ['support_operator']);
      const pm = await staff(t, ['program_manager']);
      const desk = await staff(t, ['front_desk']);
      const lm = await staff(t, ['league_manager']);
      const scheduler = await staff(t, ['scheduler']);
      const survivor = await adult(t);
      const duplicate = await adult(t);

      // Enrollment: both records hold the same entitlement; the duplicate also opened a basket.
      const offering = await createOfferingFixture(t, { responsibleManagerPersonId: pm.personId });
      const equivalenceKey = `offering:${offering.offeringId}`;
      const kept = await createEnrollmentFixture(t, {
        offeringId: offering.offeringId,
        participantPersonId: survivor.personId,
        equivalenceKey,
      });
      const second = await createEnrollmentFixture(t, {
        offeringId: offering.offeringId,
        participantPersonId: duplicate.personId,
        equivalenceKey,
      });
      const basket = await ok<{ id: string }>(
        post(t, '/v1/baskets', duplicate.header, { ownerPersonId: duplicate.personId }),
        201,
      );
      // Entry: each record holds an active pass, and the duplicate has a visit.
      const passes: string[] = [];
      for (const holder of [survivor, duplicate]) {
        const issued = await ok<{ pass: { id: string } }>(
          post(t, '/v1/passes', holder.header, {
            holder: { kind: 'person', personId: holder.personId },
          }),
          201,
        );
        passes.push(issued.pass.id);
      }
      const visit = await ok<{ visits: Array<{ id: string }> }>(
        post(t, '/v1/visits', desk.header, {
          facilityId: t.facilityId,
          arrivals: [{ personId: duplicate.personId, visitorCategory: 'guardian' }],
        }),
        201,
      );
      // Competition: both records are on one team entry's roster.
      const season = await createSeasonFixture(t);
      const captain = await createPersonFixture(t, { kind: 'adult' });
      const entry = await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain,
      });
      await addRosterMemberFixture(t, {
        teamEntryId: entry.teamEntryId,
        personId: survivor.personId,
      });
      await addRosterMemberFixture(t, {
        teamEntryId: entry.teamEntryId,
        personId: duplicate.personId,
      });
      // Workforce: both records coach overlapping practices on two fields.
      const events = t.app.get(EventsService, { strict: false });
      const assignment = async (personId: string, name: string, from: string, to: string) => {
        const field = (
          await seedResource(t.db, {
            organizationId: t.organizationId,
            facilityId: t.facilityId,
            name,
          })
        ).resourceId;
        const event = await createScheduledEvent(events, {
          organizationId: t.organizationId,
          facilityId: t.facilityId,
          resourceIds: [field],
          start: at('2027-01-23', from),
          end: at('2027-01-23', to),
          kind: 'practice',
          title: `Practice on ${name}`,
        });
        return createAssignmentFixture(t, {
          targetType: 'event',
          targetId: event.id,
          personId,
          kind: 'coach',
          role: 'head_coach',
          status: 'accepted',
          scheduledStart: at('2027-01-23', from),
          scheduledEnd: at('2027-01-23', to),
        });
      };
      const coaching = [
        await assignment(survivor.personId, 'North field', '09:00', '10:00'),
        await assignment(duplicate.personId, 'South field', '09:30', '10:30'),
      ];
      // Communications, support and finance: a message, a case and an obligation of the duplicate.
      const notice = await ok<{ id: string }>(
        post(t, '/v1/notifications', support.header, {
          kind: 'payment_attention',
          title: 'Balance reminder',
          body: 'A balance is open on your account.',
          audience: { personIds: [duplicate.personId] },
        }),
        201,
      );
      await ok(post(t, `/v1/notifications/${notice.id}/send`, support.header, {}));
      const supportCase = await ok<{ id: string }>(
        post(t, '/v1/cases', support.header, {
          category: 'other',
          title: 'Two records for one parent',
          subjectPersonId: duplicate.personId,
        }),
        201,
      );
      await createObligationFixture(t, {
        debtorPersonId: duplicate.personId,
        amountMinor: 700,
        description: 'Locker rental',
      });
      await drain(t);
      const rowsBefore = {
        enrollments: await t.db
          .selectFrom('enrollments')
          .select(['id', 'participant_person_id', 'status'])
          .where('id', 'in', [kept, second])
          .orderBy('id')
          .execute(),
        passes: await t.db
          .selectFrom('passes')
          .select(['id', 'holder_person_id', 'status'])
          .where('id', 'in', passes)
          .orderBy('id')
          .execute(),
        roster: await t.db
          .selectFrom('roster_memberships')
          .select(['id', 'person_id', 'status'])
          .where('team_entry_id', '=', entry.teamEntryId)
          .orderBy('id')
          .execute(),
        assignments: await t.db
          .selectFrom('assignments')
          .select(['id', 'person_id', 'status'])
          .where('id', 'in', coaching)
          .orderBy('id')
          .execute(),
      };

      // Support flags the pair; only a system administrator merges it.
      const flagged = await ok<{ id: string }>(
        post(t, '/v1/duplicate-candidates', support.header, {
          personAId: survivor.personId,
          personBId: duplicate.personId,
          reasons: ['same name and date of birth'],
          score: 90,
        }),
        201,
      );
      const mergeBody = {
        survivorPersonId: survivor.personId,
        reason: 'Confirmed with the parent at the desk',
      };
      expect(
        (await post(t, `/v1/duplicate-candidates/${flagged.id}/merge`, support.header, mergeBody))
          .status,
      ).toBe(403);
      const merge = await ok<{ id: string; mergedPersonId: string }>(
        post(t, `/v1/duplicate-candidates/${flagged.id}/merge`, admin.header, mergeBody),
        201,
      );
      expect(merge.mergedPersonId).toBe(duplicate.personId);
      await drain(t);

      // One exception per duplicated thing, each in the owning team's queue.
      const open = async (reader: typeof pm, queue: string) =>
        (
          await ok<{
            items: Array<{
              category: string;
              ownerQueue: string;
              details: Record<string, unknown>;
            }>;
          }>(get(t, `/v1/exceptions?queue=${queue}&status=open&limit=100`, reader.header))
        ).items;
      expect(
        (await open(pm, 'program_manager')).filter(
          (e) => e.category === 'enrollment.merged_duplicate_entitlement',
        ),
      ).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ survivorRecordId: kept, mergedRecordId: second }),
        }),
      ]);
      expect(
        (await open(desk, 'front_desk')).filter(
          (e) => e.category === 'entry.merged_duplicate_pass',
        ),
      ).toHaveLength(1);
      expect(
        (await open(lm, 'league_manager')).filter(
          (e) => e.category === 'competition.merged_roster_duplicate',
        ),
      ).toHaveLength(1);
      expect(
        (await open(scheduler, 'scheduler')).filter(
          (e) => e.category === 'workforce.merged_person_overlap',
        ),
      ).toHaveLength(1);
      // Nothing was canceled, revoked, removed or reassigned.
      expect({
        enrollments: await t.db
          .selectFrom('enrollments')
          .select(['id', 'participant_person_id', 'status'])
          .where('id', 'in', [kept, second])
          .orderBy('id')
          .execute(),
        passes: await t.db
          .selectFrom('passes')
          .select(['id', 'holder_person_id', 'status'])
          .where('id', 'in', passes)
          .orderBy('id')
          .execute(),
        roster: await t.db
          .selectFrom('roster_memberships')
          .select(['id', 'person_id', 'status'])
          .where('team_entry_id', '=', entry.teamEntryId)
          .orderBy('id')
          .execute(),
        assignments: await t.db
          .selectFrom('assignments')
          .select(['id', 'person_id', 'status'])
          .where('id', 'in', coaching)
          .orderBy('id')
          .execute(),
      }).toEqual(rowsBefore);

      // The survivor reads the merged record's history as their own.
      const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);
      expect(ids(await ok(get(t, '/v1/me/baskets', survivor.header)))).toContain(basket.id);
      const myPasses = await ok<Array<{ id: string }>>(get(t, '/v1/me/passes', survivor.header));
      expect(myPasses.map((p) => p.id).sort()).toEqual([...passes].sort());
      const inbox = await ok<{ items: Array<{ notificationId: string }> }>(
        get(t, '/v1/me/inbox?limit=50', survivor.header),
      );
      expect(inbox.items.map((i) => i.notificationId)).toContain(notice.id);
      const visits = await ok<{ items: Array<{ id: string }> }>(
        get(t, `/v1/visits?facilityId=${t.facilityId}&personId=${survivor.personId}`, desk.header),
      );
      expect(ids(visits)).toContain(visit.visits[0]!.id);
      const timeline = await ok<{ entries: Array<{ record: { id: string }; title: string }> }>(
        get(t, `/v1/customers/${survivor.personId}/timeline?limit=200`, support.header),
      );
      expect(timeline.entries.map((e) => e.record.id)).toEqual(
        expect.arrayContaining([notice.id, supportCase.id]),
      );
      expect(timeline.entries.some((e) => e.title === 'Locker rental')).toBe(true);
      const cases = await ok<{ items: Array<{ id: string }> }>(
        get(t, `/v1/cases?subjectPersonId=${survivor.personId}`, support.header),
      );
      expect(ids(cases)).toContain(supportCase.id);
      // The merged record's own login no longer works.
      expect((await get(t, '/v1/me/baskets', duplicate.header)).status).toBeGreaterThanOrEqual(400);
    } finally {
      await t.close();
    }
  });
});
