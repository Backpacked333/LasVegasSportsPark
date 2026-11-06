/**
 * Schedule timeline extras (SCR-S-03): sport colour (API migration 0304), the event detail read
 * (teams, staff, attendees, readiness; SPK-SCHED-009, SPK-READY-001), direct move and cancel that
 * publish a single-change draft (SPK-SCHED-005/006, SPK-COMMS-005), "message attendees" through the
 * communications composer (SPK-COMMS-003) and the day summary in the page header (SPK-SCHED-008).
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY,
  PITCH,
  SCHEDULE_FACILITY_ACTIONS,
  event,
  oneFacilityRoutes,
  page,
  scopedPermissions,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const FIXTURE_ID = '0192f1a0-0000-7000-8000-00000000f1f1';
const TEAM_A = '0192f1a0-0000-7000-8000-00000000aaa1';
const TEAM_B = '0192f1a0-0000-7000-8000-00000000aaa2';
const PLAYER = '0192f1a0-0000-7000-8000-00000000bbb1';

const HOOPS = event({
  id: 'e-hoops',
  title: 'Rec G3 Dunk Tank v Brick City',
  sport: 'basketball',
  resourceIds: [PITCH],
  sourceType: 'fixture',
  sourceId: FIXTURE_ID,
});

const DETAIL = {
  event: HOOPS,
  teams: [
    { teamEntryId: TEAM_A, role: 'home_team', teamName: 'Dunk Tank', rosterSize: 12 },
    { teamEntryId: TEAM_B, role: 'away_team', teamName: 'Brick City', rosterSize: 11 },
  ],
  staff: {
    identified: true,
    assignments: [
      {
        assignmentId: '0192f1a0-0000-7000-8000-00000000ccc1',
        personId: '0192f1a0-0000-7000-8000-00000000ccc2',
        displayName: 'Ruth Bell',
        kind: 'official',
        role: 'referee',
        status: 'accepted',
      },
    ],
  },
  committedPeople: [],
  attendees: { total: 23, byVia: { commitment: 0, enrollment: 0, booking: 0, roster: 23 } },
  fixtureId: FIXTURE_ID,
  messageAudience: { teamEntryIds: [TEAM_A, TEAM_B], subjectPersonIds: [PLAYER] },
};

const READINESS = {
  fixtureId: FIXTURE_ID,
  fixtureStatus: 'scheduled',
  status: 'blocked',
  evaluatedAt: '2026-10-24T12:00:00.000Z',
  scheduledStart: HOOPS.scheduledStart,
  checks: [
    { name: 'rosters', status: 'ready', issueCount: 0 },
    { name: 'workforce.officials', status: 'blocked', issueCount: 1 },
  ],
  issues: [],
  sides: [],
};

const ACTIONS = [
  ...SCHEDULE_FACILITY_ACTIONS,
  'scheduling.read_event_detail',
  'communications.compose',
];

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /me/permissions': scopedPermissions(ACTIONS),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /events': page([HOOPS]),
    'GET /sessions': page([]),
    'GET /closures': { status: 200, body: [] },
    'GET /events/{id}/detail': { status: 200, body: DETAIL },
    'GET /fixtures/{id}/readiness': { status: 200, body: READINESS },
    'GET /facilities/{id}/day-summary': {
      status: 200,
      body: {
        facilityId: FACILITY_A,
        date: '2026-10-24',
        timezone: 'America/Los_Angeles',
        window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
        schedule: {
          facilityId: FACILITY_A,
          window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
          activities: {
            total: 41,
            published: 40,
            draft: 1,
            canceled: 0,
            byKind: {},
            bySport: {},
          },
          closures: { active: 0, pending: 0 },
        },
        restrictions: { active: 1, approved: 0, proposed: 0, unreleasedAfterEnd: 0 },
        maintenance: { openTasks: 8, overdueTasks: 1 },
      },
    },
    ...overrides,
  };
}

async function selectHoops() {
  const user = userEvent.setup();
  const block = await screen.findByRole('button', {
    name: /^Rec G3 Dunk Tank v Brick City, Game, Basketball/,
  });
  await user.click(block);
  return {
    user,
    block,
    rail: screen.getByRole('complementary', { name: 'Selected on the timeline' }),
  };
}

describe('schedule timeline extras', () => {
  it('migration 0304: a basketball game gets its own kind colour and says its sport in words', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    const { block, rail } = await selectHoops();
    expect(block).toHaveAttribute('data-kind', 'basketball');
    expect(within(rail).getByText(/Game · Basketball/)).toBeInTheDocument();
  });

  it('SPK-SCHED-009: the rail shows teams with roster sizes, staff by name, attendee counts and readiness by check', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    const { rail } = await selectHoops();
    const extras = await within(rail).findByLabelText('Teams, staff and attendees');
    expect(extras).toHaveTextContent('Dunk Tank (12) · Brick City (11)');
    expect(extras).toHaveTextContent('Ruth Bell · referee');
    expect(extras).toHaveTextContent('23 expected');
    const readiness = await within(rail).findByTestId('event-readiness');
    await waitFor(() => expect(readiness).toHaveTextContent('Blocked'));
    expect(readiness).toHaveTextContent('workforce.officials: Blocked');
  });

  it('SPK-SCHED-006: "Move now" sends the new facility-local times with the event revision', async () => {
    const app = createTestApp({
      routes: routes({
        'POST /events/{id}/move': {
          status: 200,
          body: { event: { ...HOOPS, revision: 2 }, publication: {} },
        },
      }),
    });
    render(app.at('/schedule/calendar'));
    const { user, rail } = await selectHoops();
    await user.click(within(rail).getByRole('button', { name: 'Move now' }));
    const form = within(rail).getByRole('form', { name: 'Move this event' });
    const startTime = within(form).getAllByLabelText(/time/i)[0] as HTMLInputElement;
    await user.clear(startTime);
    await user.type(startTime, '20:00');
    const endTime = within(form).getAllByLabelText(/time/i)[1] as HTMLInputElement;
    await user.clear(endTime);
    await user.type(endTime, '21:30');
    await user.click(within(form).getByRole('button', { name: 'Move and publish' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.method === 'POST' && r.route === '/events/{id}/move'),
      ).toBe(true),
    );
    const sent = app.fake.requests.find((r) => r.route === '/events/{id}/move');
    expect(sent?.params).toEqual({ id: 'e-hoops' });
    expect(sent?.body).toMatchObject({
      scheduledStart: '2026-10-25T03:00:00.000Z',
      scheduledEnd: '2026-10-25T04:30:00.000Z',
      expectedRevision: HOOPS.revision,
    });
    expect(sent?.headers['idempotency-key']).toBeTruthy();
  });

  it('SPK-COMMS-005: canceling asks for the reason people are told, and shows a refusal with its cause', async () => {
    const app = createTestApp({
      routes: routes({
        'POST /events/{id}/cancel': {
          status: 409,
          body: {
            code: 'STALE_REVISION',
            message: 'The record changed.',
            correlationId: 'c-1',
            nextAction: 'reload',
          },
        },
      }),
    });
    render(app.at('/schedule/calendar'));
    const { user, rail } = await selectHoops();
    await user.click(within(rail).getByRole('button', { name: 'Cancel event' }));
    const form = within(rail).getByRole('form', { name: 'Cancel this event' });
    await user.click(within(form).getByRole('button', { name: 'Cancel and notify' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Enter the reason for canceling.');
    expect(app.fake.requests.some((r) => r.route === '/events/{id}/cancel')).toBe(false);
    await user.type(within(form).getByLabelText('Reason people are told'), 'Lightning');
    await user.click(within(form).getByRole('button', { name: 'Cancel and notify' }));
    expect(await within(form).findByText(/STALE_REVISION/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/events/{id}/cancel')?.body).toMatchObject({
      reason: 'Lightning',
      expectedRevision: HOOPS.revision,
    });
  });

  it('a role that may not publish is not offered direct changes', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': scopedPermissions(
          ACTIONS.filter((a) => a !== 'scheduling.publish_schedule'),
        ),
      }),
    });
    render(app.at('/schedule/calendar'));
    const { rail } = await selectHoops();
    expect(within(rail).queryByRole('button', { name: 'Move now' })).toBeNull();
    expect(within(rail).getByRole('link', { name: 'Change in a draft' })).toBeInTheDocument();
  });

  it('SPK-COMMS-003: "Message attendees" opens the composer with the teams and participants as the audience', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    const { user, rail } = await selectHoops();
    await user.click(await within(rail).findByRole('button', { name: 'Message attendees' }));
    await waitFor(() => expect(rail).toHaveTextContent(TEAM_A));
    expect(rail).toHaveTextContent(PLAYER);
  });

  it('SPK-SCHED-008: the page header counts the facility-local day', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    expect(await screen.findByTestId('day-summary')).toHaveTextContent(
      'Today: 41 activities · 1 active restriction',
    );
  });
});
