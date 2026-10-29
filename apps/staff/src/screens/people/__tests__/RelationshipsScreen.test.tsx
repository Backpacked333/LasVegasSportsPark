/**
 * SCR-S-21 Household, relationships and grants (SPK-IAM-001, SPK-IAM-003, SPK-IAM-004,
 * SPK-IAM-005, SPK-IAM-006, DEC-004): the person's authority from `GET /v1/people/{id}/authority`
 * (relationships in both directions with named parties, each grant with its state and "under
 * review", households, pending invitations); no permission is pre-selected or implied; each grant
 * is revoked on its own with a reason and its expected revision, and STALE_REVISION re-reads the
 * authority; invitations show their full record, leave the expiry to the API and can be revoked;
 * the invitations covering the person are listed in any state; a household is never authority;
 * guardian verification is a pending decision; no change offline (§4.15).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  GRANT_ID,
  INVITATION_ID,
  OTHER_ID,
  PERSON_ID,
  authority,
  grantView,
  invitationView,
  person,
  personNames,
  relationshipCreated,
  searchPage,
} from './fixtures';

const PATH = `/people/${PERSON_ID}/relationships`;

function baseRoutes(extra: Record<string, unknown> = {}) {
  return {
    'GET /people/{id}': (req: { params: Record<string, string> }) =>
      fakeResponse(200, person(req.params['id'])),
    'GET /people/{id}/authority': { status: 200, body: authority() },
    'GET /person-names': personNames(),
    'GET /invitations': { status: 200, body: { items: [], nextCursor: null } },
    ...extra,
  };
}

function authorityReads(app: ReturnType<typeof createTestApp>) {
  return app.fake.requests.filter((r) => r.route === '/people/{id}/authority').length;
}

async function relationshipForm() {
  return screen.findByRole('form', { name: 'Record a relationship' });
}

describe('SCR-S-21 RelationshipsScreen', () => {
  it('SPK-IAM-003: lists the person’s relationships with named parties and each grant’s state, households and pending invitations', async () => {
    const app = createTestApp({ routes: baseRoutes() });
    render(app.at(PATH));
    const relationships = await screen.findByRole('list', { name: 'Relationships' });
    const card = within(relationships).getByRole('listitem', { name: 'Relationship guardian' });
    expect(await within(card).findByRole('link', { name: 'Sam Rivera' })).toHaveAttribute(
      'href',
      `/people/${OTHER_ID}`,
    );
    expect(within(card).getByText(/holds this relationship over/)).toBeInTheDocument();
    expect(within(card).getByText('this person')).toBeInTheDocument();
    const grants = within(card).getByRole('list', { name: 'Permissions granted' });
    const view = within(grants).getByRole('listitem', { name: 'Permission view' });
    expect(within(view).getByText('State: effective')).toBeInTheDocument();
    const pay = within(grants).getByRole('listitem', { name: 'Permission pay' });
    expect(within(pay).getByText('State: suspended')).toBeInTheDocument();
    expect(
      within(pay).getByText('Under review: restricted by an access review'),
    ).toBeInTheDocument();
    const households = screen.getByRole('list', { name: 'Households of this person' });
    expect(within(households).getByText('Rivera household · 3 member(s)')).toBeInTheDocument();
    expect(screen.getAllByText(/never gives anyone authority/).length).toBeGreaterThan(0);
    const pending = screen.getByRole('list', { name: 'Pending invitations' });
    expect(within(pending).getByText('Status: pending')).toBeInTheDocument();
    expect(within(pending).getByText('email: grandma@example.test')).toBeInTheDocument();
    expect(within(pending).getByText('view, collect')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-004/)).toBeInTheDocument();
  });

  it('says when the person has no relationships, households or pending invitations', async () => {
    const app = createTestApp({
      routes: baseRoutes({
        'GET /people/{id}/authority': {
          status: 200,
          body: authority({
            relationships: [],
            grants: [],
            households: [],
            pendingInvitations: [],
          }),
        },
      }),
    });
    render(app.at(PATH));
    expect(await screen.findByText('No relationships')).toBeInTheDocument();
    expect(screen.getByText('This person is not a member of any household.')).toBeInTheDocument();
    expect(screen.getByText('No pending invitation concerns this person.')).toBeInTheDocument();
  });

  it('shows an authority the viewer may not read as not available, without details', async () => {
    const app = createTestApp({
      routes: baseRoutes({
        'GET /people/{id}/authority': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }),
    });
    render(app.at(PATH));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Relationships' })).toBeNull();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
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
    // The authority is read again, so the new relationship is listed from the API.
    await waitFor(() => expect(authorityReads(app)).toBe(2));
  });

  it('SPK-IAM-006: revokes one grant with a reason and its expected revision, then re-reads the authority', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: baseRoutes({
        'POST /access-grants/{id}/revoke': {
          status: 200,
          body: {
            id: GRANT_ID,
            relationshipId: relationshipCreated([]).relationship.id,
            actorPersonId: OTHER_ID,
            subjectPersonId: PERSON_ID,
            permission: 'view',
            source: 'staff',
            effectiveFrom: '2026-10-24T12:00:00.000Z',
            effectiveTo: null,
            revokedAt: '2026-10-24T12:00:00.000Z',
            revocationReason: 'Requested by the guardian',
            suspendedAt: null,
            suspendedByReviewId: null,
            effective: false,
            revision: 2,
            createdAt: '2026-10-24T12:00:00.000Z',
          },
        },
      }),
    });
    render(app.at(PATH));
    const revoke = await screen.findByRole('button', { name: 'Revoke permission view' });
    await user.click(revoke);
    expect(screen.getByText('Write why this permission is revoked.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/access-grants/{id}/revoke')).toBe(false);
    await user.type(screen.getByLabelText('Reason to revoke view'), 'Requested by the guardian');
    await user.click(revoke);
    expect(await screen.findByText('Permission view revoked.')).toBeInTheDocument();
    const req = app.fake.requests.find((r) => r.route === '/access-grants/{id}/revoke');
    expect(req?.params).toEqual({ id: GRANT_ID });
    expect(req?.body).toEqual({ expectedRevision: 1, reason: 'Requested by the guardian' });
    await waitFor(() => expect(authorityReads(app)).toBe(2));
  });

  it('offers no revoke for a revoked or ended grant', async () => {
    const app = createTestApp({
      routes: baseRoutes({
        'GET /people/{id}/authority': {
          status: 200,
          body: authority({
            grants: [
              grantView('view', GRANT_ID, {
                status: 'revoked',
                revokedAt: '2026-10-20T12:00:00.000Z',
              }),
            ],
          }),
        },
      }),
    });
    render(app.at(PATH));
    const grant = await screen.findByRole('listitem', { name: 'Permission view' });
    expect(within(grant).getByText('State: revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke permission view' })).toBeNull();
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
    const section = screen.getByRole('region', {
      name: 'Invite someone to hold permissions over this person',
    });
    const record = await within(section).findByLabelText('Invitation record');
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

  it('a grant revoke answered STALE_REVISION offers Reload, which re-reads the authority and keeps the reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: baseRoutes({
        'POST /access-grants/{id}/revoke': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at(PATH));
    await user.type(await screen.findByLabelText('Reason to revoke view'), 'Requested');
    await user.click(screen.getByRole('button', { name: 'Revoke permission view' }));
    const grant = screen.getByRole('listitem', { name: 'Permission view' });
    expect(await within(grant).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    const before = authorityReads(app);
    await user.click(within(grant).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(authorityReads(app)).toBe(before + 1));
    expect(screen.getByLabelText('Reason to revoke view')).toHaveValue('Requested');
  });

  it('SPK-IAM-004: revokes a pending invitation with a reason and its expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: baseRoutes({
        'POST /invitations/{id}/revoke': {
          status: 200,
          body: { ...invitationView({ status: 'revoked', revision: 2 }) },
        },
      }),
    });
    render(app.at(PATH));
    const pending = await screen.findByRole('list', { name: 'Pending invitations' });
    await user.click(within(pending).getByRole('button', { name: 'Revoke invitation' }));
    expect(within(pending).getByText('Write why the invitation is revoked.')).toBeInTheDocument();
    await user.type(
      within(pending).getByLabelText('Reason to revoke the invitation'),
      'Sent to the wrong address',
    );
    await user.click(within(pending).getByRole('button', { name: 'Revoke invitation' }));
    expect(await screen.findByText('Invitation revoked. State: revoked.')).toBeInTheDocument();
    const req = app.fake.requests.find((r) => r.route === '/invitations/{id}/revoke');
    expect(req?.params).toEqual({ id: INVITATION_ID });
    expect(req?.body).toEqual({ expectedRevision: 1, reason: 'Sent to the wrong address' });
  });

  it('lists the invitations covering the person in any state, filtered by the API, page by page', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: baseRoutes({
        'GET /me/permissions': mePermissions({ actions: ['identity.read_invitations'] }),
        'GET /invitations': (req: { query: Record<string, string> }) =>
          fakeResponse(
            200,
            req.query['cursor'] === 'i-2'
              ? {
                  items: [
                    invitationView({
                      id: '0192f1a0-0000-7000-8000-000000000802',
                      status: 'declined',
                      effectiveStatus: 'declined',
                      declinedAt: '2026-10-22T12:00:00.000Z',
                    }),
                  ],
                  nextCursor: null,
                }
              : {
                  items: [invitationView({ status: 'pending', effectiveStatus: 'expired' })],
                  nextCursor: 'i-2',
                },
          ),
      }),
    });
    render(app.at(PATH));
    const history = await screen.findByRole('region', { name: 'Invitations covering this person' });
    const list = await within(history).findByRole('list', {
      name: 'Invitations covering this person',
    });
    // The API's effective status (past expiry) is shown, with what is recorded.
    expect(within(list).getByText('Status: expired')).toBeInTheDocument();
    expect(within(list).getByText('(recorded as pending)')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Revoke invitation' })).toBeNull();
    await user.click(within(history).getByRole('button', { name: 'Load more invitations' }));
    expect(await within(history).findByText('Status: declined')).toBeInTheDocument();
    const first = app.fake.requests.find((r) => r.route === '/invitations');
    expect(first?.query).toEqual({ scopePersonId: PERSON_ID, limit: '20' });
    await user.selectOptions(within(history).getByLabelText('Invitation status'), 'accepted');
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/invitations' && r.query['status'] === 'accepted',
        ),
      ).toBe(true),
    );
  });

  it('says the invitation history is not available to roles without the read', async () => {
    const app = createTestApp({ routes: baseRoutes() });
    render(app.at(PATH));
    expect(
      await screen.findByText('The invitation history is not available to you.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/invitations')).toBe(false);
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

  it('SPK-IAM-002: a person reference can be found by name and chosen, which fills the reference', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: baseRoutes({
        'GET /me/permissions': mePermissions({ actions: ['identity.lookup_person'] }),
        'GET /people': {
          status: 200,
          body: {
            ...searchPage(),
            items: [{ ...searchPage().items[0], id: OTHER_ID, givenName: 'Sam' }],
          },
        },
      }),
    });
    render(app.at(PATH));
    const form = await relationshipForm();
    await user.click(
      within(form).getByRole('button', { name: 'Find by name for other person reference' }),
    );
    const finder = within(form).getByRole('group', {
      name: 'Find by name for other person reference',
    });
    await user.type(within(finder).getByLabelText('Find by name or contact'), 'S');
    await user.click(within(finder).getByRole('button', { name: 'Search' }));
    expect(within(finder).getByText(/Enter 2 to 100 characters/)).toBeInTheDocument();
    await user.type(within(finder).getByLabelText('Find by name or contact'), 'am');
    await user.click(within(finder).getByRole('button', { name: 'Search' }));
    await user.click(
      await within(finder).findByRole('button', {
        name: 'Use Sam Rivera for other person reference',
      }),
    );
    expect(within(form).getByLabelText(/Other person reference/)).toHaveValue(OTHER_ID);
    expect(app.fake.requests.find((r) => r.route === '/people')?.query).toEqual({
      query: 'Sam',
      limit: '10',
    });
  });
});
