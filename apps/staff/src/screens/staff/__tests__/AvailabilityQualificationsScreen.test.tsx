/**
 * SCR-S-32 Availability and qualifications: SPK-STAFF-001 (evidence verified, rejected with a
 * reason, availability windows recorded), DEC-011 pending, ACCESS_DENIED as not available.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ME_PERSON, OFFICIAL, oneFacilityMe, person } from '../../../features/operations/testing';
import { createTestApp } from '../../../testing/test-app';

const QUAL = '0192f1a0-0000-7000-8000-0000000002a1';

function qualification(status = 'pending_verification') {
  return {
    id: QUAL,
    personId: OFFICIAL,
    kind: 'referee_grade_8',
    level: null,
    evidenceReference: 'Certificate 8812',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    status,
    verifiedAt: null,
    verifiedBy: null,
    statusReason: null,
    revision: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /qualifications': { status: 200, body: [qualification()] },
    'GET /availability': { status: 200, body: [] },
    'GET /people/{id}': (req) =>
      fakeResponse(200, person(req.params.id ?? '', 'Jordan', 'Lee', 'adult').body),
    ...extra,
  };
}

describe('SCR-S-32 AvailabilityQualificationsScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-STAFF-001: verifies pending evidence with the expected revision and names the pending requirement decision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /qualifications/{id}/verify': { status: 200, body: qualification('verified') },
      }),
    });
    render(app.at('/staff/availability'));
    const list = await screen.findByRole('list', { name: 'Qualification evidence' });
    expect(within(list).getByText('Awaiting verification')).toBeInTheDocument();
    expect(within(list).getByText(/Certificate 8812/)).toBeInTheDocument();
    expect(screen.getByText(/DEC-011/)).toBeInTheDocument();
    await user.click(
      await within(list).findByRole('button', { name: 'Verify Referee grade 8 for Jordan Lee' }),
    );
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/qualifications/{id}/verify')).toBe(true),
    );
    const verify = app.fake.requests.find((r) => r.route === '/qualifications/{id}/verify');
    expect(verify?.params).toEqual({ id: QUAL });
    expect(verify?.body).toEqual({ expectedRevision: 3 });
  });

  it('requires a reason to reject evidence', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /qualifications/{id}/reject': { status: 200, body: qualification('rejected') },
      }),
    });
    render(app.at('/staff/availability'));
    await user.click(
      await screen.findByRole('button', { name: 'Reject Referee grade 8 for Jordan Lee' }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm reject' }));
    expect(screen.getByText('A reason is required.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reason to reject'), 'Certificate expired');
    await user.click(screen.getByRole('button', { name: 'Confirm reject' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/qualifications/{id}/reject')?.body,
      ).toEqual({
        expectedRevision: 3,
        reason: 'Certificate expired',
      }),
    );
  });

  it('reads the viewer’s own availability and adds a window', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /availability': {
          status: 201,
          body: {
            id: '0192f1a0-0000-7000-8000-0000000002b1',
            personId: ME_PERSON,
            interval: { start: '2026-10-25T16:00:00.000Z', end: '2026-10-25T20:00:00.000Z' },
            kind: 'unavailable',
            note: null,
            status: 'active',
            withdrawnAt: null,
            withdrawnReason: null,
            revision: 1,
            createdAt: '2026-10-24T12:00:00.000Z',
          },
        },
      }),
    });
    render(app.at('/staff/availability'));
    expect(await screen.findByText('No windows')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/availability')?.query.personId).toBe(
      ME_PERSON,
    );
    const form = screen.getByRole('form', { name: 'Add an availability window' });
    await user.type(within(form).getByLabelText('Starts'), '2026-10-25T09:00');
    await user.type(within(form).getByLabelText('Ends'), '2026-10-25T13:00');
    await user.selectOptions(within(form).getByLabelText('Kind'), 'unavailable');
    await user.click(within(form).getByRole('button', { name: 'Add window' }));
    expect(await within(form).findByText('Unavailable window added')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/availability' && r.method === 'POST');
    const body = post?.body as {
      interval: { start: string; end: string };
      kind: string;
      personId?: string;
    };
    expect(body.kind).toBe('unavailable');
    expect(body.personId).toBeUndefined();
    expect(new Date(body.interval.start).getTime()).toBeLessThan(
      new Date(body.interval.end).getTime(),
    );
  });

  it('shows evidence the viewer may not read as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /qualifications': {
          status: 403,
          body: apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
        },
      }),
    });
    render(app.at('/staff/availability'));
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
  });
});
