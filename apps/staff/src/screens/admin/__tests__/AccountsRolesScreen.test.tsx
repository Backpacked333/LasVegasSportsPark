/**
 * SCR-S-46 Accounts, roles and permissions: §2.1 role assignments with facility scope and time
 * bounds, §4.14 audited privileged changes (the API decides who may make them; ACCESS_DENIED is
 * shown with its message), §4.9 idempotency keys and expected revisions, STALE_REVISION kept
 * honest, DEC-018 multifactor status pending, API gaps named, child records never named.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_1,
  NOW_ISO,
  PERSON_1,
  ok,
  staffMembership,
} from '../../../features/insight-admin/__tests__/fixtures';
import { formatInstant } from '../../../features/insight-admin/format';
import { FACILITY_A, createTestApp, staffMe } from '../../../testing/test-app';

function app(routes: Record<string, FakeHandler> = {}) {
  return createTestApp({ routes });
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

describe('SCR-S-46 AccountsRolesScreen', () => {
  it('shows your roles, facility scope and memberships from the API', async () => {
    const me = staffMe([FACILITY_A]);
    (me.body as { staffMemberships: unknown[] }).staffMemberships = [
      staffMembership({ roles: ['general_manager'], effectiveTo: '2027-01-01T00:00:00.000Z' }),
    ];
    render(createTestApp({ routes: { 'GET /me': me } }).at('/admin/accounts'));
    const section = await screen.findByRole('region', { name: 'Your access' });
    expect(await within(section).findByText('General manager')).toBeInTheDocument();
    expect(within(section).getByText('North Park 1')).toBeInTheDocument();
    const memberships = within(section).getByRole('list', { name: 'Your staff memberships' });
    expect(within(memberships).getByText('active')).toBeInTheDocument();
    expect(
      within(memberships).getByText((text) =>
        text.includes(`until ${formatInstant('2027-01-01T00:00:00.000Z')}`),
      ),
    ).toBeInTheDocument();
  });

  it('DEC-018: multifactor status waits on the identity provider; API gaps are named', async () => {
    render(app().at('/admin/accounts'));
    const note = await screen.findByTestId('pending-note');
    expect(note).toHaveTextContent('Multifactor status for privileged staff is not shown');
    expect(note).toHaveTextContent('DEC-018');
    expect(
      screen.getByRole('region', {
        name: 'Staff accounts and role assignments: not available yet',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Audit of privileged actions: not available yet' }),
    ).toBeInTheDocument();
  });

  it('assigns roles with facility scope, a reason and an idempotency key', async () => {
    const user = userEvent.setup();
    const test = app({ 'POST /staff-memberships': { status: 201, body: staffMembership() } });
    render(test.at('/admin/accounts'));
    await assign(user);
    expect(
      await screen.findByText(`Membership ${MEMBERSHIP_1.slice(0, 8)} active`),
    ).toBeInTheDocument();
    const post = test.fake.requests.find((r) => r.route === '/staff-memberships');
    expect(post?.body).toEqual({
      personId: PERSON_1,
      roles: ['scheduler'],
      facilityIds: [FACILITY_A],
      reason: 'New scheduler',
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    const changed = screen.getByRole('list', { name: 'Memberships changed on this page' });
    expect(within(changed).getByText(/Scheduler/)).toBeInTheDocument();
  });

  it('validates before sending: a person id and at least one role', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/accounts'));
    await user.click(await screen.findByRole('button', { name: 'Assign roles' }));
    expect(screen.getByText('Enter the person id.')).toBeInTheDocument();
    expect(screen.getByText('Choose at least one role.')).toBeInTheDocument();
    expect(test.fake.requests.some((r) => r.route === '/staff-memberships')).toBe(false);
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

  it('changes scope with the expected revision and reports a stale revision honestly', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /staff-memberships': { status: 201, body: staffMembership() },
      'PATCH /staff-memberships/{id}': () =>
        fakeResponse(
          409,
          apiErrorBody('STALE_REVISION', {
            nextAction: 'reload_and_retry',
            message: 'The record changed.',
          }),
        ),
    });
    render(test.at('/admin/accounts'));
    await assign(user);
    await user.click(await screen.findByRole('button', { name: 'Change roles or scope' }));
    const form = screen.getByRole('form', {
      name: `Change membership ${MEMBERSHIP_1.slice(0, 8)}`,
    });
    await user.click(within(form).getByRole('checkbox', { name: 'Front desk' }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Error code: STALE_REVISION. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cannot be reloaded on this page; your entries are kept/),
    ).toBeInTheDocument();
    // No "Reload" that cannot be acted on (SPK-UX-008).
    expect(screen.queryByText('Reload')).toBeNull();
    const patch = test.fake.requests.find((r) => r.route === '/staff-memberships/{id}');
    expect(patch?.body).toEqual({
      roles: ['scheduler', 'front_desk'],
      facilityIds: [FACILITY_A],
      expectedRevision: 1,
    });
    expect(within(form).getByRole('checkbox', { name: 'Front desk' })).toBeChecked();
  });

  it('ends a membership with a reason and shows the ended state', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /staff-memberships': { status: 201, body: staffMembership() },
      'POST /staff-memberships/{id}/end': ok(
        staffMembership({ status: 'ended', effectiveTo: NOW_ISO, revision: 2 }),
      ),
    });
    render(test.at('/admin/accounts'));
    await assign(user);
    await user.click(await screen.findByRole('button', { name: 'End membership' }));
    await user.click(screen.getByRole('button', { name: 'End membership now' }));
    expect(screen.getByText('Enter the reason for ending this membership.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reason for ending (required)'), 'Left the organization');
    await user.click(screen.getByRole('button', { name: 'End membership now' }));
    const changed = await screen.findByRole('list', { name: 'Memberships changed on this page' });
    expect(await within(changed).findByText('ended')).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/staff-memberships/{id}/end')?.body).toEqual(
      {
        reason: 'Left the organization',
        expectedRevision: 1,
      },
    );
  });

  it('ending a membership changed by another administrator is refused as STALE_REVISION', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /staff-memberships': { status: 201, body: staffMembership() },
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
    await assign(user);
    await user.click(await screen.findByRole('button', { name: 'End membership' }));
    await user.type(screen.getByLabelText('Reason for ending (required)'), 'Left the organization');
    await user.click(screen.getByRole('button', { name: 'End membership now' }));
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be reloaded on this page/)).toBeInTheDocument();
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
