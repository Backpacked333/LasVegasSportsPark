/**
 * SCR-S-19 Youth group placement (SPK-YOUTH-002 group size, space and staffing; raising commercial
 * capacity never bypasses staffing; SPK-YOUTH-006 progression; §4.14 child data minimized;
 * DEC-003 / DEC-055 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { capabilityDisabledBody, fakeResponse } from '@sportspark/api-client/testing';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  ID,
  created,
  fail,
  ok,
  page,
  personNames,
  recommendation,
} from '../../../features/competition/__tests__/fixtures';
import { groupPools } from '../YouthGroupsScreen';

function pool(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.poolCommercial,
    offeringId: ID.offering,
    scopeType: 'camp_group',
    scopeId: ID.group,
    unit: 'camp_group_places',
    constraintKind: 'commercial',
    capacity: 20,
    committed: 10,
    held: 2,
    available: 8,
    participantsPerStaff: null,
    staffCount: null,
    status: 'active',
    revision: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const staffing = pool({
  id: ID.poolStaffing,
  constraintKind: 'staffing',
  capacity: 12,
  available: 0,
  participantsPerStaff: 6,
  staffCount: 2,
  revision: 5,
});

const offering = {
  id: ID.offering,
  programId: ID.competition,
  facilityId: '0192f1a0-0000-7000-8000-00000000fa01',
  name: 'Summer camp week 1',
  description: null,
  kind: 'camp',
  activityType: 'soccer',
  format: null,
  locationLabel: null,
  startsOn: '2026-07-06',
  endsOn: '2026-07-10',
  registrationOpensAt: null,
  registrationClosesAt: null,
  publicationState: 'registration_open',
  ageBand: {},
  capacity: [],
  price: null,
  eligibilityPolicyVersionId: null,
  cancellationPolicyVersionId: null,
  requiredFormPolicyVersionIds: [],
  entitlementDefinitionId: null,
  staff: {
    location: {},
    eligibilityReferenceDate: '2026-07-06',
    capacityUnits: [
      {
        unit: 'camp_group_places',
        limit: 20,
        groupSize: 10,
        staffingRatio: { participantsPerStaff: 6 },
      },
    ],
    responsibleManagerPersonId: null,
    copiedFromOfferingId: null,
    publishedAt: null,
    registrationOpenedAt: null,
    closedAt: null,
    archivedAt: null,
    revision: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  },
};

const enrollment = {
  id: ID.enrollment,
  offeringId: ID.offering,
  participantPersonId: ID.child,
  status: 'confirmed',
};

const routes = {
  'GET /offerings': ok(page([offering])),
  'GET /offerings/{id}': ok(offering),
  'GET /capacity-pools': ok([pool(), staffing]),
  'GET /enrollments': ok(page([enrollment])),
  'GET /person-names': personNames({ [ID.child]: ['Mia', 'Camper'] }),
};

async function openOffering(extra: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const app = createTestApp({ routes: { ...routes, ...(extra as typeof routes) } });
  render(app.at('/teams/youth-groups'));
  await user.selectOptions(await screen.findByLabelText('Offering kind'), 'camp');
  await waitFor(() =>
    expect(screen.getByRole('option', { name: 'Summer camp week 1' })).toBeInTheDocument(),
  );
  await user.selectOptions(screen.getByLabelText('Offering'), ID.offering);
  return { app, user };
}

describe('SCR-S-19 youth group capacity model (SPK-YOUTH-002)', () => {
  it('takes the smallest availability across a group’s pools and names the limit', () => {
    const [group] = groupPools([pool(), staffing] as never);
    expect(group?.available).toBe(0);
    expect(group?.limitedBy).toBe('staffing');
  });

  it('ignores closed pools and never reports infinite availability', () => {
    const [group] = groupPools([pool({ status: 'closed' })] as never);
    expect(group?.available).toBe(0);
    expect(group?.limitedBy).toBeNull();
  });
});

describe('SCR-S-19 YouthGroupsScreen (SPK-YOUTH-002, SPK-YOUTH-006)', () => {
  it('shows a group’s commercial and staffing limits side by side, bound by staffing', async () => {
    const { app } = await openOffering();
    const groups = await screen.findByRole('list', { name: 'Groups' });
    const group = within(groups).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(group).getByText('0 places available now')).toBeInTheDocument();
    expect(within(group).getByText(/limited by: Staffing requirement/)).toBeInTheDocument();
    expect(within(group).getByText('2 staff × 6 each')).toBeInTheDocument();
    expect(
      within(group).getByText(/Raising the commercial capacity never raises the staffing/),
    ).toBeInTheDocument();
    expect(screen.getByText(/groups of 10, 6 participants per staff member/)).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/offerings' && r.query.kind === 'camp')).toBe(
      true,
    );
  });

  it('changes a staffing pool through its staff count with a reason and the expected revision', async () => {
    const { app, user } = await openOffering();
    app.fake.set(
      'POST /capacity-pools/{id}/adjust',
      ok({ ...staffing, staffCount: 3, capacity: 18, available: 6 }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Change the staff count: Staffing requirement' }),
    );
    const form = screen.getByRole('form', { name: 'Change the staff count' });
    expect(within(form).getByText(/Capacity becomes the staff count × 6/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Staff count/), '3');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByText('Give the reason for the change.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Reason/), 'Third coach confirmed.');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Capacity 18, 6 available')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.params).toEqual({ id: ID.poolStaffing });
    expect(post?.body).toEqual({
      expectedRevision: 5,
      reason: 'Third coach confirmed.',
      staffCount: 3,
    });
  });

  it('shows a capacity below commitments as the API’s conflict with its code', async () => {
    const { app, user } = await openOffering();
    app.fake.set(
      'POST /capacity-pools/{id}/adjust',
      fail(409, 'RESOURCE_CONFLICT', 'resolve_conflict', {
        message: 'Capacity cannot drop below the 12 places already committed or held.',
      }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Change the capacity: Commercial limit' }),
    );
    const form = screen.getByRole('form', { name: 'Change the capacity' });
    await user.type(within(form).getByLabelText(/^Capacity/), '5');
    await user.type(within(form).getByLabelText(/^Reason/), 'Smaller room.');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(form).findByText(
        'Capacity cannot drop below the 12 places already committed or held.',
      ),
    ).toBeInTheDocument();
    expect(within(form).getByText(/Error code: RESOURCE_CONFLICT/)).toBeInTheDocument();
  });

  it('lists enrolled children by name only; group assignment is not available and progression is turned off', async () => {
    const { app } = await openOffering();
    const children = await screen.findByRole('list', { name: 'Enrolled children' });
    expect(await within(children).findByText('Mia Camper')).toBeInTheDocument();
    expect(screen.queryByText(/2016-05-04/)).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/people/{id}')).toBe(false);
    expect(screen.getByText('Assigning a child to a group: not available')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-055/)).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-003/)).toBeInTheDocument();
    // youth_progression starts off (DEC-016): nothing is offered.
    expect(await screen.findByText('Progression recommendations turned off')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Draft a progression recommendation' })).toBeNull();
  });

  it('shows the pools as not available to an account without the permission', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /capacity-pools': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
      },
    });
    render(app.at('/teams/youth-groups'));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Summer camp week 1' })).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText('Offering'), ID.offering);
    const panel = await screen.findByRole('region', { name: 'Groups and capacity' });
    expect(await within(panel).findByText('Not available')).toBeInTheDocument();
  });
});

describe('SCR-S-19 progression recommendations (SPK-YOUTH-006, ENR-14, DEC-055)', () => {
  const next = { ...offering, id: ID.offering2, name: 'Summer camp week 2' };
  const on = {
    'GET /me/permissions': mePermissions({ enabled: ['youth_progression'] }),
    'GET /offerings': (req: { query: Record<string, string> }) =>
      fakeResponse(200, page(req.query.kind ? [offering] : [offering, next])),
    'GET /programs': ok(page([])),
  };

  it('drafts a recommendation for a child, then shares it with the expected revision', async () => {
    const { app, user } = await openOffering({
      ...on,
      'POST /progression-recommendations': created(recommendation()),
      'POST /progression-recommendations/{id}/share': ok(
        recommendation({ status: 'shared', sharedAt: '2026-10-24T12:00:00.000Z', revision: 2 }),
      ),
    });
    const form = await screen.findByRole('form', { name: 'Draft a progression recommendation' });
    await user.click(within(form).getByRole('button', { name: 'Draft the recommendation' }));
    expect(within(form).getByText('Choose the child.')).toBeInTheDocument();
    expect(
      within(form).getByText('Choose whether you recommend an offering or a program.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/progression-recommendations')).toBe(false);
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'Mia Camper' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(form).getByLabelText(/^Child/), ID.child);
    await user.selectOptions(within(form).getByLabelText(/^Recommend\b/), 'offering');
    const target = within(form).getByLabelText(/^Recommended offering/);
    // The offering the child is in is not offered as its own next step.
    expect(within(target).queryByRole('option', { name: 'Summer camp week 1' })).toBeNull();
    await user.selectOptions(target, ID.offering2);
    await user.type(within(form).getByLabelText(/^Suitability/), 'Ready for the next level.');
    await user.click(within(form).getByRole('button', { name: 'Draft the recommendation' }));
    const made = await screen.findByRole('list', { name: 'Recommendations made here' });
    expect(within(made).getByText('Recommendation draft')).toBeInTheDocument();
    expect(within(made).getByText('Not visible to the family until shared.')).toBeVisible();
    expect(within(made).getByTestId('eligibility-summary')).toHaveTextContent('Eligible');
    expect(app.fake.requests.find((r) => r.route === '/progression-recommendations')?.body).toEqual(
      {
        participantPersonId: ID.child,
        fromOfferingId: ID.offering,
        suitability: 'Ready for the next level.',
        recommendedOfferingId: ID.offering2,
      },
    );
    await user.click(within(made).getByRole('button', { name: 'Share with the family' }));
    expect(await within(made).findByText('Recommendation shared')).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/progression-recommendations/{id}/share')?.body,
    ).toEqual({ expectedRevision: 1 });
  });

  it('never shows unknown eligibility evidence as eligible, and withdraws only with a reason', async () => {
    const unknown = recommendation({
      eligibility: {
        eligible: true,
        evaluatedAt: '2026-10-24T12:00:00.000Z',
        reasons: [
          {
            code: 'forms.unknown',
            severity: 'unknown',
            message: 'Required forms could not be checked.',
            source: { type: 'form', id: null },
            requiredAction: 'Check the forms.',
          },
        ],
        alternatives: [],
      },
    });
    const { app, user } = await openOffering({
      ...on,
      'POST /progression-recommendations': created(unknown),
      'POST /progression-recommendations/{id}/withdraw': ok({ ...unknown, status: 'withdrawn' }),
    });
    const form = await screen.findByRole('form', { name: 'Draft a progression recommendation' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'Mia Camper' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(form).getByLabelText(/^Child/), ID.child);
    await user.selectOptions(within(form).getByLabelText(/^Recommend\b/), 'offering');
    await user.selectOptions(within(form).getByLabelText(/^Recommended offering/), ID.offering2);
    await user.type(within(form).getByLabelText(/^Suitability/), 'Strong skills.');
    await user.click(within(form).getByRole('button', { name: 'Draft the recommendation' }));
    const made = await screen.findByRole('list', { name: 'Recommendations made here' });
    const eligibility = within(made).getByTestId('recommendation-eligibility');
    // The summary badge itself (not the reason rows) reads unknown, never "Eligible", although
    // the recorded evaluation says eligible: true with an unknown-severity reason (DEC-055).
    expect(within(eligibility).getByTestId('eligibility-summary')).toHaveTextContent(
      'Unknown or stale evidence',
    );
    expect(within(eligibility).getByTestId('eligibility-summary')).not.toHaveTextContent(
      'Eligible',
    );
    expect(within(eligibility).queryByText('Eligible')).toBeNull();
    await user.click(within(made).getByRole('button', { name: 'Withdraw' }));
    const withdraw = within(made).getByRole('form', { name: 'Withdraw the recommendation' });
    await user.click(within(withdraw).getByRole('button', { name: 'Withdraw the recommendation' }));
    expect(
      within(withdraw).getByText('Give the reason for withdrawing the recommendation.'),
    ).toBeInTheDocument();
    await user.type(within(withdraw).getByLabelText(/^Reason/), 'Recommended in error.');
    await user.click(within(withdraw).getByRole('button', { name: 'Withdraw the recommendation' }));
    expect(await within(made).findByText('Recommendation withdrawn')).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/progression-recommendations/{id}/withdraw')?.body,
    ).toEqual({ reason: 'Recommended in error.' });
  });

  it('shows the turned-off state when the API refuses with CAPABILITY_DISABLED', async () => {
    const { user } = await openOffering({
      ...on,
      'POST /progression-recommendations': () =>
        fakeResponse(403, capabilityDisabledBody('youth_progression', ['DEC-016'])),
    });
    const form = await screen.findByRole('form', { name: 'Draft a progression recommendation' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'Mia Camper' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(form).getByLabelText(/^Child/), ID.child);
    await user.selectOptions(within(form).getByLabelText(/^Recommend\b/), 'offering');
    await user.selectOptions(within(form).getByLabelText(/^Recommended offering/), ID.offering2);
    await user.type(within(form).getByLabelText(/^Suitability/), 'Strong skills.');
    await user.click(within(form).getByRole('button', { name: 'Draft the recommendation' }));
    expect(
      await within(form).findByText('Youth assessments and progression turned off'),
    ).toBeInTheDocument();
  });

  it('keeps a recommendation made here withdrawable when the switch turns off (withdraw is never gated)', async () => {
    const { app, user } = await openOffering({
      ...on,
      'POST /progression-recommendations': created(recommendation()),
      'POST /progression-recommendations/{id}/share': () =>
        fakeResponse(403, capabilityDisabledBody('youth_progression', ['DEC-016'])),
      'POST /progression-recommendations/{id}/withdraw': ok(
        recommendation({ status: 'withdrawn', revision: 2 }),
      ),
    });
    const form = await screen.findByRole('form', { name: 'Draft a progression recommendation' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'Mia Camper' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(form).getByLabelText(/^Child/), ID.child);
    await user.selectOptions(within(form).getByLabelText(/^Recommend\b/), 'offering');
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'Summer camp week 2' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(form).getByLabelText(/^Recommended offering/), ID.offering2);
    await user.type(within(form).getByLabelText(/^Suitability/), 'Strong skills.');
    await user.click(within(form).getByRole('button', { name: 'Draft the recommendation' }));
    const made = await screen.findByRole('list', { name: 'Recommendations made here' });
    // The organization turns the switch off; sharing answers CAPABILITY_DISABLED and the
    // permissions read is refreshed.
    app.fake.set('GET /me/permissions', mePermissions());
    await user.click(within(made).getByRole('button', { name: 'Share with the family' }));
    expect(await screen.findByText('Progression recommendations turned off')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Draft a progression recommendation' })).toBeNull(),
    );
    const still = screen.getByRole('list', { name: 'Recommendations made here' });
    expect(within(still).queryByRole('button', { name: 'Share with the family' })).toBeNull();
    expect(
      screen.getByText(/Recommendations made on this page stay listed and can still be withdrawn/),
    ).toBeVisible();
    await user.click(within(still).getByRole('button', { name: 'Withdraw' }));
    const withdraw = within(still).getByRole('form', { name: 'Withdraw the recommendation' });
    await user.type(within(withdraw).getByLabelText(/^Reason/), 'Offered in error.');
    await user.click(within(withdraw).getByRole('button', { name: 'Withdraw the recommendation' }));
    expect(await within(still).findByText('Recommendation withdrawn')).toBeInTheDocument();
  });

  it('pages the offerings to recommend with Load more and offers only active programs', async () => {
    const third = { ...offering, id: ID.offering3, name: 'Autumn term' };
    const { app, user } = await openOffering({
      ...on,
      'GET /offerings': (req: { query: Record<string, string> }) =>
        fakeResponse(
          200,
          req.query.kind
            ? page([offering])
            : req.query.cursor
              ? page([third])
              : page([offering, next], 'more-offerings'),
        ),
      'GET /programs': ok(page([{ id: ID.program, name: 'Junior pathway' }])),
    });
    const form = await screen.findByRole('form', { name: 'Draft a progression recommendation' });
    await user.selectOptions(within(form).getByLabelText(/^Recommend\b/), 'offering');
    const select = within(form).getByLabelText(/^Recommended offering/);
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Summer camp week 2' })).toBeVisible(),
    );
    expect(within(select).queryByRole('option', { name: 'Autumn term' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Load more offerings' }));
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Autumn term' })).toBeInTheDocument(),
    );
    expect(
      app.fake.requests.some(
        (r) => r.route === '/offerings' && r.query.cursor === 'more-offerings',
      ),
    ).toBe(true);
    await user.selectOptions(within(form).getByLabelText(/^Recommend\b/), 'program');
    await waitFor(() =>
      expect(
        within(within(form).getByLabelText(/^Recommended program/)).getByRole('option', {
          name: 'Junior pathway',
        }),
      ).toBeInTheDocument(),
    );
    expect(app.fake.requests.find((r) => r.route === '/programs')?.query.status).toBe('active');
  });

  it('shows ACCESS_DENIED for an account that is not the offering’s author as not available', async () => {
    const { user } = await openOffering({
      ...on,
      'POST /progression-recommendations': fail(
        403,
        'ACCESS_DENIED',
        'contact_support_or_request_access',
      ),
    });
    const form = await screen.findByRole('form', { name: 'Draft a progression recommendation' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'Mia Camper' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(form).getByLabelText(/^Child/), ID.child);
    await user.selectOptions(within(form).getByLabelText(/^Recommend\b/), 'offering');
    await user.selectOptions(within(form).getByLabelText(/^Recommended offering/), ID.offering2);
    await user.type(within(form).getByLabelText(/^Suitability/), 'Strong skills.');
    await user.click(within(form).getByRole('button', { name: 'Draft the recommendation' }));
    expect(await within(form).findByText('Not available to you')).toBeInTheDocument();
  });
});
