/**
 * Staff S 3g release at pickup (SPK-ENTRY-007, DEC-034), S 4d injury report (SPK-DISC-001,
 * SPK-DISC-005) and S 5c skills assessment (SPK-YOUTH-005, SPK-YOUTH-006) in the coach workspace.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../../testing/test-app';
import { severityOf, summaryOf } from '../InjuryReport';
import { isDone } from '../SkillsAssessment';
import {
  ASSIGNMENT,
  AVA,
  BEN,
  DANA,
  NOAH,
  OFFERING,
  ROSA,
  SESSION,
  coachRoutes,
} from './coach-fixtures';

const PICKUP = `/workspace/assignments/${ASSIGNMENT}/pickup`;

const collectors = {
  status: 200,
  body: {
    participantPersonId: AVA,
    collectors: [
      { personId: DANA, givenName: 'Dana', familyName: 'Kim', displayName: 'Dana Kim' },
      { personId: ROSA, givenName: 'Rosa', familyName: 'Kim', displayName: 'Rosa Kim' },
    ],
    checkedAt: '2026-10-24T12:00:00.000Z',
    restrictions: [],
  },
};

describe('S 3g release a child at pickup', () => {
  it('SPK-ENTRY-007: only children marked here; only the adults who may collect; the button names both', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({
        'GET /releases/authorized-collectors': collectors,
        'POST /releases': {
          status: 201,
          body: {
            release: {
              verificationOutcome: 'verified',
              outcome: 'released',
              authorityCheckedAt: '2026-10-24T12:01:00.000Z',
            },
            departure: null,
          },
        },
      }),
    });
    render(app.at(PICKUP));
    // Ava (here) and Noah (late) are listed; Ben and Leo (unmarked) are not.
    const list = await screen.findByRole('list', { name: 'Children to release' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(within(list).getByRole('button', { name: 'Ava Kim' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Noah Brooks' })).toBeInTheDocument();
    expect(screen.getByText('2 of 2 left')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Ava Kim' }));
    expect(
      await screen.findByRole('heading', { name: "Who's picking Ava up?" }),
    ).toBeInTheDocument();
    const release = screen.getByRole('button', { name: /Choose who is collecting Ava/ });
    expect(release).toBeDisabled();
    await user.click(await screen.findByRole('button', { name: /Dana Kim/ }));
    await user.click(screen.getByRole('button', { name: 'Release Ava to Dana' }));
    await waitFor(() => expect(app.fake.requests.some((r) => r.route === '/releases')).toBe(true));
    const sent = app.fake.requests.find((r) => r.route === '/releases');
    expect(sent?.body).toMatchObject({
      childPersonId: AVA,
      collector: { personId: DANA },
      activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION },
      recordDeparture: true,
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    expect(await screen.findByText(/Ava released to Dana at 5:01/)).toBeInTheDocument();
    expect(screen.getByText('1 of 2 left')).toBeInTheDocument();
  });

  it('"Someone else" is a dead end: Not authorised. Call the desk. No override from the phone', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({ 'GET /releases/authorized-collectors': collectors }),
    });
    render(app.at(PICKUP));
    await user.click(await screen.findByRole('button', { name: 'Ava Kim' }));
    await user.click(await screen.findByRole('button', { name: /Someone else/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Not authorised. Call the desk.');
    expect(screen.getByRole('button', { name: /Choose who is collecting Ava/ })).toBeDisabled();
    expect(app.fake.requests.some((r) => r.route === '/releases')).toBe(false);
  });

  it('a refused release (authority changed) is reported and sends the coach to the desk', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({
        'GET /releases/authorized-collectors': collectors,
        'POST /releases': {
          status: 201,
          body: {
            release: {
              verificationOutcome: 'denied',
              outcome: 'not_released',
              authorityCheckedAt: '2026-10-24T12:01:00.000Z',
            },
            departure: null,
          },
        },
      }),
    });
    render(app.at(PICKUP));
    await user.click(await screen.findByRole('button', { name: 'Ava Kim' }));
    await user.click(await screen.findByRole('button', { name: /Rosa Kim/ }));
    await user.click(screen.getByRole('button', { name: 'Release Ava to Rosa' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/was not released.*Call the desk/);
  });

  it('DEC-034: offline, release is unavailable (no cached authority)', async () => {
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at(PICKUP));
    await screen.findByRole('list', { name: 'Children to release' });
    act(() => app.connectivity.set(false));
    expect(await screen.findByText(/Release needs a connection/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Children to release' })).toBeNull();
  });
});

describe('S 4d report an injury', () => {
  it('summary and severity carry facts only: where, what was done; 911 or a concussion sign is high', () => {
    expect(summaryOf('Ankle / foot', ['Ice and rest', 'Sat out the rest of the session'])).toBe(
      'Ankle / foot: ice and rest; sat out the rest of the session',
    );
    expect(severityOf('Ankle / foot', ['Ice and rest'], [])).toBe('low');
    expect(severityOf('Head', [], [])).toBe('medium');
    expect(severityOf('Head', [], ['Dizzy or off balance'])).toBe('high');
    expect(severityOf('Knee / leg', ['Called 911'], [])).toBe('high');
  });

  it('SPK-DISC-001: who → what → review → send records one injury incident on the session', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({ 'POST /incidents': { status: 201, body: { id: 'inc-1' } } }),
    });
    render(app.at('/workspace/issues'));
    expect(await screen.findByText('Step 1 of 3')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Noah Brooks' }));
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    // The allergy flag shows on the child card.
    expect(screen.getByText('✕ allergy')).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next: review' });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Ankle \/ foot/ }));
    await user.click(screen.getByLabelText('Ice and rest'));
    await user.click(screen.getByLabelText('Sat out the rest of the session'));
    // The voice note is proposed (no attachment storage in the API).
    expect(screen.getByRole('button', { name: /Add a voice note/ })).toBeDisabled();
    await user.click(next);
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(app.fake.requests.some((r) => r.route === '/incidents')).toBe(true));
    const sent = app.fake.requests.find((r) => r.route === '/incidents');
    expect(sent?.body).toMatchObject({
      kind: 'injury',
      offeringId: OFFERING,
      sessionId: SESSION,
      subjectPersonId: NOAH,
      severity: 'low',
      summary: 'Ankle / foot: ice and rest; sat out the rest of the session',
    });
    // No child name in the summary (it is the Today title staff read).
    expect((sent?.body as { summary: string }).summary).not.toMatch(/Noah/);
    expect(await screen.findByRole('heading', { name: 'Report sent' })).toBeInTheDocument();
    expect(screen.getByText(/On the manager's Today/)).toBeInTheDocument();
  });

  it('a head injury adds a concussion check step, kept in the restricted narrative', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: coachRoutes({ 'POST /incidents': { status: 201, body: { id: 'inc-2' } } }),
    });
    render(app.at('/workspace/issues'));
    await user.click(await screen.findByRole('button', { name: 'Ava Kim' }));
    await user.click(screen.getByRole('radio', { name: 'Head' }));
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next: concussion check' }));
    expect(screen.getByRole('heading', { name: 'Concussion check' })).toBeInTheDocument();
    await user.click(screen.getByLabelText('Dizzy or off balance'));
    expect(screen.getByRole('status')).toHaveTextContent(/sits out/);
    await user.click(screen.getByRole('button', { name: 'Next: review' }));
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(app.fake.requests.some((r) => r.route === '/incidents')).toBe(true));
    const body = app.fake.requests.find((r) => r.route === '/incidents')?.body as {
      severity: string;
      summary: string;
      narrative: string;
    };
    expect(body.severity).toBe('high');
    expect(body.summary).toBe('Head');
    expect(body.narrative).toContain('Concussion signs seen: Dizzy or off balance.');
  });

  it('offline, sending is disabled with the reason (call the desk)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace/issues'));
    await user.click(await screen.findByRole('button', { name: 'Ben Tran' }));
    await user.click(screen.getByRole('radio', { name: 'Other' }));
    await user.click(screen.getByRole('button', { name: 'Next: review' }));
    act(() => app.connectivity.set(false));
    expect(await screen.findByText(/Sending needs a connection/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
    void BEN;
  });
});

const TEMPLATE = {
  id: 'tpl-1',
  programId: 'prog-1',
  name: 'End of term',
  version: 1,
  skillAreas: [
    { key: 'dribbling', label: 'Dribbling' },
    { key: 'passing', label: 'Passing' },
  ],
  scale: { kind: 'ordinal', levels: ['Starting', 'Getting it', 'Got it'] },
  status: 'approved',
  approvedAt: '2026-10-01T00:00:00.000Z',
  retiredAt: null,
  revision: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function draft(personId: string, skill: string, value: number, id = `${personId}-${skill}`) {
  return {
    id,
    templateId: 'tpl-1',
    participantPersonId: personId,
    offeringId: OFFERING,
    skillAreaKey: skill,
    observedOn: '2026-10-24',
    scaleValue: value,
    comments: null,
    staffNote: null,
    visibility: 'family',
    status: 'draft',
    authorPersonId: 'p-coach',
    reviewerPersonId: null,
    reviewNote: null,
    reviewedAt: null,
    correctsAssessmentId: null,
    correctionReason: null,
    revision: 1,
    createdAt: '2026-10-24T11:00:00.000Z',
    updatedAt: '2026-10-24T11:00:00.000Z',
  };
}

function assessRoutes(extra = {}) {
  return coachRoutes({
    'GET /programs/{id}/assessment-templates': { status: 200, body: [TEMPLATE] },
    'GET /participants/{personId}/assessments': (request) => {
      const items =
        request.params['personId'] === AVA
          ? [draft(AVA, 'dribbling', 3), draft(AVA, 'passing', 2)]
          : [];
      return new Response(JSON.stringify({ items, nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    'GET /participants/{personId}/progression-recommendations': {
      status: 200,
      body: { items: [], nextCursor: null },
    },
    'GET /offerings': {
      status: 200,
      body: {
        items: [
          { id: 'next-1', name: 'Junior Skills 2', startsOn: '2026-12-08', programId: 'prog-1' },
        ],
        nextCursor: null,
      },
    },
    'POST /assessments': { status: 201, body: { id: 'new' } },
    'POST /progression-recommendations': { status: 201, body: { id: 'rec' } },
    'POST /assessments/{id}/submit': { status: 200, body: { id: 'x' } },
    ...extra,
  });
}

describe('S 5c skills assessment', () => {
  it('a child is done when every skill has a live assessment', () => {
    expect(
      isDone(TEMPLATE as never, [draft(AVA, 'dribbling', 3), draft(AVA, 'passing', 2)] as never),
    ).toBe(true);
    expect(isDone(TEMPLATE as never, [draft(AVA, 'dribbling', 3)] as never)).toBe(false);
  });

  it('SPK-YOUTH-005: plain-word levels per skill; Save drafts and moves straight to the next child; nothing is sent', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: assessRoutes() });
    render(app.at('/workspace/assessments'));
    // Ava is done (1 of 4); the first open child is Ben.
    expect(await screen.findByText(/end of term · 1 of 4 done/)).toBeInTheDocument();
    expect(await screen.findByText('Ben Tran')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /Save, next: Leo O\./ });
    expect(save).toBeDisabled();
    const dribbling = screen.getByRole('radiogroup', { name: 'Dribbling' });
    await user.click(within(dribbling).getByRole('radio', { name: 'Getting it' }));
    const passing = screen.getByRole('radiogroup', { name: 'Passing' });
    await user.click(within(passing).getByRole('radio', { name: 'Got it' }));
    await user.type(screen.getByRole('textbox'), 'Great first term.');
    expect(screen.getByRole('switch', { name: /Suggest Junior Skills 2 next term/ })).toBeChecked();
    await user.click(save);
    expect(await screen.findByText('Leo Ortiz')).toBeInTheDocument();
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/assessments')).toHaveLength(2),
    );
    const posted = app.fake.requests.filter((r) => r.route === '/assessments').map((r) => r.body);
    expect(posted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantPersonId: BEN,
          skillAreaKey: 'dribbling',
          scaleValue: 2,
          comments: 'Great first term.',
          visibility: 'family',
        }),
        expect.objectContaining({
          participantPersonId: BEN,
          skillAreaKey: 'passing',
          scaleValue: 3,
        }),
      ]),
    );
    expect(
      app.fake.requests.find((r) => r.route === '/progression-recommendations')?.body,
    ).toMatchObject({
      participantPersonId: BEN,
      recommendedOfferingId: 'next-1',
    });
    // Nothing is submitted until "Send all to families".
    expect(app.fake.requests.some((r) => r.route === '/assessments/{id}/submit')).toBe(false);
  });

  it('arrows skip without saving; "Send all to families" submits every draft', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: assessRoutes() });
    render(app.at('/workspace/assessments'));
    await screen.findByText('Ben Tran');
    await user.click(screen.getByRole('button', { name: 'Next child' }));
    expect(await screen.findByText('Leo Ortiz')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous child' }));
    expect(await screen.findByText('Ben Tran')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/assessments')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await user.click(screen.getByRole('button', { name: 'Send all to families' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/assessments/{id}/submit')).toHaveLength(
        2,
      ),
    );
    expect(app.fake.requests.find((r) => r.route === '/assessments/{id}/submit')?.body).toEqual({
      expectedRevision: 1,
    });
    expect(await screen.findByText(/A program manager checks them/)).toBeInTheDocument();
  });
});
