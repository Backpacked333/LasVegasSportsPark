import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture, createProgramFixture } from '../../catalog';
import { authHeaderForPerson, createStaffMemberFixture } from '../../identity';
import { createAssignmentFixture } from '../../workforce';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import {
  adult,
  child,
  drain,
  enrollmentTestApp,
  offering,
  post,
  rejectsWith,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const STAFF_NOTE = 'Private: struggles with focus after school';

/** ENR-14: youth development records (capability youth_progression; DEC-016, DEC-003, DEC-054). */
describe('youth progression (ENR-14, SPK-YOUTH-005, SPK-YOUTH-006)', () => {
  let t: TestApp;
  let author: Actor;
  let reviewer: Actor;
  let coach: Actor;
  let guardian: Actor;
  let kid: string;
  let setup: OfferingSetup;
  let programId: string;
  let templateId: string;

  beforeAll(async () => {
    t = await enrollmentTestApp({ capabilities: ['youth_progression'] });
    author = await staff(t, ['program_manager']);
    reviewer = await staff(t, ['program_manager']);
    coach = await staff(t, ['coach']);
    guardian = await adult(t);
    kid = await child(t, [guardian], { permissions: ['view', 'register', 'receive_messages'] });
    programId = await createProgramFixture(t, { ageBand: { minAgeYears: 5, maxAgeYears: 12 } });
    setup = await offering(t, { kind: 'term', programId, basePriceMinor: 0 });
    await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      status: 'confirmed',
    });
    // The coach holds an accepted assignment on a session of the offering (WRK-03, IF-34).
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date('2026-11-12T01:00:00Z'),
      scheduledEnd: new Date('2026-11-12T02:00:00Z'),
    });
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: sessionId,
      offeringId: setup.offeringId,
      personId: coach.personId,
      scheduledStart: '2026-11-12T01:00:00Z',
      scheduledEnd: '2026-11-12T02:00:00Z',
      status: 'accepted',
      kind: 'coach',
      role: 'head_coach',
    });
    const template = await post(t, '/v1/assessment-templates', author.header, {
      programId,
      name: 'Ball skills',
      skillAreas: [
        { key: 'dribbling', label: 'Dribbling' },
        { key: 'passing', label: 'Passing' },
      ],
      scale: { kind: 'ordinal', levels: ['Emerging', 'Developing', 'Secure'] },
    });
    expect(template.status, JSON.stringify(template.body)).toBe(201);
    const approved = await post(
      t,
      `/v1/assessment-templates/${template.body.id as string}/approve`,
      author.header,
      { expectedRevision: template.body.revision },
    );
    expect(approved.status).toBe(200);
    templateId = template.body.id as string;
  });
  afterAll(async () => {
    await t.close();
  });

  async function draft(
    actor: Actor,
    visibility: 'family' | 'staff_only',
    extra: Record<string, unknown> = {},
  ) {
    const created = await post(t, '/v1/assessments', actor.header, {
      templateId,
      participantPersonId: kid,
      offeringId: setup.offeringId,
      skillAreaKey: 'dribbling',
      observedOn: '2026-11-12',
      scaleValue: 2,
      visibility,
      comments: visibility === 'family' ? 'Great first touch' : undefined,
      staffNote: STAFF_NOTE,
      ...extra,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const submitted = await post(
      t,
      `/v1/assessments/${created.body.id as string}/submit`,
      actor.header,
      { expectedRevision: created.body.revision },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    return submitted.body as { id: string; revision: number; status: string };
  }

  const feedback = async () => {
    const res = await t.http.get('/v1/me/youth-feedback').set(guardian.header);
    expect(res.status).toBe(200);
    return res.body as {
      assessments: Array<Record<string, unknown>>;
      recommendations: Array<Record<string, unknown>>;
    };
  };

  it('SPK-YOUTH-005: family feedback is visible only after a program manager other than the author approves', async () => {
    const submitted = await draft(coach, 'family');
    expect(submitted.status).toBe('submitted');
    expect((await feedback()).assessments.map((a) => a.id)).not.toContain(submitted.id);
    // A coach does not review; the author never reviews their own.
    const byCoach = await post(t, `/v1/assessments/${submitted.id}/review`, coach.header, {
      decision: 'approve',
      expectedRevision: submitted.revision,
    });
    expect(byCoach.status).toBe(403);
    const own = await draft(author, 'family');
    const self = await post(t, `/v1/assessments/${own.id}/review`, author.header, {
      decision: 'approve',
      expectedRevision: own.revision,
    });
    expect(self.status).toBe(403);
    expect(self.body.details.code).toBe('REVIEWER_IS_AUTHOR');
    // A return needs a reason and sends it back to the author.
    const returned = await post(t, `/v1/assessments/${own.id}/review`, reviewer.header, {
      decision: 'return',
      expectedRevision: own.revision,
    });
    expect(returned.status).toBe(400);
    const approved = await post(t, `/v1/assessments/${submitted.id}/review`, reviewer.header, {
      decision: 'approve',
      expectedRevision: submitted.revision,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('published');
    const visible = (await feedback()).assessments.find((a) => a.id === submitted.id);
    expect(visible).toMatchObject({
      comments: 'Great first touch',
      skillArea: { key: 'dribbling', label: 'Dribbling' },
      scaleValue: 2,
      scaleLabel: 'Developing',
      scaleLevels: 3,
    });
    // Published rows are immutable.
    const edit = await t.http
      .patch(`/v1/assessments/${submitted.id}`)
      .set(coach.header)
      .set('Idempotency-Key', `k-${newId()}`)
      .send({ scaleValue: 3, expectedRevision: approved.body.revision });
    expect(edit.status).toBe(409);
  });

  it('SPK-YOUTH-005: a staff_only note and every staff_note never appear in a family read or notice', async () => {
    const internal = await draft(coach, 'staff_only');
    const recorded = await post(t, `/v1/assessments/${internal.id}/review`, reviewer.header, {
      decision: 'approve',
      note: 'Reviewed with the coach',
      expectedRevision: internal.revision,
    });
    expect(recorded.body.status).toBe('recorded');
    const shared = await draft(coach, 'family', { skillAreaKey: 'passing' });
    const published = await post(t, `/v1/assessments/${shared.id}/review`, reviewer.header, {
      decision: 'approve',
      note: 'Internal review note',
      expectedRevision: shared.revision,
    });
    expect(published.body.status).toBe('published');
    await drain(t);
    const family = await feedback();
    const text = JSON.stringify(family);
    expect(family.assessments.map((a) => a.id)).not.toContain(internal.id);
    expect(family.assessments.map((a) => a.id)).toContain(shared.id);
    expect(text).not.toContain(STAFF_NOTE);
    expect(text).not.toContain('Internal review note');
    expect(text).not.toContain('staffNote');
    const notices = await t.db
      .selectFrom('notifications')
      .select(['kind', 'title', 'body', 'subject_id'])
      .where('kind', '=', 'youth_feedback')
      .execute();
    expect(notices.filter((n) => n.subject_id === shared.id)).toHaveLength(1);
    expect(notices.some((n) => n.subject_id === internal.id)).toBe(false);
    for (const notice of notices) {
      expect(`${notice.title} ${notice.body}`).not.toContain(STAFF_NOTE);
      expect(`${notice.title} ${notice.body}`).not.toContain('Internal review note');
    }
    // Staff see their notes.
    const staffView = await t.http.get(`/v1/participants/${kid}/assessments`).set(reviewer.header);
    expect(staffView.status).toBe(200);
    expect(staffView.body.items.find((a: { id: string }) => a.id === internal.id).staffNote).toBe(
      STAFF_NOTE,
    );
    // Nobody else learns anything.
    const outsider = await staff(t, ['coach']);
    expect(
      (await t.http.get(`/v1/participants/${kid}/assessments`).set(outsider.header)).status,
    ).toBe(404);
    expect(
      (await t.http.get(`/v1/participants/${kid}/assessments`).set(guardian.header)).status,
    ).toBe(404);
  });

  it('§4.10: a program manager at another facility gets the same empty page whether or not the child has assessments elsewhere', async () => {
    await draft(coach, 'staff_only');
    const facilityB = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: facilityB,
        organization_id: t.organizationId,
        slug: `annex-${facilityB.slice(0, 8)}`,
        name: 'Annex',
        timezone: 'America/Los_Angeles',
      })
      .execute();
    const member = await createStaffMemberFixture(t, {
      roles: ['program_manager'],
      facilityIds: [facilityB],
    });
    const managerAtB = { header: await authHeaderForPerson(t, member.personId) };
    const neverAssessed = await child(t, [guardian]);
    // The child assessed only at the main facility, and a child never assessed, read the same.
    const assessedElsewhere = await t.http
      .get(`/v1/participants/${kid}/assessments`)
      .set(managerAtB.header);
    const never = await t.http
      .get(`/v1/participants/${neverAssessed}/assessments`)
      .set(managerAtB.header);
    expect(assessedElsewhere.status).toBe(200);
    expect(never.status).toBe(200);
    expect(assessedElsewhere.body).toEqual({ items: [], nextCursor: null });
    expect(never.body).toEqual(assessedElsewhere.body);
    // The same with an offering filter naming the other facility's offering.
    const filtered = await t.http
      .get(`/v1/participants/${kid}/assessments?offeringId=${setup.offeringId}`)
      .set(managerAtB.header);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual({ items: [], nextCursor: null });
    // A program manager of the main facility still sees them.
    const inScope = await t.http.get(`/v1/participants/${kid}/assessments`).set(reviewer.header);
    expect(inScope.status).toBe(200);
    expect(inScope.body.items.length).toBeGreaterThan(0);
  });

  it("GAPS-TRIAGE-04 / §4.10: the coach of a child's offering reads an empty page before the first assessment; any other coach learns nothing", async () => {
    const newcomer = await child(t, [guardian]);
    await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: newcomer,
      status: 'confirmed',
    });
    const read = (actor: Actor, personId: string, query = '') =>
      t.http.get(`/v1/participants/${personId}/assessments${query}`).set(actor.header);
    // The accepted coach is an authorized reader: an empty page, with or without the offering.
    for (const query of ['', `?offeringId=${setup.offeringId}`]) {
      const res = await read(coach, newcomer, query);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    }
    // Another author's draft changes nothing a coach can see or learn.
    const drafted = await post(t, '/v1/assessments', author.header, {
      templateId,
      participantPersonId: newcomer,
      offeringId: setup.offeringId,
      skillAreaKey: 'passing',
      observedOn: '2026-11-12',
      scaleValue: 1,
      visibility: 'staff_only',
      staffNote: STAFF_NOTE,
    });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect((await read(coach, newcomer)).body).toEqual({ items: [], nextCursor: null });
    // A coach with no assignment on the child's offering gets NOT_FOUND alike for a child with
    // only another author's draft, a child with published assessments, and a person who does not
    // exist; so does the offering's own coach asking about another offering.
    const otherCoach = await staff(t, ['coach']);
    for (const personId of [newcomer, kid, newId()]) {
      expect((await read(otherCoach, personId)).status).toBe(404);
    }
    const elsewhere = await offering(t, { kind: 'term', programId, basePriceMinor: 0 });
    expect((await read(coach, newcomer, `?offeringId=${elsewhere.offeringId}`)).status).toBe(404);
    expect((await read(coach, newId())).status).toBe(404);
    // A program manager in scope sees the draft; the guardian learns nothing.
    const managed = await read(reviewer, newcomer);
    expect(managed.body.items.map((a: { id: string }) => a.id)).toEqual([drafted.body.id]);
    expect((await read(guardian, newcomer)).status).toBe(404);
  });

  it('the database rejects an assessment on an unapproved template, a reviewer equal to the author and a published staff_only assessment', async () => {
    const draftTemplate = newId();
    await t.db
      .insertInto('assessment_templates')
      .values({
        id: draftTemplate,
        organization_id: t.organizationId,
        program_id: programId,
        name: 'Draft template',
        skill_areas: json([{ key: 'dribbling', label: 'Dribbling' }]),
        scale: json({ kind: 'ordinal', levels: ['Low', 'High'] }),
        authored_by: json({ kind: 'system' }),
      })
      .execute();
    const row = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      template_id: templateId,
      participant_person_id: kid,
      offering_id: setup.offeringId,
      skill_area_key: 'dribbling',
      observed_on: '2026-11-12',
      scale_value: 1,
      visibility: 'family' as const,
      author_person_id: coach.personId,
      author: json({ kind: 'system' }),
      ...overrides,
    });
    expect(
      await rejectsWith(
        t.db
          .insertInto('assessments')
          .values(row({ template_id: draftTemplate }) as never)
          .execute(),
      ),
    ).toBe('23514');
    expect(
      await rejectsWith(
        t.db
          .insertInto('assessments')
          .values(row({ scale_value: 9 }) as never)
          .execute(),
      ),
    ).toBe('23514');
    expect(
      await rejectsWith(
        t.db
          .insertInto('assessments')
          .values(
            row({
              status: 'submitted',
              reviewer_person_id: coach.personId,
            }) as never,
          )
          .execute(),
      ),
    ).toBe('23514');
    expect(
      await rejectsWith(
        t.db
          .insertInto('assessments')
          .values(
            row({
              status: 'published',
              visibility: 'staff_only',
              reviewer_person_id: reviewer.personId,
              reviewed_at: t.clock.now(),
            }) as never,
          )
          .execute(),
      ),
    ).toBe('23514');
  });

  it('SPK-YOUTH-006: a recommendation carries the read-only eligibility, is shared once and reserves nothing', async () => {
    const next = await offering(t, { kind: 'term', programId, basePriceMinor: 0 });
    const holdsBefore = await t.db.selectFrom('holds').select('id').execute();
    const created = await post(t, '/v1/progression-recommendations', coach.header, {
      participantPersonId: kid,
      fromOfferingId: setup.offeringId,
      recommendedOfferingId: next.offeringId,
      suitability: 'Ready for the next level of ball work.',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.eligibility).toMatchObject({ eligible: expect.any(Boolean) });
    expect((await feedback()).recommendations.map((r) => r.id)).not.toContain(created.body.id);
    const shared = await post(
      t,
      `/v1/progression-recommendations/${created.body.id as string}/share`,
      coach.header,
      { expectedRevision: created.body.revision },
    );
    expect(shared.status).toBe(200);
    await drain(t);
    expect((await feedback()).recommendations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.id })]),
    );
    expect(await t.db.selectFrom('holds').select('id').execute()).toHaveLength(holdsBefore.length);
    // Disabled: new recommendations are refused; withdrawing still works.
    await t.disableCapability('youth_progression');
    try {
      const refused = await post(t, '/v1/progression-recommendations', coach.header, {
        participantPersonId: kid,
        fromOfferingId: setup.offeringId,
        recommendedProgramId: programId,
        suitability: 'Another idea.',
      });
      expect(refused.status).toBe(403);
      expect(refused.body.details.code).toBe('CAPABILITY_DISABLED');
      const withdrawn = await post(
        t,
        `/v1/progression-recommendations/${created.body.id as string}/withdraw`,
        coach.header,
        { reason: 'Superseded' },
      );
      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
      expect(withdrawn.body.status).toBe('withdrawn');
    } finally {
      await t.enableCapability('youth_progression');
    }
  });

  it('§4.9: a stale expectedRevision on template retirement and recommendation withdrawal answers STALE_REVISION and writes nothing', async () => {
    const template = await post(t, '/v1/assessment-templates', author.header, {
      programId,
      name: 'Agility',
      skillAreas: [{ key: 'balance', label: 'Balance' }],
      scale: { kind: 'ordinal', levels: ['Emerging', 'Secure'] },
    });
    expect(template.status, JSON.stringify(template.body)).toBe(201);
    const templateId = template.body.id as string;
    const approved = await post(
      t,
      `/v1/assessment-templates/${templateId}/approve`,
      author.header,
      {
        expectedRevision: template.body.revision,
      },
    );
    expect(approved.status).toBe(200);
    // Retiring on the pre-approval read is stale.
    const staleRetire = await post(
      t,
      `/v1/assessment-templates/${templateId}/retire`,
      author.header,
      {
        reason: 'No longer used',
        expectedRevision: template.body.revision,
      },
    );
    expect(staleRetire.status).toBe(409);
    expect(staleRetire.body.code).toBe('STALE_REVISION');
    const templateRow = await t.db
      .selectFrom('assessment_templates')
      .select(['status', 'revision'])
      .where('id', '=', templateId)
      .executeTakeFirstOrThrow();
    expect(templateRow).toEqual({ status: 'approved', revision: approved.body.revision });
    const retired = await post(t, `/v1/assessment-templates/${templateId}/retire`, author.header, {
      reason: 'No longer used',
      expectedRevision: approved.body.revision,
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.status).toBe('retired');

    const created = await post(t, '/v1/progression-recommendations', coach.header, {
      participantPersonId: kid,
      fromOfferingId: setup.offeringId,
      recommendedProgramId: programId,
      suitability: 'Try the advanced group.',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const recommendationId = created.body.id as string;
    const shared = await post(
      t,
      `/v1/progression-recommendations/${recommendationId}/share`,
      coach.header,
      { expectedRevision: created.body.revision },
    );
    expect(shared.status).toBe(200);
    // Withdrawing on the pre-share read is stale.
    const staleWithdraw = await post(
      t,
      `/v1/progression-recommendations/${recommendationId}/withdraw`,
      coach.header,
      { reason: 'Changed my mind', expectedRevision: created.body.revision },
    );
    expect(staleWithdraw.status).toBe(409);
    expect(staleWithdraw.body.code).toBe('STALE_REVISION');
    const recommendationRow = await t.db
      .selectFrom('progression_recommendations')
      .select(['status', 'revision', 'withdrawn_reason'])
      .where('id', '=', recommendationId)
      .executeTakeFirstOrThrow();
    expect(recommendationRow).toEqual({
      status: 'shared',
      revision: shared.body.revision,
      withdrawn_reason: null,
    });
    const withdrawn = await post(
      t,
      `/v1/progression-recommendations/${recommendationId}/withdraw`,
      coach.header,
      { reason: 'Changed my mind', expectedRevision: shared.body.revision },
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.status).toBe('withdrawn');
  });

  it('§4.9 / §4.7 invariant 9 / SPK-YOUTH-005: a correction says why, is audited with what it corrects, and replaces the original in the family view', async () => {
    const original = await draft(coach, 'family', { scaleValue: 1, comments: 'Emerging' });
    const published = await post(t, `/v1/assessments/${original.id}/review`, reviewer.header, {
      decision: 'approve',
      expectedRevision: original.revision,
    });
    expect(published.body.status).toBe('published');
    const correction = {
      templateId,
      participantPersonId: kid,
      offeringId: setup.offeringId,
      skillAreaKey: 'dribbling',
      observedOn: '2026-11-12',
      scaleValue: 3,
      visibility: 'family',
      comments: 'Secure',
      correctsAssessmentId: original.id,
    };
    // No reason: refused.
    const unexplained = await post(t, '/v1/assessments', coach.header, correction);
    expect(unexplained.status).toBe(400);
    expect(unexplained.body.code).toBe('VALIDATION_FAILED');
    // With a reason: stored on the row and in the audit with the corrected id.
    const corrected = await draft(coach, 'family', {
      scaleValue: 3,
      comments: 'Secure',
      correctsAssessmentId: original.id,
      reason: 'Scored on the wrong drill',
    });
    const staffView = await t.http.get(`/v1/participants/${kid}/assessments`).set(reviewer.header);
    expect(staffView.body.items.find((a: { id: string }) => a.id === corrected.id)).toMatchObject({
      correctsAssessmentId: original.id,
      correctionReason: 'Scored on the wrong drill',
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['reason', 'details'])
      .where('action', '=', 'enrollment.author_assessment')
      .where('target_id', '=', corrected.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      reason: 'Scored on the wrong drill',
      details: { correctsAssessmentId: original.id },
    });
    // Only one live correction: a second correction of the original is refused.
    const second = await post(t, '/v1/assessments', coach.header, {
      ...correction,
      reason: 'Another idea',
    });
    expect(second.status).toBe(409);
    expect(second.body.details).toMatchObject({
      code: 'ALREADY_CORRECTED',
      correctedByAssessmentId: corrected.id,
    });
    // Until the correction is reviewed the original stands; afterwards only the correction does.
    expect((await feedback()).assessments.map((a) => a.id)).toContain(original.id);
    const approved = await post(t, `/v1/assessments/${corrected.id}/review`, reviewer.header, {
      decision: 'approve',
      expectedRevision: corrected.revision,
    });
    expect(approved.body.status).toBe('published');
    const family = (await feedback()).assessments.map((a) => a.id);
    expect(family).toContain(corrected.id);
    expect(family).not.toContain(original.id);
  });

  /** A coach holding an accepted assignment on a session of `offeringId` (WRK-03, IF-34). */
  async function coachOn(offeringId: string): Promise<Actor> {
    const person = await staff(t, ['coach']);
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId,
      scheduledStart: new Date('2026-11-19T01:00:00Z'),
      scheduledEnd: new Date('2026-11-19T02:00:00Z'),
    });
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: sessionId,
      offeringId,
      personId: person.personId,
      scheduledStart: '2026-11-19T01:00:00Z',
      scheduledEnd: '2026-11-19T02:00:00Z',
      status: 'accepted',
      kind: 'coach',
      role: 'head_coach',
    });
    return person;
  }

  it('§4.7 invariant 9 / SPK-YOUTH-005: a correction keeps its original’s offering, skill area and visibility, so a staff-only row or another offering’s staff never replace family feedback', async () => {
    const original = await draft(coach, 'family', { scaleValue: 2, comments: 'Developing' });
    const published = await post(t, `/v1/assessments/${original.id}/review`, reviewer.header, {
      decision: 'approve',
      expectedRevision: original.revision,
    });
    expect(published.body.status).toBe('published');
    const correction = (overrides: Record<string, unknown> = {}) => ({
      templateId,
      participantPersonId: kid,
      offeringId: setup.offeringId,
      skillAreaKey: 'dribbling',
      observedOn: '2026-11-12',
      scaleValue: 3,
      visibility: 'family',
      comments: 'Secure',
      correctsAssessmentId: original.id,
      reason: 'Scored on the wrong drill',
      ...overrides,
    });
    // A staff-only correction of family feedback, or one of another skill area, is refused.
    for (const overrides of [
      { visibility: 'staff_only', comments: undefined },
      { skillAreaKey: 'passing' },
    ]) {
      const refused = await post(t, '/v1/assessments', coach.header, correction(overrides));
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.details).toMatchObject({ code: 'CORRECTION_MISMATCH' });
    }
    // Staff of another offering the child attends answer as if the assessment did not exist.
    const other = await offering(t, { kind: 'term', programId, basePriceMinor: 0 });
    await createEnrollmentFixture(t, {
      offeringId: other.offeringId,
      participantPersonId: kid,
      status: 'confirmed',
    });
    const otherCoach = await coachOn(other.offeringId);
    const elsewhere = await post(
      t,
      '/v1/assessments',
      otherCoach.header,
      correction({ offeringId: other.offeringId }),
    );
    const unknown = await post(
      t,
      '/v1/assessments',
      otherCoach.header,
      correction({ offeringId: other.offeringId, correctsAssessmentId: newId() }),
    );
    expect(elsewhere.status).toBe(400);
    expect({ code: elsewhere.body.code, message: elsewhere.body.message }).toEqual({
      code: unknown.body.code,
      message: unknown.body.message,
    });
    // The database refuses the same rows from any writer.
    const row = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      template_id: templateId,
      participant_person_id: kid,
      offering_id: setup.offeringId,
      skill_area_key: 'dribbling',
      observed_on: '2026-11-12',
      scale_value: 3,
      visibility: 'family' as const,
      author_person_id: coach.personId,
      author: json({ kind: 'system' }),
      corrects_assessment_id: original.id,
      correction_reason: 'Direct write',
      ...overrides,
    });
    for (const overrides of [
      { visibility: 'staff_only' },
      { skill_area_key: 'passing' },
      { offering_id: other.offeringId, author_person_id: otherCoach.personId },
    ]) {
      expect(
        await rejectsWith(
          t.db
            .insertInto('assessments')
            .values(row(overrides) as never)
            .execute(),
        ),
      ).toBe('23514');
    }
    // A matching correction in progress cannot be turned into a staff-only one either.
    const started = await post(t, '/v1/assessments', coach.header, correction());
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const hidden = await t.http
      .patch(`/v1/assessments/${started.body.id as string}`)
      .set(coach.header)
      .set('Idempotency-Key', `k-${newId()}`)
      .send({ visibility: 'staff_only', expectedRevision: started.body.revision });
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(400);
    expect(hidden.body.details).toMatchObject({ code: 'CORRECTION_MISMATCH' });
    expect(
      await rejectsWith(
        t.db
          .updateTable('assessments')
          .set({ visibility: 'staff_only', comments: null })
          .where('id', '=', started.body.id as string)
          .execute(),
      ),
    ).toBe('23514');
    // Another coach of the offering learns that a correction is live, not which draft it is;
    // a program manager is told which.
    const secondCoach = await coachOn(setup.offeringId);
    const blocked = await post(t, '/v1/assessments', secondCoach.header, correction());
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({
      code: 'ALREADY_CORRECTED',
      correctedByAssessmentId: null,
    });
    const named = await post(t, '/v1/assessments', reviewer.header, correction());
    expect(named.status).toBe(409);
    expect(named.body.details.correctedByAssessmentId).toBe(started.body.id);
    // The family still sees the feedback they were shown.
    expect((await feedback()).assessments.map((a) => a.id)).toContain(original.id);
  });

  it('§4.9: the database refuses a correction without a reason and a second live correction', async () => {
    const original = await draft(coach, 'staff_only', { skillAreaKey: 'passing' });
    await post(t, `/v1/assessments/${original.id}/review`, reviewer.header, {
      decision: 'approve',
      expectedRevision: original.revision,
    });
    const row = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      template_id: templateId,
      participant_person_id: kid,
      offering_id: setup.offeringId,
      skill_area_key: 'passing',
      observed_on: '2026-11-12',
      scale_value: 2,
      visibility: 'staff_only' as const,
      author_person_id: coach.personId,
      author: json({ kind: 'system' }),
      corrects_assessment_id: original.id,
      ...overrides,
    });
    expect(
      await rejectsWith(
        t.db
          .insertInto('assessments')
          .values(row({}) as never)
          .execute(),
      ),
    ).toBe('23514');
    expect(
      await rejectsWith(
        t.db
          .insertInto('assessments')
          .values(
            row({ corrects_assessment_id: null, correction_reason: 'Not a correction' }) as never,
          )
          .execute(),
      ),
    ).toBe('23514');
    await t.db
      .insertInto('assessments')
      .values(row({ correction_reason: 'First' }) as never)
      .execute();
    expect(
      await rejectsWith(
        t.db
          .insertInto('assessments')
          .values(row({ correction_reason: 'Second' }) as never)
          .execute(),
      ),
    ).toBe('23505');
  });

  it('§4.7 invariant 9 / SPK-YOUTH-006: the database refuses rewriting a shared recommendation, any change to a withdrawn one and a content edit of a submitted assessment', async () => {
    const other = await offering(t, { kind: 'term', programId, basePriceMinor: 0 });
    const created = await post(t, '/v1/progression-recommendations', coach.header, {
      participantPersonId: kid,
      fromOfferingId: setup.offeringId,
      recommendedProgramId: programId,
      suitability: 'Ready for match play.',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    // A draft is still the author's to edit.
    await t.db
      .updateTable('progression_recommendations')
      .set({ suitability: 'Ready for match play soon.' })
      .where('id', '=', id)
      .execute();
    const shared = await post(t, `/v1/progression-recommendations/${id}/share`, coach.header, {
      expectedRevision: created.body.revision,
    });
    expect(shared.status).toBe(200);
    const rewrite = (set: Record<string, unknown>) =>
      rejectsWith(
        t.db
          .updateTable('progression_recommendations')
          .set(set as never)
          .where('id', '=', id)
          .execute(),
      );
    expect(await rewrite({ suitability: 'Different advice' })).toBe('23514');
    expect(
      await rewrite({ recommended_program_id: null, recommended_offering_id: other.offeringId }),
    ).toBe('23514');
    expect(await rewrite({ eligibility_snapshot: json({ eligible: true }) })).toBe('23514');
    expect(await rewrite({ shared_at: new Date(t.clock.now().getTime() - 86_400_000) })).toBe(
      '23514',
    );
    const withdrawn = await post(
      t,
      `/v1/progression-recommendations/${id}/withdraw`,
      coach.header,
      {
        reason: 'Superseded',
        expectedRevision: shared.body.revision,
      },
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(await rewrite({ withdrawn_reason: 'Rewritten' })).toBe('23001');
    const after = await t.db
      .selectFrom('progression_recommendations')
      .select(['suitability', 'recommended_program_id', 'withdrawn_reason'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({
      suitability: 'Ready for match play soon.',
      recommended_program_id: programId,
      withdrawn_reason: 'Superseded',
    });

    // A submitted assessment is approved as it stands: its content is fixed until returned.
    const submitted = await draft(coach, 'family', { skillAreaKey: 'passing', scaleValue: 1 });
    const edit = (set: Record<string, unknown>) =>
      rejectsWith(
        t.db
          .updateTable('assessments')
          .set(set as never)
          .where('id', '=', submitted.id)
          .execute(),
      );
    expect(await edit({ scale_value: 3 })).toBe('23514');
    expect(await edit({ comments: 'Rewritten' })).toBe('23514');
    expect(await edit({ visibility: 'staff_only' })).toBe('23514');
    // Reviewing it moves it on; the review itself cannot change the content either.
    expect(
      await edit({
        status: 'published',
        scale_value: 3,
        reviewer_person_id: reviewer.personId,
        reviewed_at: t.clock.now(),
      }),
    ).toBe('23514');
    const returned = await post(t, `/v1/assessments/${submitted.id}/review`, reviewer.header, {
      decision: 'return',
      note: 'Check the drill',
      expectedRevision: submitted.revision,
    });
    expect(returned.body.status).toBe('returned');
    // Returned to the author, it is editable again.
    const fixed = await t.http
      .patch(`/v1/assessments/${submitted.id}`)
      .set(coach.header)
      .set('Idempotency-Key', `k-${newId()}`)
      .send({ scaleValue: 2, expectedRevision: returned.body.revision });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body.scaleValue).toBe(2);
  });

  it('SPK-YOUTH-005: only staff of the offering author assessments', async () => {
    const outsiderCoach = await staff(t, ['coach']);
    const refused = await post(t, '/v1/assessments', outsiderCoach.header, {
      templateId,
      participantPersonId: kid,
      offeringId: setup.offeringId,
      skillAreaKey: 'dribbling',
      observedOn: '2026-11-12',
      scaleValue: 1,
      visibility: 'family',
    });
    expect(refused.status).toBe(403);
    const customer = await post(t, '/v1/assessments', guardian.header, {
      templateId,
      participantPersonId: kid,
      offeringId: setup.offeringId,
      skillAreaKey: 'dribbling',
      observedOn: '2026-11-12',
      scaleValue: 1,
      visibility: 'family',
    });
    expect(customer.status).toBe(403);
  });
});
