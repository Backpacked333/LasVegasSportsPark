/**
 * SCR-S-46 Accounts, roles and permissions: §2.1 role assignments with facility scope and time
 * bounds listed from `GET /v1/staff-memberships` (ID-05), §4.14 audited privileged changes (the API
 * decides who may make them; ACCESS_DENIED is shown with its message; commands are offered only
 * when `GET /v1/me/permissions` lists identity.manage_staff_membership), §4.9 idempotency keys and
 * expected revisions, STALE_REVISION with a Reload that re-reads the membership, the audit history
 * on request, DEC-018 multifactor status pending, child records never named.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_1,
  NOW_ISO,
  PERSON_1,
  auditRecord,
  facilityList,
  ok,
  page,
  staffMembership,
  staffMembershipView,
} from '../../../features/insight-admin/__tests__/fixtures';
import { formatInstant } from '../../../features/insight-admin/format';
import { FACILITY_A, createTestApp, mePermissions, staffMe } from '../../../testing/test-app';

const MANAGER = mePermissions({
  staffRoles: ['system_administrator'],
  actions: ['identity.manage_staff_membership', 'identity.read_staff_membership'],
});

function app(routes: Record<string, FakeHandler> = {}) {
  return createTestApp({
    routes: {
      'GET /facilities': facilityList(),
      'GET /me/permissions': MANAGER,
      'GET /staff-memberships': page([]),
      ...routes,
    },
  });
}

async function assign(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByRole('form', { name: 'Assign staff roles' });
  await user.type(within(form).getByLabelText('Person id (required)'), PERSON_1);
  await user.click(within(form).getByRole('checkbox', { name: 'Scheduler' }));
  await within(form).findByRole('checkbox', { name: 'North Park 1' });
  await user.click(within(form).getByRole('checkbox', { name: 'North Park 1' }));
  await user.type(within(form).getByLabelText('Reason'), 'New scheduler');
  await user.click(within(form).getByRole('button', { name: 'Assign roles' }));
}

async function listedMembership() {
  const list = await screen.findByRole('list', { name: 'Staff memberships' });
  return within(list).getAllByRole('listitem')[0] as HTMLElement;
}

describe('SCR-S-46 AccountsRolesScreen', () => {
  it('shows your roles, facility scope and memberships from the API', async () => {
    const me = staffMe([FACILITY_A]);
    (me.body as { staffMemberships: unknown[] }).staffMemberships = [
      staffMembership({ roles: ['general_manager'], effectiveTo: '2027-01-01T00:00:00.000Z' }),
    ];
    render(app({ 'GET /me': me }).at('/admin/accounts'));
    const section = await screen.findByRole('region', { name: 'Your access' });
    expect(await within(section).findByText('General manager')).toBeInTheDocument();
    expect(await within(section).findByText('North Park 1')).toBeInTheDocument();
    const memberships = within(section).getByRole('list', { name: 'Your staff memberships' });
    expect(within(memberships).getByText('active')).toBeInTheDocument();
    expect(
      within(memberships).getByText((text) =>
        text.includes(`until ${formatInstant('2027-01-01T00:00:00.000Z')}`),
      ),
    ).toBeInTheDocument();
  });

  it('DEC-018: multifactor status waits on the identity provider; the audit is linked', async () => {
    render(app().at('/admin/accounts'));
    const note = await screen.findByTestId('pending-note');
    expect(note).toHaveTextContent('Multifactor status for privileged staff is not shown');
    expect(note).toHaveTextContent('DEC-018');
    expect(screen.getByRole('link', { name: 'audit records' })).toHaveAttribute(
      'href',
      '/admin/audit',
    );
    expect(screen.queryByText('Not available yet')).toBeNull();
  });

  it('ID-05: lists staff memberships with the API display name, scope and status', async () => {
    const test = app({ 'GET /staff-memberships': page([staffMembershipView()]) });
    render(test.at('/admin/accounts'));
    const row = await listedMembership();
    expect(
      within(row).getByText(`Alex Rivera · Membership ${MEMBERSHIP_1.slice(0, 8)}: Scheduler`),
    ).toBeInTheDocument();
    expect(within(row).getByText('active')).toBeInTheDocument();
    expect(await within(row).findByText('Facility scope: North Park 1')).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/staff-memberships')?.query).toMatchObject({
      status: 'active',
      limit: '25',
    });
  });

  it('filters memberships by role, facility and status and pages with the cursor', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /staff-memberships': (request) =>
        request.query.cursor
          ? fakeResponse(200, {
              items: [staffMembershipView({ id: PERSON_1, personDisplayName: null })],
              nextCursor: null,
            })
          : fakeResponse(200, { items: [staffMembershipView()], nextCursor: 'next-1' }),
    });
    render(test.at('/admin/accounts'));
    await listedMembership();
    await user.click(screen.getByRole('button', { name: 'Load more staff memberships' }));
    expect(await screen.findByText(/^Name not available · Membership/)).toBeInTheDocument();
    const filters = screen.getByRole('form', { name: 'Filter staff memberships' });
    await user.selectOptions(within(filters).getByLabelText('Role'), 'scheduler');
    await within(filters).findByRole('option', { name: 'North Park 1' });
    await user.selectOptions(within(filters).getByLabelText(/^Facility/), FACILITY_A);
    await user.selectOptions(within(filters).getByLabelText('Status'), 'ended');
    await user.click(within(filters).getByRole('button', { name: 'Show memberships' }));
    await waitFor(() =>
      expect(
        test.fake.requests.some(
          (r) =>
            r.route === '/staff-memberships' &&
            r.query.role === 'scheduler' &&
            r.query.facilityId === FACILITY_A &&
            r.query.status === 'ended',
        ),
      ).toBe(true),
    );
  });

  it('validates the person filter before sending it', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/accounts'));
    const filters = await screen.findByRole('form', { name: 'Filter staff memberships' });
    await user.type(within(filters).getByLabelText('Person id'), 'not-an-id');
    await user.click(within(filters).getByRole('button', { name: 'Show memberships' }));
    expect(within(filters).getByText('Enter a full person id.')).toBeInTheDocument();
    expect(
      test.fake.requests.some((r) => r.route === '/staff-memberships' && r.query.personId),
    ).toBe(false);
  });

  it('empty state: says the first system administrator assigns the first roles', async () => {
    const user = userEvent.setup();
    render(app().at('/admin/accounts'));
    const filters = await screen.findByRole('form', { name: 'Filter staff memberships' });
    await user.selectOptions(within(filters).getByLabelText('Status'), '');
    await user.click(within(filters).getByRole('button', { name: 'Show memberships' }));
    expect(await screen.findByText('No staff memberships yet')).toBeInTheDocument();
  });

  it('shows a membership list the API refuses as not available to you, with its message', async () => {
    render(
      app({
        'GET /staff-memberships': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'You are not permitted to list memberships.',
            }),
          ),
      }).at('/admin/accounts'),
    );
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/You are not permitted to list memberships\./)).toBeInTheDocument();
  });

  it('offers no assignment or change without identity.manage_staff_membership', async () => {
    render(
      app({
        'GET /me/permissions': mePermissions({ actions: ['identity.read_staff_membership'] }),
        'GET /staff-memberships': page([staffMembershipView()]),
      }).at('/admin/accounts'),
    );
    const row = await listedMembership();
    expect(
      await screen.findByText(/Assigning, changing and ending staff roles is not available to you/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Assign staff roles' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Change roles or scope' })).toBeNull();
  });

  it('assigns roles with facility scope, a reason and an idempotency key, then lists it', async () => {
    const user = userEvent.setup();
    let assigned = false;
    const test = app({
      'POST /staff-memberships': () => {
        assigned = true;
        return fakeResponse(201, staffMembership());
      },
      'GET /staff-memberships': () =>
        fakeResponse(200, { items: assigned ? [staffMembershipView()] : [], nextCursor: null }),
    });
    render(test.at('/admin/accounts'));
    await assign(user);
    expect(
      await screen.findByText(`Membership ${MEMBERSHIP_1.slice(0, 8)} active`),
    ).toBeInTheDocument();
    const post = test.fake.requests.find((r) => r.route === '/staff-memberships' && r.body);
    expect(post?.body).toEqual({
      personId: PERSON_1,
      roles: ['scheduler'],
      facilityIds: [FACILITY_A],
      reason: 'New scheduler',
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    const row = await listedMembership();
    expect(within(row).getByText(/Alex Rivera/)).toBeInTheDocument();
  });

  it('validates before sending: a person id and at least one role', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/accounts'));
    await user.click(await screen.findByRole('button', { name: 'Assign roles' }));
    expect(screen.getByText('Enter the person id.')).toBeInTheDocument();
    expect(screen.getByText('Choose at least one role.')).toBeInTheDocument();
    expect(test.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('shows a refused role change as not available to you, with the API message, and keeps the input', async () => {
    const user = userEvent.setup();
    render(
      app({
        'POST /staff-memberships': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'You are not permitted to perform this action.',
              nextAction: 'contact_support_or_request_access',
            }),
          ),
      }).at('/admin/accounts'),
    );
    await assign(user);
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText('You are not permitted to perform this action.')).toBeInTheDocument();
    expect(screen.getByLabelText('Person id (required)')).toHaveValue(PERSON_1);
  });

  it('§4.9: a stale change offers Reload, re-reads the membership and saves with its revision', async () => {
    const user = userEvent.setup();
    let patches = 0;
    const test = app({
      'GET /staff-memberships': page([staffMembershipView()]),
      'GET /staff-memberships/{id}': ok(staffMembershipView({ revision: 2 })),
      'PATCH /staff-memberships/{id}': () => {
        patches += 1;
        return patches === 1
          ? fakeResponse(
              409,
              apiErrorBody('STALE_REVISION', {
                nextAction: 'reload_and_retry',
                message: 'The record changed.',
              }),
            )
          : fakeResponse(200, staffMembership({ roles: ['scheduler', 'front_desk'], revision: 3 }));
      },
    });
    render(test.at('/admin/accounts'));
    const row = await listedMembership();
    await user.click(within(row).getByRole('button', { name: 'Change roles or scope' }));
    const form = within(row).getByRole('form', {
      name: `Change membership ${MEMBERSHIP_1.slice(0, 8)}`,
    });
    await user.click(within(form).getByRole('checkbox', { name: 'Front desk' }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(
      await within(form).findByText('Error code: STALE_REVISION. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Reload' }));
    expect(await within(row).findByText(/Reloaded: revision 2/)).toBeInTheDocument();
    // What was typed is kept for the second attempt.
    expect(within(form).getByRole('checkbox', { name: 'Front desk' })).toBeChecked();
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toBe(2));
    const sent = test.fake.requests.filter(
      (r) => r.method === 'PATCH' && r.route === '/staff-memberships/{id}',
    );
    expect(sent[0]?.body).toEqual({
      roles: ['scheduler', 'front_desk'],
      facilityIds: [FACILITY_A],
      expectedRevision: 1,
    });
    expect(sent[1]?.body).toMatchObject({ expectedRevision: 2 });
    expect(sent[1]?.headers['idempotency-key']).not.toBe(sent[0]?.headers['idempotency-key']);
    expect(await within(row).findByText('Changes saved')).toBeInTheDocument();
  });

  it('ends a membership with a reason and the expected revision', async () => {
    const user = userEvent.setup();
    let ended = false;
    const test = app({
      'GET /staff-memberships': () =>
        fakeResponse(200, {
          items: [
            staffMembershipView(
              ended ? { status: 'ended', effectiveTo: NOW_ISO, revision: 2 } : {},
            ),
          ],
          nextCursor: null,
        }),
      'POST /staff-memberships/{id}/end': () => {
        ended = true;
        return fakeResponse(
          200,
          staffMembership({ status: 'ended', effectiveTo: NOW_ISO, revision: 2 }),
        );
      },
    });
    render(test.at('/admin/accounts'));
    const row = await listedMembership();
    await user.click(within(row).getByRole('button', { name: 'End membership' }));
    await user.click(within(row).getByRole('button', { name: 'End membership now' }));
    expect(
      within(row).getByText('Enter the reason for ending this membership.'),
    ).toBeInTheDocument();
    await user.type(
      within(row).getByLabelText('Reason for ending (required)'),
      'Left the organization',
    );
    await user.click(within(row).getByRole('button', { name: 'End membership now' }));
    expect(await within(await listedMembership()).findByText('ended')).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/staff-memberships/{id}/end')?.body).toEqual(
      { reason: 'Left the organization', expectedRevision: 1 },
    );
  });

  it('ending a membership changed by another administrator is refused as STALE_REVISION with Reload', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /staff-memberships': page([staffMembershipView()]),
      'GET /staff-memberships/{id}': ok(staffMembershipView({ revision: 2 })),
      'POST /staff-memberships/{id}/end': () =>
        fakeResponse(
          409,
          apiErrorBody('STALE_REVISION', {
            message: 'The record changed since it was loaded.',
            nextAction: 'reload_and_retry',
          }),
        ),
    });
    render(test.at('/admin/accounts'));
    const row = await listedMembership();
    await user.click(within(row).getByRole('button', { name: 'End membership' }));
    await user.type(
      within(row).getByLabelText('Reason for ending (required)'),
      'Left the organization',
    );
    await user.click(within(row).getByRole('button', { name: 'End membership now' }));
    expect(await within(row).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(test.fake.requests.some((r) => r.route === '/staff-memberships/{id}')).toBe(true),
    );
    expect(within(row).getByLabelText('Reason for ending (required)')).toHaveValue(
      'Left the organization',
    );
  });

  it('§4.14: reads a membership audit history only when asked', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /staff-memberships': page([staffMembershipView()]),
      'GET /audit-records': page([auditRecord(1)]),
      'GET /person-names': ok({ items: [] }),
    });
    render(test.at('/admin/accounts'));
    const row = await listedMembership();
    expect(test.fake.requests.some((r) => r.route === '/audit-records')).toBe(false);
    await user.click(
      within(row).getByRole('button', {
        name: `Show audit history of membership ${MEMBERSHIP_1.slice(0, 8)}`,
      }),
    );
    const history = await within(row).findByRole('list', {
      name: `Audit history of membership ${MEMBERSHIP_1.slice(0, 8)}`,
    });
    expect(within(history).getByText(/identity\.manage_staff_membership/)).toBeInTheDocument();
    expect(within(history).getByText('Reason: Role change approved')).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/audit-records')?.query).toMatchObject({
      targetType: 'staff_membership',
      targetId: MEMBERSHIP_1,
    });
  });

  it('never names a child person record when checking a person id', async () => {
    const user = userEvent.setup();
    render(
      app({
        'GET /people/{id}': ok({
          id: PERSON_1,
          kind: 'child',
          givenName: 'Childname',
          familyName: 'Surname',
          dateOfBirth: '2016-05-01',
          status: 'active',
          mergedIntoPersonId: null,
          revision: 1,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          contactPoints: [],
        }),
      }).at('/admin/accounts'),
    );
    await user.type(await screen.findByLabelText('Person id (required)'), PERSON_1);
    await user.click(screen.getByRole('button', { name: 'Check person' }));
    expect(await screen.findByText('Not an adult person')).toBeInTheDocument();
    expect(screen.queryByText(/Childname/)).toBeNull();
    expect(screen.queryByText(/2016-05-01/)).toBeNull();
  });

  it('shows a person the viewer may not see as not available', async () => {
    const user = userEvent.setup();
    render(app().at('/admin/accounts'));
    await user.type(await screen.findByLabelText('Person id (required)'), PERSON_1);
    await user.click(screen.getByRole('button', { name: 'Check person' }));
    await waitFor(() =>
      expect(screen.getByTestId('state-unavailable')).toHaveTextContent('Not available'),
    );
  });
});
