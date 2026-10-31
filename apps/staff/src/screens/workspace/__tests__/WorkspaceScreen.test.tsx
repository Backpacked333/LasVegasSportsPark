/**
 * SCR-W-01/SCR-W-02 coach and referee workspace (SPK-UX-007): only the viewer's assignments, offers
 * first; "Accept" only where the API allows it; the command carries an idempotency key per intent
 * and the expected revision (§4.9); a stale revision is reported with "Reload".
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

function assignment(
  id: string,
  status: string,
  start: string,
  availableActions: string[],
  revision = 1,
) {
  return {
    assignment: {
      id,
      facilityId: FACILITY_A,
      personId: 'p-1',
      kind: 'official',
      targetType: 'fixture',
      targetId: `t-${id}`,
      offeringId: null,
      schedulingEventId: null,
      targetTitle: `Fixture ${id}`,
      role: 'referee',
      slot: 1,
      engagement: 'paid',
      status,
      scheduledStart: start,
      scheduledEnd: start.replace('T10', 'T11'),
      turnaroundMinutes: 15,
      committedUntil: start,
      replacesAssignmentId: null,
      offeredAt: null,
      respondedAt: null,
      acceptedAt: null,
      declinedAt: null,
      declineReason: null,
      withdrawnAt: null,
      withdrawnReason: null,
      completedAt: null,
      access: 'active',
      revision,
      createdAt: start,
      updatedAt: start,
    },
    activity: {
      targetType: 'fixture',
      targetId: `t-${id}`,
      title: `U12 match ${id}`,
      facilityId: FACILITY_A,
      scheduledStart: start,
      scheduledEnd: start.replace('T10', 'T11'),
      participants: [
        { side: 'home', teamEntryId: null, name: 'Red' },
        { side: 'away', teamEntryId: null, name: 'Blue' },
      ],
    },
    fee: null,
    availableActions,
  };
}

const LIST = {
  status: 200,
  body: {
    evaluatedAt: '2026-10-24T12:00:00.000Z',
    items: [
      assignment('a1', 'accepted', '2026-10-25T10:00:00.000Z', ['withdraw']),
      assignment('a2', 'offered', '2026-10-26T10:00:00.000Z', ['accept', 'decline'], 3),
    ],
  },
};

describe('SCR-W-01 WorkspaceScreen', () => {
  it('lists the viewer’s assignments with offers awaiting a response first', async () => {
    const app = createTestApp({ routes: { 'GET /me/assignments': LIST } });
    render(app.at('/workspace'));
    const list = await screen.findByRole('list', { name: 'Assignments' });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByText('U12 match a2')).toBeInTheDocument();
    expect(
      within(items[0] as HTMLElement).getByText('Offered: response needed'),
    ).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Accepted')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('Red v Blue')).toBeInTheDocument();
  });

  it('offers Accept only where the API lists it, and sends the expected revision with a key', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/assignments': LIST,
        'POST /assignments/{id}/accept': { status: 200, body: { ok: true } },
      },
    });
    render(app.at('/workspace'));
    await screen.findByRole('list', { name: 'Assignments' });
    expect(screen.queryByRole('button', { name: 'Accept assignment: U12 match a1' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Accept assignment: U12 match a2' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/assignments/{id}/accept')).toBe(true),
    );
    const accept = app.fake.requests.find((r) => r.route === '/assignments/{id}/accept');
    expect(accept?.params).toEqual({ id: 'a2' });
    expect(accept?.body).toEqual({ expectedRevision: 3 });
    expect(accept?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    // The list is reloaded after success.
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/assignments')).toHaveLength(2),
    );
  });

  it('reports a stale revision with "Reload" and reloads the assignment', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/assignments': LIST,
        'POST /assignments/{id}/accept': () =>
          fakeResponse(
            409,
            apiErrorBody('STALE_REVISION', {
              nextAction: 'reload_and_retry',
              message: 'The record changed since it was loaded.',
            }),
          ),
      },
    });
    render(app.at('/workspace'));
    await user.click(
      await screen.findByRole('button', { name: 'Accept assignment: U12 match a2' }),
    );
    expect(
      await screen.findByText('Error code: STALE_REVISION. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/assignments')).toHaveLength(2),
    );
  });

  it('says so when there are no assignments, without showing other activities', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/assignments': {
          status: 200,
          body: { evaluatedAt: '2026-10-24T12:00:00.000Z', items: [] },
        },
      },
    });
    render(app.at('/workspace'));
    expect(await screen.findByRole('heading', { name: 'No assignments' })).toBeInTheDocument();
  });

  it('WRK-01 / SPK-SCHED-008: shows each activity in its facility’s zone with the facility name', async () => {
    const item = assignment('a3', 'accepted', '2026-10-25T10:00:00.000Z', []);
    const withFacility = {
      ...item,
      activity: {
        ...item.activity,
        facility: { id: FACILITY_A, name: 'North Park 1', timezone: 'America/New_York' },
      },
    };
    const app = createTestApp({
      routes: {
        'GET /me/assignments': {
          status: 200,
          body: { evaluatedAt: '2026-10-24T12:00:00.000Z', items: [withFacility] },
        },
      },
    });
    render(app.at('/workspace'));
    const list = await screen.findByRole('list', { name: 'Assignments' });
    // 10:00 UTC is 06:00 in New York (EDT).
    expect(within(list).getByText(/06:00.*North Park 1/)).toBeInTheDocument();
  });
});
