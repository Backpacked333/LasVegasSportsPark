/**
 * SCR-W-07 Assessments (coach): SPK-YOUTH-005 (assessments on approved templates with skill area,
 * observation date, scale, author, comments, visibility and review status; private notes and
 * family feedback kept apart; review by a program manager other than the author), SPK-YOUTH-006
 * (recommendations that reserve nothing; eligibility unknown stays unknown), DEC-016 (the
 * youth_progression switch starts off; reads and withdrawal stay available), ENR-14 commands with
 * `expectedRevision` and one idempotency key per intent, CAPABILITY_DISABLED as "turned off",
 * protected NOT_FOUND as not available.
 */
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHILD_1,
  ME_PERSON,
  OFFERING,
  SESSION_1,
  assignmentRecord,
  myAssignments,
  nameEntry,
  oneFacilityMe,
  personNames,
  workspaceItem,
} from '../../../../features/operations/testing';
import { FACILITY_A, createTestApp, mePermissions } from '../../../../testing/test-app';

const TEMPLATE = '0192f1a0-0000-7000-8000-0000000008a1';
const PROGRAM = '0192f1a0-0000-7000-8000-0000000008b1';
const OTHER_COACH = '0192f1a0-0000-7000-8000-0000000008c1';
const ASSESSMENT = '0192f1a0-0000-7000-8000-0000000008d1';
const RECOMMENDATION = '0192f1a0-0000-7000-8000-0000000008e1';
const NEXT_OFFERING = '0192f1a0-0000-7000-8000-0000000008f1';

const COACH_ACTIONS = [
  'enrollment.author_assessment',
  'enrollment.withdraw_assessment',
  'enrollment.recommend_progression',
  'enrollment.withdraw_recommendation',
];
const MANAGER_ACTIONS = [
  ...COACH_ACTIONS,
  'enrollment.review_assessment',
  'enrollment.manage_assessment_template',
  'enrollment.retire_assessment_template',
];

const SESSION_ASSIGNMENT = assignmentRecord({
  kind: 'coach',
  targetType: 'session',
  targetId: SESSION_1,
  offeringId: OFFERING,
  schedulingEventId: null,
  targetTitle: 'Junior skills',
  role: 'head_coach',
  status: 'accepted',
});

function assessment(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSESSMENT,
    templateId: TEMPLATE,
    participantPersonId: CHILD_1,
    offeringId: OFFERING,
    skillAreaKey: 'ball_control',
    observedOn: '2026-10-20',
    scaleValue: 2,
    comments: 'Good first touch',
    staffNote: 'Watch left foot',
    visibility: 'family',
    status: 'draft',
    authorPersonId: ME_PERSON,
    reviewerPersonId: null,
    reviewNote: null,
    reviewedAt: null,
    correctsAssessmentId: null,
    correctionReason: null,
    revision: 3,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...overrides,
  };
}

function page(items: unknown[]) {
  return { status: 200, body: { items, nextCursor: null } };
}

const ATTENDANCE = {
  status: 200,
  body: {
    activity: {
      type: 'session',
      id: SESSION_1,
      offeringId: OFFERING,
      sessionId: SESSION_1,
      eventId: null,
    },
    people: [
      {
        personId: CHILD_1,
        givenName: 'Alex',
        familyName: 'Rivera',
        displayName: 'Alex Rivera',
        effectiveState: 'present',
        status: 'recorded',
        currentObservationIds: [],
        history: [],
      },
    ],
  },
};

function routes(
  options: { enabled?: boolean; actions?: string[] } = {},
  extra: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /me/permissions': mePermissions({
      enabled: options.enabled === false ? [] : ['youth_progression'],
      actions: (options.actions ?? COACH_ACTIONS).map((id) => ({ id, facilityIds: [FACILITY_A] })),
    }),
    'GET /me/assignments': myAssignments([workspaceItem(SESSION_ASSIGNMENT, [])]),
    'GET /attendance': ATTENDANCE,
    'GET /participants/{personId}/assessments': page([]),
    'GET /person-names': personNames([nameEntry(OTHER_COACH, 'Casey', 'Lee', 'adult')]),
    'GET /offerings': page([]),
    'GET /programs': page([
      {
        id: PROGRAM,
        name: 'Junior football',
        description: null,
        activityType: 'football',
        format: null,
        ageBand: {},
        status: 'active',
        source: 'staff',
        revision: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    ...extra,
  };
}

async function assessAlex(user: ReturnType<typeof userEvent.setup>) {
  const session = await screen.findByLabelText('Session');
  await user.selectOptions(session, SESSION_ASSIGNMENT.id as string);
  await user.click(await screen.findByRole('button', { name: 'Assess Alex Rivera' }));
  return screen.findByRole('heading', { name: 'Assessments of Alex Rivera in Junior skills' });
}

describe('SCR-W-07 AssessmentsScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('DEC-016: while youth progression is off, says so, keeps assessments readable and offers no authoring', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        { enabled: false },
        { 'GET /participants/{personId}/assessments': page([assessment()]) },
      ),
    });
    render(app.at('/workspace/assessments'));
    expect(
      await screen.findByText('Youth assessments and progression turned off'),
    ).toBeInTheDocument();
    expect(screen.getByText(/drafts can still be withdrawn/)).toBeInTheDocument();
    await assessAlex(user);
    const row = await screen.findByRole('listitem', {
      name: 'ball_control, observed 2026-10-20',
    });
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    // Withdrawal is never gated; authoring, submitting and review are not offered.
    expect(within(row).getByRole('button', { name: /^Withdraw/ })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^Submit for review/ })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record an assessment' })).toBeNull();
  });

  it('SPK-YOUTH-005: a coach records an assessment on a template, then submits it with the expected revision', async () => {
    const user = userEvent.setup();
    let created = false;
    const app = createTestApp({
      routes: routes(
        {},
        {
          // The API answers a coach NOT_FOUND until an assessment they may read exists.
          'GET /participants/{personId}/assessments': () =>
            created
              ? fakeResponse(200, { items: [assessment()], nextCursor: null })
              : fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
          'POST /assessments': () => {
            created = true;
            return fakeResponse(201, assessment());
          },
          'POST /assessments/{id}/submit': {
            status: 200,
            body: assessment({ status: 'submitted', revision: 4 }),
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    // From the coach's own session: "nothing visible yet", never "not available" or "check the link".
    expect(await screen.findByText('No assessments you can see yet')).toBeInTheDocument();
    expect(screen.queryByTestId('state-unavailable')).toBeNull();
    expect(screen.queryByText(/Check the link/)).toBeNull();
    const read = app.fake.requests.find((r) => r.route === '/participants/{personId}/assessments');
    expect(read?.params).toEqual({ personId: CHILD_1 });
    expect(read?.query.offeringId).toBe(OFFERING);

    await user.click(screen.getByRole('button', { name: 'Record an assessment' }));
    const form = screen.getByRole('form', { name: 'Record an assessment of Alex Rivera' });
    await user.click(within(form).getByRole('button', { name: 'Save as draft' }));
    expect(within(form).getByText('Choose an approved template.')).toBeInTheDocument();
    expect(within(form).getByText('Choose who may see it.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/assessments')).toBe(false);

    await user.selectOptions(within(form).getByLabelText('Template'), 'other');
    await user.type(within(form).getByLabelText('Template reference'), TEMPLATE);
    await user.type(within(form).getByLabelText('Skill area key'), 'ball_control');
    await user.type(within(form).getByLabelText('Observation date'), '2026-10-20');
    await user.type(within(form).getByLabelText('Value on the scale'), '2');
    await user.click(
      within(form).getByRole('radio', { name: 'Family-visible feedback once approved' }),
    );
    await user.type(
      within(form).getByLabelText('Feedback comments (optional)'),
      'Good first touch',
    );
    await user.type(
      within(form).getByLabelText('Private coaching note (optional)'),
      'Watch left foot',
    );
    await user.click(within(form).getByRole('button', { name: 'Save as draft' }));
    const row = await screen.findByRole('listitem', {
      name: 'ball_control, observed 2026-10-20',
    });
    const post = app.fake.requests.find((r) => r.route === '/assessments');
    expect(post?.body).toEqual({
      skillAreaKey: 'ball_control',
      observedOn: '2026-10-20',
      scaleValue: 2,
      visibility: 'family',
      templateId: TEMPLATE,
      participantPersonId: CHILD_1,
      offeringId: OFFERING,
      comments: 'Good first touch',
      staffNote: 'Watch left foot',
    });
    // Private notes and family feedback stay apart (SPK-YOUTH-005).
    expect(within(row).getByText('Feedback: Good first touch')).toBeInTheDocument();
    expect(
      within(row).getByText('Private coaching note (staff only): Watch left foot'),
    ).toBeInTheDocument();
    expect(within(row).getByText(/By you/)).toBeInTheDocument();

    await user.click(
      within(row).getByRole('button', {
        name: 'Submit for review: ball_control, observed 2026-10-20',
      }),
    );
    expect(await within(row).findByText('Submitted for review')).toBeInTheDocument();
    const submit = app.fake.requests.find((r) => r.route === '/assessments/{id}/submit');
    expect(submit?.params).toEqual({ id: ASSESSMENT });
    expect(submit?.body).toEqual({ expectedRevision: 3 });
    expect(submit?.headers['idempotency-key']).not.toEqual(post?.headers['idempotency-key']);
  });

  it('shows the API’s template mismatch with its code and keeps the input', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        {},
        {
          'POST /assessments': {
            status: 400,
            body: apiErrorBody('VALIDATION_FAILED', {
              message:
                'The assessment must use an approved template, one of its skill areas and a value on its scale.',
              details: { code: 'TEMPLATE_MISMATCH' },
            }),
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    await user.click(await screen.findByRole('button', { name: 'Record an assessment' }));
    const form = screen.getByRole('form', { name: 'Record an assessment of Alex Rivera' });
    await user.selectOptions(within(form).getByLabelText('Template'), 'other');
    await user.type(within(form).getByLabelText('Template reference'), TEMPLATE);
    await user.type(within(form).getByLabelText('Skill area key'), 'dribbling');
    await user.type(within(form).getByLabelText('Observation date'), '2026-10-20');
    await user.type(within(form).getByLabelText('Value on the scale'), '9');
    await user.click(within(form).getByRole('radio', { name: 'Staff only' }));
    await user.click(within(form).getByRole('button', { name: 'Save as draft' }));
    expect(await within(form).findByText(/must use an approved template/)).toBeInTheDocument();
    expect(within(form).getByTestId('state-error')).toHaveTextContent('VALIDATION_FAILED');
    expect(within(form).getByLabelText('Skill area key')).toHaveValue('dribbling');
  });

  it('a submit refused because the switch was turned off shows "turned off", not a failure', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        {},
        {
          'GET /participants/{personId}/assessments': page([assessment()]),
          'POST /assessments/{id}/submit': () =>
            fakeResponse(403, capabilityDisabledBody('youth_progression')),
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const row = await screen.findByRole('listitem', {
      name: 'ball_control, observed 2026-10-20',
    });
    await user.click(
      within(row).getByRole('button', {
        name: 'Submit for review: ball_control, observed 2026-10-20',
      }),
    );
    expect(
      await within(row).findByText('Youth assessments and progression turned off'),
    ).toBeInTheDocument();
    expect(within(row).getByText(/CAPABILITY_DISABLED/)).toBeInTheDocument();
  });

  it('SPK-YOUTH-005: another program manager approves or returns a submitted assessment; the author cannot review it', async () => {
    const user = userEvent.setup();
    const theirs = assessment({ status: 'submitted', authorPersonId: OTHER_COACH, revision: 5 });
    const mine = assessment({
      id: '0192f1a0-0000-7000-8000-0000000008d2',
      status: 'submitted',
      skillAreaKey: 'passing',
    });
    const app = createTestApp({
      routes: routes(
        { actions: MANAGER_ACTIONS },
        {
          'GET /participants/{personId}/assessments': page([theirs, mine]),
          'POST /assessments/{id}/review': (req) =>
            fakeResponse(
              200,
              assessment({
                ...theirs,
                status:
                  (req.body as { decision: string }).decision === 'approve'
                    ? 'published'
                    : 'returned',
                revision: 6,
              }),
            ),
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const row = await screen.findByRole('listitem', {
      name: 'ball_control, observed 2026-10-20',
    });
    expect(await within(row).findByText(/By Casey Lee/)).toBeInTheDocument();
    const own = screen.getByRole('listitem', { name: 'passing, observed 2026-10-20' });
    expect(within(own).queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(within(own).getByText(/you cannot review your own/)).toBeInTheDocument();

    await user.click(
      within(row).getByRole('button', { name: 'Return ball_control, observed 2026-10-20' }),
    );
    const returning = within(row).getByRole('form', {
      name: 'Return ball_control, observed 2026-10-20',
    });
    await user.click(within(returning).getByRole('button', { name: 'Return to the author' }));
    expect(within(returning).getByText('A reason is required.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/assessments/{id}/review')).toBe(false);
    await user.click(
      within(row).getByRole('button', { name: 'Approve ball_control, observed 2026-10-20' }),
    );
    expect(await within(row).findByText('Published to the family')).toBeInTheDocument();
    const review = app.fake.requests.find((r) => r.route === '/assessments/{id}/review');
    expect(review?.body).toEqual({ expectedRevision: 5, decision: 'approve' });
  });

  it('shows a participant found by search that the viewer may not read as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        { actions: MANAGER_ACTIONS },
        {
          'GET /offerings': page([
            {
              id: OFFERING,
              programId: PROGRAM,
              facilityId: FACILITY_A,
              name: 'Junior skills',
              startsOn: '2026-09-01',
              endsOn: '2026-12-15',
            },
          ]),
          'GET /people': page([
            {
              id: CHILD_1,
              givenName: 'Alex',
              familyName: 'Rivera',
              kind: 'child',
              status: 'active',
              matchedOn: 'name',
            },
          ]),
          'GET /participants/{personId}/assessments': {
            status: 404,
            body: apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }),
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    const offering = await screen.findByLabelText('Offering');
    await waitFor(() =>
      expect(within(offering).getByRole('option', { name: /Junior skills/ })).toBeInTheDocument(),
    );
    await user.selectOptions(offering, OFFERING);
    await user.type(screen.getByRole('searchbox', { name: 'Find the participant' }), 'Alex{enter}');
    await user.click(await screen.findByRole('button', { name: 'Assess Alex Rivera' }));
    const heading = await screen.findByRole('heading', {
      name: 'Assessments of Alex Rivera in Junior skills',
    });
    expect(
      await within(heading.parentElement as HTMLElement).findByTestId('state-unavailable'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No assessments you can see yet')).toBeNull();
  });

  it('labels an author whose name the viewer may not read as a staff member, never a participant', async () => {
    const user = userEvent.setup();
    const UNNAMED = '0192f1a0-0000-7000-8000-0000000008c9';
    const app = createTestApp({
      routes: routes(
        {},
        {
          'GET /participants/{personId}/assessments': page([
            assessment({ status: 'submitted', authorPersonId: UNNAMED }),
          ]),
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const row = await screen.findByRole('listitem', {
      name: 'ball_control, observed 2026-10-20',
    });
    expect(
      await within(row).findByText(/By Staff member, name not available \(ref 0192f1a0\)/),
    ).toBeInTheDocument();
    expect(within(row).queryByText(/Participant, name not available/)).toBeNull();
  });

  it('keeps the note to the author and the withdrawal reason apart', async () => {
    const user = userEvent.setup();
    let returned = false;
    const submitted = assessment({ status: 'submitted', authorPersonId: OTHER_COACH, revision: 5 });
    const app = createTestApp({
      routes: routes(
        { actions: MANAGER_ACTIONS },
        {
          'GET /participants/{personId}/assessments': () =>
            fakeResponse(200, {
              items: [returned ? { ...submitted, status: 'returned', revision: 6 } : submitted],
              nextCursor: null,
            }),
          'POST /assessments/{id}/review': () => {
            returned = true;
            return fakeResponse(200, { ...submitted, status: 'returned', revision: 6 });
          },
          'POST /assessments/{id}/withdraw': {
            status: 200,
            body: assessment({ ...submitted, status: 'withdrawn', revision: 7 }),
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const row = await screen.findByRole('listitem', { name: 'ball_control, observed 2026-10-20' });
    await user.click(
      within(row).getByRole('button', { name: 'Return ball_control, observed 2026-10-20' }),
    );
    await user.type(within(row).getByLabelText('What should change'), 'Add the date');
    await user.click(within(row).getByRole('button', { name: 'Return to the author' }));
    await waitFor(() =>
      expect(
        within(row).getByRole('button', { name: 'Withdraw ball_control, observed 2026-10-20' }),
      ).toBeInTheDocument(),
    );
    expect(app.fake.requests.find((r) => r.route === '/assessments/{id}/review')?.body).toEqual({
      expectedRevision: 5,
      decision: 'return',
      note: 'Add the date',
    });
    await user.click(
      within(row).getByRole('button', { name: 'Withdraw ball_control, observed 2026-10-20' }),
    );
    // The note to the author is never carried over as the withdrawal reason.
    expect(within(row).getByLabelText('Reason for withdrawing')).toHaveValue('');
    await user.click(within(row).getByRole('button', { name: 'Confirm withdrawal' }));
    expect(within(row).getByText('A reason is required.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/assessments/{id}/withdraw')).toBe(false);
    await user.type(within(row).getByLabelText('Reason for withdrawing'), 'Recorded twice');
    await user.click(within(row).getByRole('button', { name: 'Confirm withdrawal' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/assessments/{id}/withdraw')?.body).toEqual(
        { expectedRevision: 6, reason: 'Recorded twice' },
      ),
    );
  });

  it('§4.9 / §4.7 invariant 9 / SPK-YOUTH-005: a correction says why and keeps the corrected observation’s skill area and visibility', async () => {
    const user = userEvent.setup();
    const CORRECTION = '0192f1a0-0000-7000-8000-0000000008d2';
    const published = assessment({ status: 'published', revision: 6 });
    const app = createTestApp({
      routes: routes(
        {},
        {
          'GET /participants/{personId}/assessments': page([published]),
          'POST /assessments': {
            status: 201,
            body: assessment({
              id: CORRECTION,
              scaleValue: 3,
              observedOn: '2026-10-21',
              correctsAssessmentId: ASSESSMENT,
              correctionReason: 'The level was misread.',
              revision: 1,
            }),
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const row = await screen.findByRole('listitem', { name: 'ball_control, observed 2026-10-20' });
    await user.click(
      within(row).getByRole('button', {
        name: 'Record a correction of ball_control, observed 2026-10-20',
      }),
    );
    const form = within(row).getByRole('form', { name: 'Record a correction' });
    // The corrected observation's skill area and visibility cannot be changed.
    expect(within(form).getByLabelText('Skill area key')).toHaveValue('ball_control');
    expect(within(form).getByLabelText('Skill area key')).toBeDisabled();
    const family = within(form).getByRole('radio', {
      name: 'Family-visible feedback once approved',
    });
    expect(family).toBeChecked();
    expect(family).toBeDisabled();
    expect(within(form).getByRole('radio', { name: 'Staff only' })).toBeDisabled();
    expect(within(form).getByLabelText('Template reference')).toHaveValue(TEMPLATE);
    await user.type(within(form).getByLabelText('Observation date'), '2026-10-21');
    await user.clear(within(form).getByLabelText('Value on the scale'));
    await user.type(within(form).getByLabelText('Value on the scale'), '3');
    await user.click(within(form).getByRole('button', { name: 'Save as draft' }));
    expect(within(form).getByText('Say why the assessment is corrected.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/assessments')).toBe(false);
    await user.type(
      within(form).getByLabelText(/^Reason for the correction/),
      '  The level was misread. ',
    );
    await user.click(within(form).getByRole('button', { name: 'Save as draft' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/assessments')).toBe(true),
    );
    expect(app.fake.requests.find((r) => r.route === '/assessments')?.body).toEqual({
      skillAreaKey: 'ball_control',
      observedOn: '2026-10-21',
      scaleValue: 3,
      visibility: 'family',
      templateId: TEMPLATE,
      participantPersonId: CHILD_1,
      offeringId: OFFERING,
      correctsAssessmentId: ASSESSMENT,
      reason: 'The level was misread.',
    });
  });

  it('shows the reason a correction gives and keeps an edited correction draft on the same observation', async () => {
    const user = userEvent.setup();
    const draft = assessment({
      id: '0192f1a0-0000-7000-8000-0000000008d3',
      visibility: 'staff_only',
      correctsAssessmentId: ASSESSMENT,
      correctionReason: 'The level was misread.',
    });
    const app = createTestApp({
      routes: routes({}, { 'GET /participants/{personId}/assessments': page([draft]) }),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const row = await screen.findByRole('listitem', { name: 'ball_control, observed 2026-10-20' });
    expect(
      within(row).getByText('Reason for the correction: The level was misread.'),
    ).toBeInTheDocument();
    await user.click(
      within(row).getByRole('button', { name: 'Edit ball_control, observed 2026-10-20' }),
    );
    const form = within(row).getByRole('form', { name: 'Edit the assessment' });
    expect(within(form).getByLabelText('Skill area key')).toBeDisabled();
    expect(within(form).getByRole('radio', { name: 'Staff only' })).toBeChecked();
    expect(
      within(form).getByRole('radio', { name: 'Family-visible feedback once approved' }),
    ).toBeDisabled();
  });

  it('says so when the coach has no accepted session', async () => {
    const app = createTestApp({
      routes: routes({}, { 'GET /me/assignments': myAssignments([]) }),
    });
    render(app.at('/workspace/assessments'));
    expect(await screen.findByText('No coached sessions')).toBeInTheDocument();
  });
});

describe('SCR-W-07 progression recommendations (SPK-YOUTH-006)', () => {
  beforeEach(() => window.localStorage.clear());

  function recommendation(overrides: Record<string, unknown> = {}) {
    return {
      id: RECOMMENDATION,
      participantPersonId: CHILD_1,
      fromOfferingId: OFFERING,
      recommendedOfferingId: NEXT_OFFERING,
      recommendedProgramId: null,
      eligibility: {
        eligible: true,
        reasons: [
          {
            code: 'age_unknown',
            severity: 'unknown',
            message: 'The date of birth is not recorded.',
            source: { type: 'person', id: null },
            requiredAction: 'record_date_of_birth',
          },
        ],
        evaluatedAt: '2026-10-24T12:00:00.000Z',
      },
      suitability: 'Ready for the next group',
      status: 'draft',
      sharedAt: null,
      revision: 1,
      createdAt: '2026-10-24T12:00:00.000Z',
      updatedAt: '2026-10-24T12:00:00.000Z',
      ...overrides,
    };
  }

  const OFFERINGS = page([
    {
      id: NEXT_OFFERING,
      programId: PROGRAM,
      facilityId: FACILITY_A,
      name: 'Junior skills 2',
      startsOn: '2027-01-05',
      endsOn: '2027-03-30',
    },
  ]);

  it('drafts a recommendation, keeps unknown eligibility unknown, and shares it with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        {},
        {
          'GET /offerings': OFFERINGS,
          'POST /progression-recommendations': { status: 201, body: recommendation() },
          'POST /progression-recommendations/{id}/share': {
            status: 200,
            body: recommendation({
              status: 'shared',
              sharedAt: '2026-10-24T12:00:00.000Z',
              revision: 2,
            }),
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    expect(screen.getByText(/DEC-055/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Recommend a next step for Alex Rivera' });
    await user.click(
      within(form).getByRole('button', { name: 'Save the recommendation as a draft' }),
    );
    expect(within(form).getByText('Choose an offering or a program.')).toBeInTheDocument();
    await user.click(within(form).getByRole('radio', { name: 'A specific offering' }));
    const choice = within(form).getByLabelText('Recommended offering');
    await waitFor(() =>
      expect(within(choice).getByRole('option', { name: /Junior skills 2/ })).toBeInTheDocument(),
    );
    await user.selectOptions(choice, NEXT_OFFERING);
    await user.type(
      within(form).getByLabelText('Why it suits the participant'),
      'Ready for the next group',
    );
    await user.click(
      within(form).getByRole('button', { name: 'Save the recommendation as a draft' }),
    );
    const card = await screen.findByRole('listitem', {
      name: 'Recommendation: Ready for the next group',
    });
    expect(within(card).getByText('Draft (not shared)')).toBeInTheDocument();
    // Unknown evidence is never shown as eligible.
    expect(within(card).getByText('Not known')).toBeInTheDocument();
    expect(within(card).queryByText('Eligible')).toBeNull();
    expect(app.fake.requests.find((r) => r.route === '/progression-recommendations')?.body).toEqual(
      {
        participantPersonId: CHILD_1,
        fromOfferingId: OFFERING,
        recommendedOfferingId: NEXT_OFFERING,
        suitability: 'Ready for the next group',
      },
    );
    await user.click(within(card).getByRole('button', { name: 'Share with the family' }));
    expect(await within(card).findByText('Shared with the family')).toBeInTheDocument();
    // SPK-SCHED-008: in the offering's facility zone (America/Los_Angeles), not the device's.
    expect(within(card).getByText(/Shared .*05:00 (PDT|GMT-7)/)).toBeInTheDocument();
    const share = app.fake.requests.find(
      (r) => r.route === '/progression-recommendations/{id}/share',
    );
    expect(share?.body).toEqual({ expectedRevision: 1 });
  });

  it('withdraws a recommendation with a required reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        {},
        {
          'GET /offerings': OFFERINGS,
          'POST /progression-recommendations': { status: 201, body: recommendation() },
          'POST /progression-recommendations/{id}/withdraw': {
            status: 200,
            body: recommendation({ status: 'withdrawn', revision: 2 }),
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const form = screen.getByRole('form', { name: 'Recommend a next step for Alex Rivera' });
    await user.click(within(form).getByRole('radio', { name: 'A specific offering' }));
    const choice = within(form).getByLabelText('Recommended offering');
    await waitFor(() =>
      expect(within(choice).getByRole('option', { name: /Junior skills 2/ })).toBeInTheDocument(),
    );
    await user.selectOptions(choice, NEXT_OFFERING);
    await user.type(
      within(form).getByLabelText('Why it suits the participant'),
      'Ready for the next group',
    );
    await user.click(
      within(form).getByRole('button', { name: 'Save the recommendation as a draft' }),
    );
    const card = await screen.findByRole('listitem', {
      name: 'Recommendation: Ready for the next group',
    });
    await user.click(within(card).getByRole('button', { name: 'Withdraw' }));
    await user.click(within(card).getByRole('button', { name: 'Confirm withdrawal' }));
    expect(within(card).getByText('A reason is required.')).toBeInTheDocument();
    await user.type(within(card).getByLabelText('Reason for withdrawing'), 'Family moved away');
    await user.click(within(card).getByRole('button', { name: 'Confirm withdrawal' }));
    expect(await within(card).findByText('Withdrawn')).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/progression-recommendations/{id}/withdraw')?.body,
    ).toEqual({ reason: 'Family moved away', expectedRevision: 1 });
  });
});

describe('SCR-W-07 recommending a program (SPK-YOUTH-006)', () => {
  beforeEach(() => window.localStorage.clear());

  it('chooses the program by name from GET /v1/programs and names it on the card; a stale withdrawal says it cannot be reloaded', async () => {
    const user = userEvent.setup();
    const made = {
      id: RECOMMENDATION,
      participantPersonId: CHILD_1,
      fromOfferingId: OFFERING,
      recommendedOfferingId: null,
      recommendedProgramId: PROGRAM,
      eligibility: null,
      suitability: 'Ready for match play',
      status: 'draft',
      sharedAt: null,
      revision: 2,
      createdAt: '2026-10-24T12:00:00.000Z',
      updatedAt: '2026-10-24T12:00:00.000Z',
    };
    const app = createTestApp({
      routes: routes(
        {},
        {
          'POST /progression-recommendations': { status: 201, body: made },
          'POST /progression-recommendations/{id}/withdraw': {
            status: 409,
            body: apiErrorBody('STALE_REVISION', {
              nextAction: 'reload_and_retry',
              details: { expectedRevision: 2, currentRevision: 3 },
            }),
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const form = screen.getByRole('form', { name: 'Recommend a next step for Alex Rivera' });
    await user.click(within(form).getByRole('radio', { name: 'A program' }));
    const program = within(form).getByLabelText('Recommended program');
    await waitFor(() =>
      expect(within(program).getByRole('option', { name: 'Junior football' })).toBeInTheDocument(),
    );
    // Programs are named, never typed as record ids.
    expect(within(form).queryByLabelText(/reference/)).toBeNull();
    await user.selectOptions(program, PROGRAM);
    await user.type(
      within(form).getByLabelText('Why it suits the participant'),
      'Ready for match play',
    );
    await user.click(
      within(form).getByRole('button', { name: 'Save the recommendation as a draft' }),
    );
    const card = await screen.findByRole('listitem', {
      name: 'Recommendation: Ready for match play',
    });
    expect(within(card).getByText('A program: Junior football')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/progression-recommendations')?.body).toEqual(
      {
        participantPersonId: CHILD_1,
        fromOfferingId: OFFERING,
        recommendedProgramId: PROGRAM,
        suitability: 'Ready for match play',
      },
    );
    await user.click(within(card).getByRole('button', { name: 'Withdraw' }));
    await user.type(within(card).getByLabelText('Reason for withdrawing'), 'Changed my mind');
    await user.click(within(card).getByRole('button', { name: 'Confirm withdrawal' }));
    expect(await within(card).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    expect(within(card).getByTestId('stale-without-read')).toHaveTextContent(
      'no read of it to reload',
    );
    expect(
      app.fake.requests.find((r) => r.route === '/progression-recommendations/{id}/withdraw')?.body,
    ).toEqual({ reason: 'Changed my mind', expectedRevision: 2 });
  });

  it('shows a refused programs list as not available with its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        {},
        { 'GET /programs': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')) },
      ),
    });
    render(app.at('/workspace/assessments'));
    await assessAlex(user);
    const form = screen.getByRole('form', { name: 'Recommend a next step for Alex Rivera' });
    await user.click(within(form).getByRole('radio', { name: 'A program' }));
    expect(await within(form).findByText('Programs are not available')).toBeInTheDocument();
    expect(within(form).getByText(/Error code: ACCESS_DENIED/)).toBeInTheDocument();
  });
});

describe('SCR-W-07 templates for program managers (DEC-054)', () => {
  beforeEach(() => window.localStorage.clear());

  const drafted = {
    id: TEMPLATE,
    programId: PROGRAM,
    name: 'Junior skills',
    version: 1,
    skillAreas: [{ key: 'ball_control', label: 'Ball control' }],
    scale: { kind: 'ordinal', levels: ['Emerging', 'Developing', 'Secure'] },
    status: 'draft',
    approvedAt: null,
    retiredAt: null,
    revision: 1,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
  };

  it('drafts and approves a template, which the assessment form then offers with its skill areas and scale', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        { actions: MANAGER_ACTIONS },
        {
          'POST /assessment-templates': { status: 201, body: drafted },
          'POST /assessment-templates/{id}/approve': {
            status: 200,
            body: {
              ...drafted,
              status: 'approved',
              approvedAt: '2026-10-24T12:00:00.000Z',
              revision: 2,
            },
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    expect(await screen.findByText(/DEC-054/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Draft a template' }));
    const form = screen.getByRole('form', { name: 'Draft an assessment template' });
    const program = within(form).getByLabelText('Program');
    await waitFor(() =>
      expect(within(program).getByRole('option', { name: 'Junior football' })).toBeInTheDocument(),
    );
    await user.selectOptions(program, PROGRAM);
    await user.type(within(form).getByLabelText('Template name'), 'Junior skills');
    await user.type(within(form).getByLabelText('Version'), '1');
    await user.type(within(form).getByLabelText('Skill area 1 key'), 'Ball control');
    await user.type(within(form).getByLabelText('Skill area 1 label'), 'Ball control');
    await user.type(
      within(form).getByLabelText('Scale levels (one per line, lowest first)'),
      'Emerging{enter}Developing{enter}Secure',
    );
    await user.click(within(form).getByRole('button', { name: 'Save the template as a draft' }));
    expect(within(form).getByText(/Each skill area needs a lower-case key/)).toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Skill area 1 key'));
    await user.type(within(form).getByLabelText('Skill area 1 key'), 'ball_control');
    await user.click(within(form).getByRole('button', { name: 'Save the template as a draft' }));
    const templates = await screen.findByRole('list', { name: 'Templates on this page' });
    expect(app.fake.requests.find((r) => r.route === '/assessment-templates')?.body).toEqual({
      programId: PROGRAM,
      name: 'Junior skills',
      version: 1,
      skillAreas: [{ key: 'ball_control', label: 'Ball control' }],
      scale: { kind: 'ordinal', levels: ['Emerging', 'Developing', 'Secure'] },
    });
    await user.click(
      within(templates).getByRole('button', { name: 'Approve Junior skills (version 1)' }),
    );
    expect(await within(templates).findByText('Approved template')).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/assessment-templates/{id}/approve')?.body,
    ).toEqual({ expectedRevision: 1 });

    await assessAlex(user);
    await user.click(await screen.findByRole('button', { name: 'Record an assessment' }));
    const record = screen.getByRole('form', { name: 'Record an assessment of Alex Rivera' });
    await user.selectOptions(within(record).getByLabelText('Template'), TEMPLATE);
    expect(
      within(within(record).getByLabelText('Skill area')).getByRole('option', {
        name: 'Ball control',
      }),
    ).toBeInTheDocument();
    expect(
      within(within(record).getByLabelText('Value on the scale')).getByRole('option', {
        name: '3: Secure',
      }),
    ).toBeInTheDocument();
  });

  it('retires a template with a reason and its expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes(
        { actions: MANAGER_ACTIONS },
        {
          'POST /assessment-templates': { status: 201, body: drafted },
          'POST /assessment-templates/{id}/retire': {
            status: 200,
            body: {
              ...drafted,
              status: 'retired',
              retiredAt: '2026-10-24T12:00:00.000Z',
              revision: 2,
            },
          },
        },
      ),
    });
    render(app.at('/workspace/assessments'));
    await user.click(await screen.findByRole('button', { name: 'Draft a template' }));
    const form = screen.getByRole('form', { name: 'Draft an assessment template' });
    const program = within(form).getByLabelText('Program');
    await waitFor(() =>
      expect(within(program).getByRole('option', { name: 'Junior football' })).toBeInTheDocument(),
    );
    await user.selectOptions(program, PROGRAM);
    await user.type(within(form).getByLabelText('Template name'), 'Junior skills');
    await user.type(within(form).getByLabelText('Version'), '1');
    await user.type(within(form).getByLabelText('Skill area 1 key'), 'ball_control');
    await user.type(within(form).getByLabelText('Skill area 1 label'), 'Ball control');
    await user.type(
      within(form).getByLabelText('Scale levels (one per line, lowest first)'),
      'Emerging{enter}Secure',
    );
    await user.click(within(form).getByRole('button', { name: 'Save the template as a draft' }));
    const templates = await screen.findByRole('list', { name: 'Templates on this page' });
    await user.click(
      within(templates).getByRole('button', { name: 'Retire Junior skills (version 1)' }),
    );
    await user.type(within(templates).getByLabelText('Reason for retiring'), 'Replaced by v2');
    await user.click(within(templates).getByRole('button', { name: 'Confirm retirement' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/assessment-templates/{id}/retire')?.body,
      ).toEqual({ reason: 'Replaced by v2', expectedRevision: 1 }),
    );
  });

  it('does not offer templates to a coach without the template permission', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/workspace/assessments'));
    expect(await screen.findByLabelText('Session')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Assessment templates' })).toBeNull();
  });
});
