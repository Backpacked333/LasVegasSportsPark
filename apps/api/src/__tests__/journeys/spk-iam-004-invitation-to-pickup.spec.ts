import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
} from '../../modules/catalog';
import { createEnrollmentFixture } from '../../modules/enrollment';
import { createRelationshipFixture } from '../../modules/identity';
import { at } from '../../modules/scheduling';
import { createAssignmentFixture } from '../../modules/workforce';
import { adult, get, journeyApp, ok, post, staff, together } from './support';

/** Saturday 2027-01-16, 09:00 in Los Angeles (the test facility's zone). */
const CLOCK_START = '2027-01-16T17:00:00Z';
const TODAY = '2027-01-16';

/**
 * SPK-IAM-004 (invitations), SPK-IAM-006 (revocation takes effect at the next check) and
 * SPK-ENTRY-007 (pickup), across identity (invitation, grants), entry (pass, collector check,
 * release), enrollment and workforce (the supervised session and its coach), on the assembled
 * application. Two devices accepting at once is a race the database settles (it overlaps under
 * TEST_DATABASE_URL).
 */
describe('SPK-IAM-004: a parent invites a sitter who may then collect (assembled application)', () => {
  it('the sitter reads the invitation before accepting; two accepts at once grant once; the sitter collects through the online check; a revoked grant stops the next pickup', async () => {
    const t: TestApp = await journeyApp({ clockStart: CLOCK_START });
    try {
      const pm = await staff(t, ['program_manager']);
      const coach = await staff(t, ['coach']);
      const parent = await adult(t);
      // The parent adds the child's record (self-service), so the parent is its creator-guardian.
      const kid = (
        await ok<{ id: string }>(
          post(t, '/v1/people', parent.header, {
            kind: 'child',
            givenName: 'Ava',
            familyName: 'Parent',
            dateOfBirth: '2017-04-02',
          }),
          201,
        )
      ).id;
      // Creating the record confers nothing (SPK-IAM-001); the desk verifies the guardianship.
      await createRelationshipFixture(t, { actorPersonId: parent.personId, subjectPersonId: kid });
      const sitter = await adult(t);
      const offering = await createOfferingFixture(t, { responsibleManagerPersonId: pm.personId });
      const start = at(TODAY, '10:00');
      const end = at(TODAY, '11:00');
      const sessionId = await createOfferingSessionFixture(t, {
        offeringId: offering.offeringId,
        scheduledStart: new Date(start),
        scheduledEnd: new Date(end),
      });
      await createEnrollmentFixture(t, {
        offeringId: offering.offeringId,
        participantPersonId: kid,
        status: 'confirmed',
      });
      await createAcknowledgmentFixture(t, {
        subjectPersonId: kid,
        policyVersionId: offering.formPolicyVersionId,
        signedByPersonId: parent.personId,
      });
      await createAssignmentFixture(t, {
        targetType: 'session',
        targetId: sessionId,
        offeringId: offering.offeringId,
        personId: coach.personId,
        kind: 'coach',
        status: 'accepted',
        scheduledStart: start,
        scheduledEnd: end,
      });
      const activity = { type: 'session', offeringId: offering.offeringId, sessionId };

      // The parent invites the sitter to view and collect the child for a day.
      const invitation = await ok<{ id: string; token: string }>(
        post(t, '/v1/invitations', parent.header, {
          recipientPersonId: sitter.personId,
          scope: { type: 'person', personId: kid },
          relationshipKind: 'delegate',
          requestedPermissions: ['view', 'collect'],
          expiresInHours: 24,
        }),
        201,
      );
      // The sitter reads who sent it, what it covers and when it expires, before accepting.
      const mine = await ok<{ items: Array<Record<string, unknown>> }>(
        get(t, '/v1/me/invitations', sitter.header),
      );
      expect(mine.items).toEqual([
        expect.objectContaining({
          id: invitation.id,
          requestedPermissions: ['view', 'collect'],
          status: 'pending',
        }),
      ]);
      const stranger = await adult(t);
      expect(
        (await ok<{ items: unknown[] }>(get(t, '/v1/me/invitations', stranger.header))).items,
      ).toEqual([]);

      // Two devices accept at once: one wins, the other is told it already happened.
      const accept = () =>
        post(t, `/v1/invitations/${invitation.id}/accept`, sitter.header, {
          token: invitation.token,
        });
      const [a, b] = await together(accept, accept);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const won = (a.status === 200 ? a : b).body as {
        grants: Array<{ id: string; permission: string }>;
      };
      expect(won.grants.map((g) => g.permission).sort()).toEqual(['collect', 'view']);
      const grants = await t.db
        .selectFrom('access_grants')
        .select(['id', 'permission'])
        .where('actor_person_id', '=', sitter.personId)
        .where('revoked_at', 'is', null)
        .execute();
      expect(grants.map((g) => g.permission).sort()).toEqual(['collect', 'view']);

      // At pickup the coach checks the sitter's pass online and releases the child.
      const pass = await ok<{ reference: string }>(
        post(t, '/v1/passes', sitter.header, {
          holder: { kind: 'person', personId: sitter.personId },
        }),
        201,
      );
      const check = () =>
        ok<{ mayCollect: boolean; collector: { personId: string } | null }>(
          t.http
            .post('/v1/releases/collector-checks')
            .set(coach.header)
            .send({ activity, participantPersonId: kid, passReference: pass.reference }),
        );
      expect(await check()).toMatchObject({
        mayCollect: true,
        collector: { personId: sitter.personId },
      });
      const released = await ok<{ release: Record<string, unknown> }>(
        post(t, '/v1/releases', coach.header, {
          facilityId: t.facilityId,
          childPersonId: kid,
          collector: { personId: sitter.personId },
          activity,
          recordDeparture: false,
        }),
        201,
      );
      expect(released.release).toMatchObject({
        verificationOutcome: 'verified',
        outcome: 'released',
      });

      // The parent revokes the sitter's collect grant: the next check names nobody and the next
      // release is denied.
      const collect = won.grants.find((g) => g.permission === 'collect')!;
      await ok(
        post(t, `/v1/access-grants/${collect.id}/revoke`, parent.header, {
          reason: 'The sitter no longer collects',
        }),
      );
      expect(await check()).toMatchObject({ mayCollect: false, collector: null });
      const denied = await ok<{ release: Record<string, unknown> }>(
        post(t, '/v1/releases', coach.header, {
          facilityId: t.facilityId,
          childPersonId: kid,
          collector: { personId: sitter.personId },
          activity,
          recordDeparture: false,
        }),
        201,
      );
      expect(denied.release).toMatchObject({
        verificationOutcome: 'denied',
        outcome: 'not_released',
      });
      // Only collect was revoked: the sitter still views the child.
      expect((await get(t, `/v1/people/${kid}`, sitter.header)).status).toBe(200);
    } finally {
      await t.close();
    }
  });
});
