import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createOfferingFixture,
  createOfferingSessionFixture,
  createProgramFixture,
} from '../../modules/catalog';
import { createEnrollmentFixture } from '../../modules/enrollment';
import { createRelationshipFixture } from '../../modules/identity';
import { createAssignmentFixture } from '../../modules/workforce';
import {
  adult,
  child,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  staff,
  type Actor,
} from './support';

const STAFF_NOTE = 'Private: struggles with focus after school';

/**
 * SPK-YOUTH-005 / SPK-YOUTH-006 (capability youth_progression, DEC-016; content DEC-003, DEC-054),
 * across enrollment (assessments, recommendations, registration options), workforce (the coach's
 * accepted assignment is what lets them author), catalog (the next offering), identity (who may
 * view the child) and communications (the family notice), on the assembled application.
 */
describe('SPK-YOUTH-005: youth progression from the coach to the family (assembled application)', () => {
  it('an assigned coach authors, another program manager publishes, the family reads the feedback and the shared recommendation without any staff note; a payer without view reads nothing; nothing is reserved', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2026-11-10T17:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const author = await staff(t, ['program_manager']);
      const reviewer = await staff(t, ['program_manager']);
      const coach = await staff(t, ['coach']);
      const outsider = await staff(t, ['coach']);
      const guardian = await adult(t);
      const kid = await child(t, [guardian], ['view', 'register', 'receive_messages']);
      const payer: Actor = await adult(t);
      await createRelationshipFixture(t, {
        actorPersonId: payer.personId,
        subjectPersonId: kid,
        kind: 'caregiver',
        permissions: ['pay'],
      });
      const programId = await createProgramFixture(t, {
        ageBand: { minAgeYears: 5, maxAgeYears: 12 },
      });
      const current = await createOfferingFixture(t, {
        responsibleManagerPersonId: author.personId,
        programId,
        kind: 'term',
        basePriceMinor: 0,
      });
      const next = await createOfferingFixture(t, {
        responsibleManagerPersonId: author.personId,
        programId,
        kind: 'term',
        basePriceMinor: 0,
      });
      await createEnrollmentFixture(t, {
        offeringId: current.offeringId,
        participantPersonId: kid,
        status: 'confirmed',
      });
      const sessionId = await createOfferingSessionFixture(t, {
        offeringId: current.offeringId,
        scheduledStart: new Date('2026-11-12T01:00:00Z'),
        scheduledEnd: new Date('2026-11-12T02:00:00Z'),
      });
      await createAssignmentFixture(t, {
        targetType: 'session',
        targetId: sessionId,
        offeringId: current.offeringId,
        personId: coach.personId,
        scheduledStart: '2026-11-12T01:00:00Z',
        scheduledEnd: '2026-11-12T02:00:00Z',
        status: 'accepted',
        kind: 'coach',
        role: 'head_coach',
      });

      // DEC-016: off until the administrator enables it.
      const templateBody = {
        programId,
        name: 'Ball skills',
        skillAreas: [
          { key: 'dribbling', label: 'Dribbling' },
          { key: 'passing', label: 'Passing' },
        ],
        scale: { kind: 'ordinal', levels: ['Emerging', 'Developing', 'Secure'] },
      };
      const off = await post(t, '/v1/assessment-templates', author.header, templateBody);
      expect(off.status).toBe(403);
      expect(off.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED' });
      await enableCapability(t, admin, 'youth_progression', 'DEC-016');
      const template = await ok<{ id: string; revision: number }>(
        post(t, '/v1/assessment-templates', author.header, templateBody),
        201,
      );
      await ok(
        post(t, `/v1/assessment-templates/${template.id}/approve`, author.header, {
          expectedRevision: template.revision,
        }),
      );

      // Only staff of the offering author: the assigned coach may, another coach may not.
      const draftBody = {
        templateId: template.id,
        participantPersonId: kid,
        offeringId: current.offeringId,
        skillAreaKey: 'dribbling',
        observedOn: '2026-11-12',
        scaleValue: 2,
        visibility: 'family',
        comments: 'Great first touch',
        staffNote: STAFF_NOTE,
      };
      const notAssigned = await post(t, '/v1/assessments', outsider.header, draftBody);
      expect(notAssigned.status).toBeGreaterThanOrEqual(403);
      const drafted = await ok<{ id: string; revision: number }>(
        post(t, '/v1/assessments', coach.header, draftBody),
        201,
      );
      const submitted = await ok<{ id: string; revision: number }>(
        post(t, `/v1/assessments/${drafted.id}/submit`, coach.header, {
          expectedRevision: drafted.revision,
        }),
      );
      const feedback = async (actor: Actor) =>
        ok<{ assessments: Array<Record<string, unknown>>; recommendations: Array<{ id: string }> }>(
          get(t, '/v1/me/youth-feedback', actor.header),
        );
      expect((await feedback(guardian)).assessments).toEqual([]);
      await ok(
        post(t, `/v1/assessments/${submitted.id}/review`, reviewer.header, {
          decision: 'approve',
          expectedRevision: submitted.revision,
        }),
      );
      await drain(t);

      // The family reads it, and is told once, without the staff note anywhere.
      const visible = await feedback(guardian);
      expect(visible.assessments).toEqual([
        expect.objectContaining({
          id: submitted.id,
          comments: 'Great first touch',
          scaleLabel: 'Developing',
        }),
      ]);
      const inbox = await ok<{ items: Array<{ kind: string; title: string; body?: string }> }>(
        get(t, '/v1/me/inbox?limit=50', guardian.header),
      );
      expect(inbox.items.filter((i) => i.kind === 'youth_feedback')).toHaveLength(1);
      expect(JSON.stringify(visible)).not.toContain(STAFF_NOTE);
      expect(JSON.stringify(inbox)).not.toContain(STAFF_NOTE);
      // A payer without view over the child learns nothing.
      const payerView = await get(t, '/v1/me/youth-feedback', payer.header);
      expect(JSON.stringify(payerView.body)).not.toContain(submitted.id);
      expect(JSON.stringify(payerView.body)).not.toContain('Great first touch');

      // SPK-YOUTH-006: a recommendation is shared once and reserves nothing.
      const holds = async () => (await t.db.selectFrom('holds').select('id').execute()).length;
      const holdsBefore = await holds();
      const recommendation = await ok<{ id: string; revision: number; eligibility: unknown }>(
        post(t, '/v1/progression-recommendations', coach.header, {
          participantPersonId: kid,
          fromOfferingId: current.offeringId,
          recommendedOfferingId: next.offeringId,
          suitability: 'Ready for the next level of ball work.',
        }),
        201,
      );
      expect(recommendation.eligibility).toMatchObject({ eligible: expect.any(Boolean) });
      expect((await feedback(guardian)).recommendations).toEqual([]);
      await ok(
        post(t, `/v1/progression-recommendations/${recommendation.id}/share`, coach.header, {
          expectedRevision: recommendation.revision,
        }),
      );
      await drain(t);
      expect((await feedback(guardian)).recommendations.map((r) => r.id)).toEqual([
        recommendation.id,
      ]);
      expect(await holds()).toBe(holdsBefore);
      // The family registers through the normal options, not through the recommendation.
      const options = await ok<{ participants: Array<{ personId: string }> }>(
        get(
          t,
          `/v1/offerings/${next.offeringId}/registration-options?participantPersonIds=${kid}`,
          guardian.header,
        ),
      );
      expect(options.participants.map((p) => p.personId)).toEqual([kid]);
    } finally {
      await t.close();
    }
  });
});
