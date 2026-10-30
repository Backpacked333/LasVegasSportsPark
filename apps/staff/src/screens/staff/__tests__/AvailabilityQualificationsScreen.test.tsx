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

function directory(items: unknown[], nextCursor: string | null = null) {
  return { status: 200, body: { items, nextCursor } };
}

/** `GET /v1/staff-directory` filters by one role (StaffDirectoryQuery). */
function byRole(people: { roles: string[] }[]): FakeHandler {
  return (req) =>
    fakeResponse(200, {
      items: people.filter((p) => !req.query.role || p.roles.includes(req.query.role)),
      nextCursor: null,
    });
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
    'GET /staff-directory': byRole([CASEY, JORDAN]),
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

  it('ID-05: lists officials and coaches from the staff directory (one read per role) and opens one’s availability', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/staff/availability'));
    const coaches = await screen.findByRole('list', { name: 'Coaches' });
    const casey = within(coaches).getByRole('listitem', { name: 'Casey Lee' });
    expect(within(casey).getByText('coach: 1 facility')).toBeInTheDocument();
    const officials = await screen.findByRole('list', { name: 'Officials' });
    expect(within(officials).getByRole('listitem', { name: 'Jordan Lee' })).toHaveTextContent(
      'official: every facility',
    );
    const reads = app.fake.requests.filter((r) => r.route === '/staff-directory');
    expect(reads.map((r) => r.query.role).sort()).toEqual(['coach', 'official']);
    expect(reads.every((r) => r.query.facilityId === FACILITY_A)).toBe(true);
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
    expect(await screen.findByText('No officials')).toBeInTheDocument();
    expect(await screen.findByText('No coaches')).toBeInTheDocument();
    unmount();
    const refused = createTestApp({
      routes: routes({
        'GET /staff-directory': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      }),
    });
    render(refused.at('/staff/availability'));
    const section = (await screen.findByRole('heading', { name: 'Officials and coaches' }))
      .parentElement as HTMLElement;
    expect(await within(section).findAllByTestId('state-unavailable')).toHaveLength(2);
  });

  it('SPK-UX-008: never says "nobody" while the directory has a further page', async () => {
    const user = userEvent.setup();
    // The API pages by name; with a role filter the first page is never filtered on the client.
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': (req) =>
          req.query.cursor
            ? fakeResponse(200, { items: [JORDAN], nextCursor: null })
            : fakeResponse(200, {
                items: [],
                nextCursor: req.query.role === 'official' ? 'p2' : null,
              }),
      }),
    });
    render(app.at('/staff/availability'));
    expect(await screen.findByText('No coaches')).toBeInTheDocument();
    const officials = (await screen.findByRole('heading', { name: 'Officials' }))
      .parentElement as HTMLElement;
    await user.click(await within(officials).findByRole('button', { name: 'Load more officials' }));
    expect(screen.queryByText('No officials')).toBeNull();
    expect(
      await within(officials).findByRole('listitem', { name: 'Jordan Lee' }),
    ).toBeInTheDocument();
  });

  it('SPK-SCHED-008: shows evidence validity and availability windows in the facility zone they were entered in', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /availability': {
          status: 200,
          body: [
            {
              id: '0192f1a0-0000-7000-8000-0000000002b1',
              personId: ME_PERSON,
              interval: { start: '2026-10-25T17:00:00.000Z', end: '2026-10-25T21:00:00.000Z' },
              kind: 'available',
              note: null,
              status: 'active',
              withdrawnAt: null,
              withdrawnReason: null,
              revision: 1,
              createdAt: '2026-10-24T12:00:00.000Z',
            },
          ],
        },
      }),
    });
    render(app.at('/staff/availability'));
    // The Today feed gives America/Los_Angeles: 17:00Z is 10:00 PDT, whatever the device zone.
    const windows = await screen.findByRole('list', { name: 'Availability windows' });
    expect(within(windows).getByText(/10:00 (PDT|GMT-7) to 14:00/)).toBeInTheDocument();
    const evidence = await screen.findByRole('list', { name: 'Qualification evidence' });
    expect(
      within(evidence).getByText(/Valid from .*16:00 (PST|PDT|GMT-8|GMT-7)/),
    ).toBeInTheDocument();
  });

  it('SCR-S-32: the evidence form never records against a person the picker no longer shows', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': (req) =>
          fakeResponse(200, {
            items: req.query.query ? [CASEY] : [JORDAN],
            nextCursor: null,
          }),
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
    // A new name search leaves Jordan out of the results; Enter only searches.
    await user.type(within(form).getByLabelText('Find official or coach by name'), 'Cas{enter}');
    await waitFor(() =>
      expect(within(picker).getByRole('option', { name: 'Casey Lee (coach)' })).toBeInTheDocument(),
    );
    expect(
      app.fake.requests.some((r) => r.route === '/qualifications' && r.method === 'POST'),
    ).toBe(false);
    // The chosen person stays visible as chosen: the select never hides the id it will send.
    expect(picker).toHaveValue(OFFICIAL);
    expect(
      within(picker).getByRole('option', { name: 'Jordan Lee (official), chosen' }),
    ).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Record evidence' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/qualifications' && r.method === 'POST')?.body,
      ).toMatchObject({ personId: OFFICIAL }),
    );
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
