/**
 * Phase 8 item 6, the referee's match report (SCR-W-05 with crew/RefereeReportExtras.tsx;
 * SPK-RESULT-001, SPK-FAC-002): the score is prefilled from the coach's game log with a match
 * check; a different score must be fixed or explained (the explanation goes into the notes);
 * "Field damage" creates a field crew task after the report; the payout line.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_1,
  FIXTURE_1,
  assignmentRecord,
  myAssignments,
  oneFacilityMe,
  workspaceItem,
} from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const PITCH = '0192f1a0-0000-7000-8000-0000000000a1';
const RED = '0192f1a0-0000-7000-8000-0000000004a1';

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /me/assignments': myAssignments([
      workspaceItem(assignmentRecord({ status: 'accepted' }), []),
    ]),
    'GET /fixtures/{id}/results': { status: 200, body: [] },
    'GET /fixtures/{id}/game-logs': {
      status: 200,
      body: {
        fixtureId: FIXTURE_1,
        logs: [
          {
            teamEntryId: RED,
            teamName: 'Red',
            homeScore: 2,
            awayScore: 1,
            recordedAt: '2026-10-24T11:00:00.000Z',
          },
        ],
      },
    },
    'GET /fixtures/{id}/match-sheet': {
      status: 200,
      body: {
        fixtureId: FIXTURE_1,
        scheduledStart: '2026-10-24T10:00:00.000Z',
        status: 'scheduled',
        venue: {
          facilityId: FACILITY_A,
          facilityName: 'North Park 1',
          timezone: 'America/Los_Angeles',
          resources: [{ id: PITCH, name: 'Field 1' }],
        },
        view: 'full',
        sides: [],
      },
    },
    'POST /fixtures/{id}/results': {
      status: 201,
      body: {
        id: '0192f1a0-0000-7000-8000-0000000005a1',
        fixtureId: FIXTURE_1,
        revisionNo: 1,
        status: 'submitted',
        classification: 'completed',
        homeScore: 3,
        awayScore: 1,
        submittedBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Referee' },
        submittedAt: '2026-10-24T12:00:00.000Z',
      },
    },
    'POST /maintenance-tasks': { status: 201, body: { id: 't-1' } },
    ...extra,
  };
}

describe('Phase 8 item 6: referee match report', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-RESULT-001: prefills the coach’s score; a different score is explained in the notes; Field damage creates a crew task', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(`/workspace/assignments/${ASSIGNMENT_1}/report`));
    const form = await screen.findByRole('form', { name: 'Match report' });
    await waitFor(() => expect(within(form).getByLabelText('Red score')).toHaveValue('2'));
    expect(within(form).getByRole('radio', { name: 'Completed' })).toBeChecked();
    expect(within(form).getByTestId('match-check')).toHaveTextContent(
      '✓ Matches the coach: Red 2–1',
    );
    expect(within(form).getByTestId('payout-line')).toHaveTextContent('Hours and fees');

    await user.clear(within(form).getByLabelText('Red score'));
    await user.type(within(form).getByLabelText('Red score'), '3');
    expect(within(form).getByTestId('match-check')).toHaveTextContent('The coach kept 2–1 (Red)');
    await user.click(within(form).getByRole('button', { name: 'Field damage' }));
    await user.click(within(form).getByRole('button', { name: 'Dissent' }));
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    expect(
      await within(form).findByText("Your score differs from the coach's: fix it, or explain why."),
    ).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    await user.type(
      within(form).getByLabelText('Why the scores differ'),
      'Late goal after the coach stopped counting',
    );
    await user.click(within(form).getByRole('button', { name: 'Submit report' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter(
          (r) => r.route === '/fixtures/{id}/results' && r.method === 'POST',
        ),
      ).toHaveLength(1),
    );
    const report = app.fake.requests.find(
      (r) => r.route === '/fixtures/{id}/results' && r.method === 'POST',
    )!;
    expect(report.body).toMatchObject({ classification: 'completed', homeScore: 3, awayScore: 1 });
    expect((report.body as { notes: string }).notes).toContain('Conduct: Dissent.');
    expect((report.body as { notes: string }).notes).toContain(
      "Score differs from the coach's game log (Red 2-1): Late goal after the coach stopped counting",
    );
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/maintenance-tasks')).toHaveLength(1),
    );
    expect(app.fake.requests.find((r) => r.route === '/maintenance-tasks')!.body).toMatchObject({
      facilityId: FACILITY_A,
      resourceId: PITCH,
      severity: 'medium',
    });
  });

  it('"Injury" adds an injury incident to the report', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(`/workspace/assignments/${ASSIGNMENT_1}/report`));
    const form = await screen.findByRole('form', { name: 'Match report' });
    await user.click(within(form).getByRole('button', { name: 'Injury', pressed: false }));
    expect(within(form).getByLabelText('Incident 1 kind')).toHaveValue('injury');
  });
});
