/**
 * SCR-S-19 Youth group placement (SPK-YOUTH-002 group size, space and staffing; raising commercial
 * capacity never bypasses staffing; SPK-YOUTH-006 progression; §4.14 child data minimized;
 * DEC-003 / DEC-055 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import { ID, fail, ok, page, person } from '../../../features/competition/__tests__/fixtures';
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
  'GET /people/{id}': ok(person(ID.child, 'Mia', 'Camper')),
};

async function openOffering() {
  const user = userEvent.setup();
  const app = createTestApp({ routes });
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

  it('lists enrolled children by name only and shows group assignment and progression as not available', async () => {
    await openOffering();
    const children = await screen.findByRole('list', { name: 'Enrolled children' });
    expect(await within(children).findByText('Mia Camper')).toBeInTheDocument();
    expect(screen.queryByText(/2016-05-04/)).toBeNull();
    expect(screen.getByText('Assigning a child to a group: not available yet')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-055/)).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-003/)).toBeInTheDocument();
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
