/**
 * SCR-S-21 Household, relationships and grants (SPK-IAM-001, SPK-IAM-003, SPK-IAM-004,
 * SPK-IAM-006, DEC-004): no permission is pre-selected or implied; each grant is shown and
 * revoked on its own with a reason and its expected revision; the invitation shows its full record
 * and leaves the expiry to the API; a household is never authority; guardian verification is a
 * pending decision; no guardian change offline (§4.15); ACCESS_DENIED is not available to you.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  GRANT_ID,
  OTHER_ID,
  PERSON_ID,
  grant,
  person,
  relationshipCreated,
  timeline,
} from './fixtures';

const PATH = `/people/${PERSON_ID}/relationships`;

function baseRoutes() {
  return {
    'GET /people/{id}': (req: { params: Record<string, string> }) =>
      fakeResponse(200, person(req.params['id'])),
    'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
  };
}

async function relationshipForm() {
  return screen.findByRole('form', { name: 'Record a relationship' });
}

describe('SCR-S-21 RelationshipsScreen', () => {
  it('says the existing list is not available, shows who the person may view and the pending decision', async () => {
    const app = createTestApp({ routes: baseRoutes() });
    render(app.at(PATH));
    expect(await screen.findByText('The full list is not available yet')).toBeInTheDocument();
    const view = await screen.findByRole('list', { name: 'People this person may view' });
    expect(within(view).getByText('Mia')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-004/)).toBeInTheDocument();
    expect(screen.getByText(/never gives anyone authority/)).toBeInTheDocument();
  });

  it('SPK-IAM-003: records a relationship with only the permissions chosen, each shown on its own', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'POST /relationships': { status: 201, body: relationshipCreated(['view', 'collect']) },
      },
    });
    render(app.at(PATH));
    const form = await relationshipForm();
    const boxes = within(form).getAllByRole('checkbox');
    expect(boxes).toHaveLength(6);
    for (const box of boxes) expect(box).not.toBeChecked();
    // Validation before any request.
    await user.click(within(form).getByRole('button', { name: 'Record relationship' }));
    expect(within(form).getByText('Enter a person reference.')).toBeInTheDocument();
    expect(within(form).getByText('Choose the kind of relationship.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/relationships')).toBe(false);

    await user.type(within(form).getByLabelText(/Other person reference/), OTHER_ID);
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'guardian');
    await user.click(within(form).getByLabelText(/^view:/));
    await user.click(within(form).getByLabelText(/^collect:/));
    await user.click(within(form).getByRole('button', { name: 'Record relationship' }));
    expect(
      await screen.findByText('Relationship recorded. State: active, 2 permission(s) granted.'),
    ).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/relationships');
    expect(post?.body).toEqual({
      actorPersonId: OTHER_ID,
      subjectPersonId: PERSON_ID,
      kind: 'guardian',
      permissions: ['view', 'collect'],
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    const granted = screen.getByRole('list', { name: 'Permissions granted' });
    expect(within(granted).getAllByRole('listitem', { name: /^Permission / })).toHaveLength(2);
    expect(within(granted).getAllByText('Effective now')).toHaveLength(2);
  });

  it('SPK-IAM-006: revokes one grant with a reason and its expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'POST /relationships': { status: 201, body: relationshipCreated(['view']) },
        'POST /access-grants/{id}/revoke': {
          status: 200,
          body: grant('view', `${GRANT_ID.slice(0, -1)}0`, {
            revokedAt: '2026-10-24T12:00:00.000Z',
            revocationReason: 'Requested by the guardian',
            effective: false,
            revision: 2,
          }),
        },
      },
    });
    render(app.at(PATH));
    const form = await relationshipForm();
    await user.type(within(form).getByLabelText(/Other person reference/), OTHER_ID);
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'guardian');
    await user.click(within(form).getByLabelText(/^view:/));
    await user.click(within(form).getByRole('button', { name: 'Record relationship' }));
    const revoke = await screen.findByRole('button', { name: 'Revoke permission view' });
    await user.click(revoke);
    expect(screen.getByText('Write why this permission is revoked.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reason to revoke view'), 'Requested by the guardian');
    await user.click(revoke);
    expect(await screen.findByText('Not effective')).toBeInTheDocument();
    const req = app.fake.requests.find((r) => r.route === '/access-grants/{id}/revoke');
    expect(req?.body).toEqual({ expectedRevision: 1, reason: 'Requested by the guardian' });
  });

  it('shows ACCESS_DENIED on a grant change as not available to you', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'POST /relationships': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'identity.create_relationship' }),
          ),
      },
    });
    render(app.at(PATH));
    const form = await relationshipForm();
    await user.type(within(form).getByLabelText(/Other person reference/), OTHER_ID);
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'delegate');
    await user.click(within(form).getByRole('button', { name: 'Record relationship' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    // The input is kept for another try.
    expect(within(form).getByLabelText(/Other person reference/)).toHaveValue(OTHER_ID);
  });

  it('SPK-IAM-004: an invitation requires a permission, leaves the expiry to the API and shows its full record', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'POST /invitations': {
          status: 201,
          body: {
            id: '0192f1a0-0000-7000-8000-000000000701',
            invitedByPersonId: null,
            recipientPersonId: null,
            recipientContact: { kind: 'email', value: 'grandma@example.test' },
            scope: { type: 'person', personId: PERSON_ID },
            relationshipKind: 'caregiver',
            requestedPermissions: ['collect'],
            grantedPermissions: [],
            status: 'pending',
            expiresAt: '2026-10-27T12:00:00.000Z',
            acceptedAt: null,
            acceptedByPersonId: null,
            revokedAt: null,
            revision: 1,
            createdAt: '2026-10-24T12:00:00.000Z',
            token: 'one-time-token-0123456789',
          },
        },
      },
    });
    render(app.at(PATH));
    const form = await screen.findByRole('form', { name: 'Create an invitation' });
    await user.click(within(form).getByLabelText('An email address or phone number'));
    await user.type(within(form).getByLabelText(/^Contact \(required\)/), 'grandma@example.test');
    await user.selectOptions(within(form).getByLabelText(/^Relationship/), 'caregiver');
    await user.click(within(form).getByRole('button', { name: 'Create invitation' }));
    expect(within(form).getByText('Request at least one permission.')).toBeInTheDocument();
    await user.click(within(form).getByLabelText(/^collect:/));
    await user.click(within(form).getByRole('button', { name: 'Create invitation' }));
    const record = await screen.findByLabelText('Invitation record');
    expect(within(record).getByText('Status: pending')).toBeInTheDocument();
    expect(within(record).getByText('email: grandma@example.test')).toBeInTheDocument();
    expect(within(record).getByText('None until accepted')).toBeInTheDocument();
    expect(within(record).getByText('one-time-token-0123456789')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/invitations');
    expect(post?.body).not.toHaveProperty('expiresInHours');
    expect(post?.body).toMatchObject({
      scope: { type: 'person', personId: PERSON_ID },
      requestedPermissions: ['collect'],
      recipientContact: { kind: 'email', value: 'grandma@example.test' },
    });
  });

  it('creates a household and adds the person to it', async () => {
    const user = userEvent.setup();
    const household = {
      id: '0192f1a0-0000-7000-8000-000000000801',
      name: 'Rivera',
      revision: 1,
      createdAt: '2026-10-24T12:00:00.000Z',
    };
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'POST /households': { status: 201, body: { ...household, members: [] } },
        'POST /households/{id}/members': {
          status: 201,
          body: { ...household, members: [{ personId: PERSON_ID, label: null }], revision: 2 },
        },
      },
    });
    render(app.at(PATH));
    await user.type(await screen.findByLabelText('New household name'), 'Rivera');
    await user.click(screen.getByRole('button', { name: 'Create household with this person' }));
    expect(
      await screen.findByText('This person is a member of the household.'),
    ).toBeInTheDocument();
    const add = app.fake.requests.find((r) => r.route === '/households/{id}/members');
    expect(add?.body).toEqual({ personId: PERSON_ID });
  });

  it('a failed add after creating a household retries only the add, never a second household', async () => {
    const user = userEvent.setup();
    const household = {
      id: '0192f1a0-0000-7000-8000-000000000801',
      name: 'Rivera',
      revision: 1,
      createdAt: '2026-10-24T12:00:00.000Z',
    };
    let adds = 0;
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'POST /households': { status: 201, body: { ...household, members: [] } },
        'POST /households/{id}/members': () => {
          adds += 1;
          return adds === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(201, {
                ...household,
                members: [{ personId: PERSON_ID, label: null }],
                revision: 2,
              });
        },
      },
    });
    render(app.at(PATH));
    await user.type(await screen.findByLabelText('New household name'), 'Rivera');
    await user.click(screen.getByRole('button', { name: 'Create household with this person' }));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('This person is a member of the household.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/households')).toHaveLength(1);
    const memberAdds = app.fake.requests.filter((r) => r.route === '/households/{id}/members');
    expect(memberAdds).toHaveLength(2);
    expect(memberAdds[1]?.headers['idempotency-key']).toBe(
      memberAdds[0]?.headers['idempotency-key'],
    );
  });

  it('a grant revoke answered STALE_REVISION says it changed elsewhere and offers no further revoke', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'POST /relationships': { status: 201, body: relationshipCreated(['view']) },
        'POST /access-grants/{id}/revoke': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      },
    });
    render(app.at(PATH));
    const form = await relationshipForm();
    await user.type(within(form).getByLabelText(/Other person reference/), OTHER_ID);
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'guardian');
    await user.click(within(form).getByLabelText(/^view:/));
    await user.click(within(form).getByRole('button', { name: 'Record relationship' }));
    await user.type(await screen.findByLabelText('Reason to revoke view'), 'Requested');
    await user.click(screen.getByRole('button', { name: 'Revoke permission view' }));
    expect(await screen.findByTestId('grant-changed-elsewhere')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke permission view' })).toBeNull();
  });

  it('§4.15: allows no guardian or grant change offline', async () => {
    const app = createTestApp({ routes: baseRoutes() });
    render(app.at(PATH));
    await relationshipForm();
    act(() => app.connectivity.set(false));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Record relationship' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Create invitation' })).toBeDisabled();
    expect(
      screen.getByText(/Offline: relationships, permissions and households cannot be changed/),
    ).toBeInTheDocument();
  });

  it('labels every form control (SPK-UX-009)', async () => {
    const app = createTestApp({ routes: baseRoutes() });
    render(app.at(PATH));
    await relationshipForm();
    for (const box of screen.getAllByRole('textbox')) expect(box).toHaveAccessibleName();
    for (const select of screen.getAllByRole('combobox')) expect(select).toHaveAccessibleName();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toHaveAccessibleName();
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAccessibleName();
  });
});
