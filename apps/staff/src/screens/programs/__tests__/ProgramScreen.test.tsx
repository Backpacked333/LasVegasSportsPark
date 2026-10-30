/**
 * SCR-S-14 one program and "new draft offering" (SPK-CAT-001, SPK-CAT-002, SPK-YOUTH-002,
 * SPK-SCHED-008, §4.9, §4.5): offerings in every publication state in keyset pages with "Load
 * more", an offering created with every SPK-CAT-001 field and facility-local registration times,
 * edits with the expected revision, and a protected NOT_FOUND shown as not available.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';
import {
  ENTITLEMENT_ID,
  MANAGER_ID,
  OFFERING_ID,
  POLICY_CANCELLATION_ID,
  POLICY_ELIGIBILITY_ID,
  POLICY_FORM_ID,
  PROGRAM_ID,
  apiError,
  entitlement,
  nameRoutes,
  offering,
  ok,
  policy,
  program,
} from '../../../features/registration-finance/__tests__/fixtures';

const policies: FakeHandler = (request) => {
  const all = [
    policy(POLICY_ELIGIBILITY_ID, 'eligibility', 'Youth age bands'),
    policy(POLICY_CANCELLATION_ID, 'cancellation', 'Term cancellation'),
    policy(POLICY_FORM_ID, 'form', 'Medical consent'),
  ];
  return fakeResponse(200, {
    items: all.filter((p) => p.kind === request.query.kind),
    nextCursor: null,
  });
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...nameRoutes(),
    'GET /programs/{id}': ok(program()),
    'GET /programs/{id}/offerings': ok({
      items: [
        offering(),
        offering({
          id: `${OFFERING_ID.slice(0, -1)}9`,
          name: 'Spring academy U12',
          publicationState: 'registration_open',
        }),
      ],
      nextCursor: null,
    }),
    'GET /policy-versions': policies,
    'GET /entitlement-definitions': ok([entitlement()]),
    ...extra,
  };
}

describe('SCR-S-14 ProgramScreen', () => {
  it('shows the program and its offerings in every publication state', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(`/programs/${PROGRAM_ID}`));
    expect(await screen.findByRole('heading', { name: 'Spring academy' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Offerings' });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0]!).getByRole('link', { name: 'Spring academy U10' })).toHaveAttribute(
      'href',
      `/programs/offerings/${OFFERING_ID}`,
    );
    expect(within(items[0]!).getByText('draft')).toBeInTheDocument();
    expect(within(items[1]!).getByText('registration_open')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/North Park 1/)).toBeInTheDocument();
  });

  it('§4.5: pages the offerings with the API cursor, keeps them when Load more fails, and narrows by state', async () => {
    const user = userEvent.setup();
    let fail = true;
    const app = createTestApp({
      routes: routes({
        'GET /programs/{id}/offerings': (request) => {
          if (request.query.cursor !== 'f2') {
            return fakeResponse(200, { items: [offering()], nextCursor: 'f2' });
          }
          if (fail) {
            fail = false;
            return fakeResponse(503, {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Try later',
              correlationId: 'c',
              nextAction: 'retry_later',
            });
          }
          return fakeResponse(200, {
            items: [
              offering({
                id: `${OFFERING_ID.slice(0, -1)}9`,
                name: 'Spring academy U12',
                publicationState: 'registration_open',
              }),
            ],
            nextCursor: null,
          });
        },
      }),
    });
    render(app.at(`/programs/${PROGRAM_ID}`));
    const list = await screen.findByRole('list', { name: 'Offerings' });
    const rows = () => within(list).getAllByRole('listitem');
    expect(rows()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Load more offerings' }));
    expect(await screen.findByText(/Error code: SERVICE_UNAVAILABLE/)).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Load more offerings' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(list).getByRole('link', { name: 'Spring academy U12' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more offerings' })).toBeNull();
    const calls = app.fake.requests.filter((r) => r.route === '/programs/{id}/offerings');
    expect(calls.map((r) => r.query.cursor ?? null)).toEqual([null, 'f2', 'f2']);
    expect(calls[0]?.query).toMatchObject({ limit: '50' });
    // A state filter starts again from the first page of that state.
    await user.selectOptions(screen.getByLabelText('Publication state'), 'registration_open');
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/programs/{id}/offerings').at(-1)?.query,
      ).toEqual({ limit: '50', publicationState: 'registration_open' }),
    );
  });

  it('SPK-CAT-001: creates a draft offering with every required field and facility-local registration times', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /offerings': ok(offering(), 201),
        'GET /offerings/{id}/sessions': ok([]),
        'GET /offerings/{id}/price-rules': ok([]),
      }),
    });
    render(app.at(`/programs/${PROGRAM_ID}`));
    const form = await screen.findByRole('form', { name: 'New offering' });
    const f = within(form);
    await user.type(f.getByLabelText(/^Offering name/), 'Autumn term U10');
    await user.selectOptions(f.getByLabelText(/^Kind/), 'term');
    await user.selectOptions(await f.findByLabelText(/^Facility/), FACILITY_A);
    await user.type(f.getByLabelText(/^Format/), '7v7');
    await user.type(f.getByLabelText(/^Location/), 'Field 2');
    await user.type(f.getByLabelText(/^First date/), '2026-11-02');
    await user.type(f.getByLabelText(/^Last date/), '2026-12-14');
    const opens = f.getByLabelText(/^Registration opens \(facility time, America\/Los_Angeles\)/);
    await user.type(opens, '2026-10-20T09:00');
    await user.type(f.getByLabelText(/^Registration closes/), '2026-11-01T09:00');
    await user.selectOptions(await f.findByLabelText(/^Eligibility policy/), POLICY_ELIGIBILITY_ID);
    await waitFor(() => expect(f.getByRole('option', { name: 'Term seat' })).toBeInTheDocument());
    await user.selectOptions(f.getByLabelText(/^Participation entitlement/), ENTITLEMENT_ID);
    await user.selectOptions(f.getByLabelText(/^Cancellation policy/), POLICY_CANCELLATION_ID);
    await user.type(f.getByLabelText(/^Responsible manager/), MANAGER_ID);
    await user.click(f.getByLabelText('Medical consent (version 1)'));
    await user.click(f.getByRole('button', { name: 'Add a capacity unit' }));
    await user.selectOptions(f.getByLabelText('Unit 1'), 'camp_group_places');
    await user.type(f.getByLabelText('Unit 1 limit'), '24');
    await user.type(f.getByLabelText('Unit 1 group size'), '8');
    await user.type(f.getByLabelText('Unit 1 participants per staff member'), '8');
    await user.click(f.getByRole('button', { name: 'Create draft offering' }));

    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.method === 'POST' && r.route === '/offerings')).toBe(
        true,
      ),
    );
    const post = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/offerings');
    expect(post?.body).toEqual({
      programId: PROGRAM_ID,
      name: 'Autumn term U10',
      kind: 'term',
      facilityId: FACILITY_A,
      startsOn: '2026-11-02',
      endsOn: '2026-12-14',
      capacityUnits: [
        {
          unit: 'camp_group_places',
          limit: 24,
          groupSize: 8,
          staffingRatio: { participantsPerStaff: 8 },
        },
      ],
      requiredFormPolicyVersionIds: [POLICY_FORM_ID],
      location: { label: 'Field 2' },
      format: '7v7',
      registrationOpensAt: '2026-10-20T16:00:00.000Z',
      // Daylight saving time ends in Los Angeles on 2026-11-01: 09:00 local is 17:00 UTC.
      registrationClosesAt: '2026-11-01T17:00:00.000Z',
      eligibilityPolicyVersionId: POLICY_ELIGIBILITY_ID,
      cancellationPolicyVersionId: POLICY_CANCELLATION_ID,
      entitlementDefinitionId: ENTITLEMENT_ID,
      responsibleManagerPersonId: MANAGER_ID,
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    // The new draft opens on its setup screen.
    expect(await screen.findByRole('heading', { name: 'Spring academy U10' })).toBeInTheDocument();
  });

  it('refuses dates in the wrong order before sending anything', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(`/programs/${PROGRAM_ID}`));
    const form = await screen.findByRole('form', { name: 'New offering' });
    const f = within(form);
    await user.type(f.getByLabelText(/^First date/), '2026-12-14');
    await user.type(f.getByLabelText(/^Last date/), '2026-11-02');
    await user.click(f.getByRole('button', { name: 'Create draft offering' }));
    expect(f.getByText('The last date is before the first.')).toBeInTheDocument();
    expect(f.getByText('Enter a name.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('saves the program with its expected revision and offers Reload on STALE_REVISION', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /programs/{id}': apiError(409, 'STALE_REVISION', {
          message: 'The record changed since it was loaded.',
          nextAction: 'reload_and_retry',
        }),
      }),
    });
    render(app.at(`/programs/${PROGRAM_ID}`));
    await screen.findByRole('heading', { name: 'Spring academy' });
    await user.click(screen.getByText('Edit program definition'));
    const name = screen.getAllByLabelText(/^Program name/)[0]!;
    await user.clear(name);
    await user.type(name, 'Spring academy plus');
    await user.click(screen.getByRole('button', { name: 'Save program' }));
    expect(await screen.findByText('This record changed since it was loaded')).toBeInTheDocument();
    const patch = app.fake.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toMatchObject({ expectedRevision: 2, name: 'Spring academy plus' });
    expect(name).toHaveValue('Spring academy plus');
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/programs/{id}' && r.method === 'GET'),
      ).toHaveLength(2),
    );
  });

  it('a second save carries the revision the first save returned', async () => {
    const user = userEvent.setup();
    let saved = false;
    let patches = 0;
    const app = createTestApp({
      routes: routes({
        'GET /programs/{id}': () =>
          fakeResponse(200, program(saved ? { revision: 3, name: 'Spring academy plus' } : {})),
        'PATCH /programs/{id}': () => {
          patches += 1;
          saved = true;
          return fakeResponse(200, program({ revision: 2 + patches, name: 'Spring academy plus' }));
        },
      }),
    });
    render(app.at(`/programs/${PROGRAM_ID}`));
    await screen.findByRole('heading', { name: 'Spring academy' });
    await user.click(screen.getByText('Edit program definition'));
    const name = screen.getAllByLabelText(/^Program name/)[0]!;
    await user.clear(name);
    await user.type(name, 'Spring academy plus');
    await user.click(screen.getByRole('button', { name: 'Save program' }));
    await screen.findByRole('heading', { name: 'Spring academy plus' });
    await user.click(screen.getByRole('button', { name: 'Save program' }));
    await waitFor(() => expect(patches).toBe(2));
    const [first, second] = app.fake.requests.filter((r) => r.method === 'PATCH');
    expect(first?.body).toMatchObject({ expectedRevision: 2 });
    expect(second?.body).toMatchObject({ expectedRevision: 3 });
  });

  it('shows a protected NOT_FOUND as not available, without implying the program exists', async () => {
    const app = createTestApp({
      routes: {
        'GET /programs/{id}': apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      },
    });
    render(app.at(`/programs/${PROGRAM_ID}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New offering' })).toBeNull();
  });
});
