/**
 * SCR-S-32 Availability and qualifications: SPK-STAFF-001 (evidence verified, rejected with a
 * reason, availability windows recorded), DEC-011 pending, ACCESS_DENIED as not available; the
 * officials and coaches come from the staff directory (ID-05), never typed as record ids.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ME_PERSON,
  OFFICIAL,
  nameEntry,
  oneFacilityMe,
  personNames,
} from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const COACH = '0192f1a0-0000-7000-8000-000000000002';

function directory(items: unknown[]) {
  return { status: 200, body: { items, nextCursor: null } };
}

const JORDAN = {
  personId: OFFICIAL,
  displayName: 'Jordan Lee',
  roles: ['official'],
  facilityIds: [],
  scopes: [{ role: 'official', facilityIds: [] }],
};
const CASEY = {
  personId: COACH,
  displayName: 'Casey Lee',
  roles: ['coach'],
  facilityIds: [FACILITY_A],
  scopes: [{ role: 'coach', facilityIds: [FACILITY_A] }],
};

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
    'GET /person-names': personNames([nameEntry(OFFICIAL, 'Jordan', 'Lee', 'adult')]),
    'GET /staff-directory': directory([CASEY, JORDAN]),
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

  it('ID-05: lists officials and coaches from the staff directory and opens one’s availability', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/staff/availability'));
    const list = await screen.findByRole('list', { name: 'Officials and coaches' });
    const casey = within(list).getByRole('listitem', { name: 'Casey Lee' });
    expect(within(casey).getByText('coach: 1 facility')).toBeInTheDocument();
    expect(within(list).getByRole('listitem', { name: 'Jordan Lee' })).toHaveTextContent(
      'official: every facility',
    );
    const read = app.fake.requests.find((r) => r.route === '/staff-directory');
    expect(read?.query.facilityId).toBe(FACILITY_A);
    await user.click(within(casey).getByRole('button', { name: 'Availability of Casey Lee' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/availability').at(-1)?.query.personId,
      ).toBe(COACH),
    );
    expect(screen.getByLabelText('Whose availability')).toHaveValue(COACH);
  });

  it('records evidence for an official chosen from the directory', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': directory([JORDAN]),
        'POST /qualifications': { status: 201, body: qualification() },
      }),
    });
    render(app.at('/staff/availability'));
    await user.click(await screen.findByRole('button', { name: 'Record qualification evidence' }));
    const form = screen.getByRole('form', { name: 'Record qualification evidence' });
    const picker = within(form).getByLabelText('Official or coach');
    await waitFor(() =>
      expect(
        within(picker).getByRole('option', { name: 'Jordan Lee (official)' }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(picker, OFFICIAL);
    await user.type(within(form).getByLabelText('Qualification'), 'referee_grade_8');
    await user.type(within(form).getByLabelText('Valid from'), '2026-01-01T09:00');
    await user.click(within(form).getByRole('button', { name: 'Record evidence' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/qualifications' && r.method === 'POST')?.body,
      ).toMatchObject({ personId: OFFICIAL, kind: 'referee_grade_8' }),
    );
  });

  it('says so when nobody holds an official or coach role, and shows a refused directory as not available', async () => {
    const empty = createTestApp({ routes: routes({ 'GET /staff-directory': directory([]) }) });
    const { unmount } = render(empty.at('/staff/availability'));
    expect(await screen.findByText('No officials or coaches')).toBeInTheDocument();
    unmount();
    const refused = createTestApp({
      routes: routes({
        'GET /staff-directory': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      }),
    });
    render(refused.at('/staff/availability'));
    const section = (await screen.findByRole('heading', { name: 'Officials and coaches' }))
      .parentElement as HTMLElement;
    expect(await within(section).findByTestId('state-unavailable')).toBeInTheDocument();
  });

  it('SPK-SCHED-008: reads facility times in the zone from the facility directory when the Today feed is not readable', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /today': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
        'GET /facilities/{id}': {
          status: 200,
          body: {
            id: FACILITY_A,
            slug: 'north-park',
            name: 'North Park',
            timezone: 'America/New_York',
            status: 'active',
            address: null,
            inStaffScope: true,
          },
        },
      }),
    });
    render(app.at('/staff/availability'));
    const form = await screen.findByRole('form', { name: 'Add an availability window' });
    expect(await within(form).findAllByText('Facility time, America/New_York.')).not.toHaveLength(
      0,
    );
    expect(app.fake.requests.find((r) => r.route === '/facilities/{id}')?.params).toEqual({
      id: FACILITY_A,
    });
  });
});
