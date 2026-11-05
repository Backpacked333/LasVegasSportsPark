/**
 * SCR-S-21 Invitations, the organization's list (SPK-IAM-004): `GET /v1/invitations` by effective
 * status (pending first), paged with the API's cursor; each invitation shows its full record, the
 * people it covers and the API's expiry; a pending one is revoked with a reason and its expected
 * revision; roles without `identity.read_invitations` see "not available", as does ACCESS_DENIED.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { CHILD_ID, INVITATION_ID, PERSON_ID, invitationView, personNames } from './fixtures';

const READER = mePermissions({ actions: ['identity.read_invitations'] });

describe('SCR-S-21 InvitationsScreen', () => {
  it('SPK-IAM-004: lists pending invitations with their full record and revokes one with a reason', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /invitations': () => {
          reads += 1;
          return fakeResponse(200, { items: [invitationView()], nextCursor: null });
        },
        'GET /person-names': personNames(),
        'POST /invitations/{id}/revoke': {
          status: 200,
          body: invitationView({ status: 'revoked', revision: 2 }),
        },
      },
    });
    render(app.at('/people/invitations'));
    const list = await screen.findByRole('list', { name: 'Invitations' });
    const record = within(list).getByLabelText('Invitation record');
    expect(within(record).getByText('Status: pending')).toBeInTheDocument();
    expect(await within(record).findByRole('link', { name: 'Sam Rivera' })).toBeInTheDocument();
    expect(within(record).getByRole('link', { name: 'Alex Rivera' })).toHaveAttribute(
      'href',
      `/people/${PERSON_ID}`,
    );
    expect(within(record).getByText('delegate')).toBeInTheDocument();
    expect(within(record).getByText('view, collect')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/invitations')?.query).toEqual({
      limit: '25',
      status: 'pending',
    });
    await user.type(
      within(record).getByLabelText('Reason to revoke the invitation'),
      'Duplicate invitation',
    );
    await user.click(within(record).getByRole('button', { name: 'Revoke invitation' }));
    // Announced above the list: the re-read pending list may no longer hold the card.
    expect(await screen.findByText('Invitation revoked. State: revoked.')).toBeInTheDocument();
    expect(within(record).queryByRole('button', { name: 'Revoke invitation' })).toBeNull();
    const post = app.fake.requests.find((r) => r.route === '/invitations/{id}/revoke');
    expect(post?.params).toEqual({ id: INVITATION_ID });
    expect(post?.body).toEqual({ expectedRevision: 1, reason: 'Duplicate invitation' });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    // The list is read again after the change.
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    // One name read for the whole page.
    expect(app.fake.requests.filter((r) => r.route === '/person-names').length).toBe(1);
  });

  it('§4.14: names a child it covers by given name only, never with the invitation’s composed name', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /invitations': {
          status: 200,
          body: {
            items: [
              invitationView({
                scope: { type: 'person', personId: CHILD_ID },
                subjects: [{ personId: CHILD_ID, displayName: 'Mia Rivera' }],
              }),
            ],
            nextCursor: null,
          },
        },
        'GET /person-names': personNames(),
      },
    });
    render(app.at('/people/invitations'));
    const record = within(await screen.findByRole('list', { name: 'Invitations' })).getByLabelText(
      'Invitation record',
    );
    expect(await within(record).findByRole('link', { name: 'Mia' })).toHaveAttribute(
      'href',
      `/people/${CHILD_ID}`,
    );
    expect(within(record).queryByText(/Mia Rivera/)).toBeNull();
  });

  it('SPK-UX-008: a failed name read shows its code and Try again; a denied one reads not available', async () => {
    const user = userEvent.setup();
    let answer: 'fail' | 'ok' = 'fail';
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /invitations': { status: 200, body: { items: [invitationView()], nextCursor: null } },
        'GET /person-names': () =>
          answer === 'fail'
            ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR'))
            : fakeResponse(200, personNames().body),
      },
    });
    const first = render(app.at('/people/invitations'));
    const record = within(await screen.findByRole('list', { name: 'Invitations' })).getByLabelText(
      'Invitation record',
    );
    expect(
      (await within(record).findAllByText(/name could not be loaded \(INTERNAL_ERROR\)/)).length,
    ).toBeGreaterThan(0);
    expect(within(record).queryByText('a person not available to you')).toBeNull();
    answer = 'ok';
    await user.click(
      within(record).getAllByRole('button', {
        name: 'Try loading the names again',
      })[0] as HTMLElement,
    );
    expect(await within(record).findByRole('link', { name: 'Sam Rivera' })).toBeInTheDocument();
    first.unmount();

    const denied = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /invitations': { status: 200, body: { items: [invitationView()], nextCursor: null } },
        'GET /person-names': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      },
    });
    render(denied.at('/people/invitations'));
    const deniedRecord = within(
      await screen.findByRole('list', { name: 'Invitations' }),
    ).getByLabelText('Invitation record');
    expect(
      (await within(deniedRecord).findAllByText('a person not available to you')).length,
    ).toBeGreaterThan(0);
    expect(within(deniedRecord).queryByText(/name could not be loaded/)).toBeNull();
  });

  it('lists any status when asked, page by page, and says when there are none', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /invitations': (req) =>
          fakeResponse(
            200,
            req.query['status'] === 'declined'
              ? { items: [], nextCursor: null }
              : req.query['cursor'] === 'i-2'
                ? {
                    items: [
                      invitationView({
                        id: '0192f1a0-0000-7000-8000-000000000803',
                        status: 'accepted',
                        effectiveStatus: 'accepted',
                        grantedPermissions: ['view'],
                        acceptedAt: '2026-10-23T12:00:00.000Z',
                      }),
                    ],
                    nextCursor: null,
                  }
                : { items: [invitationView()], nextCursor: 'i-2' },
          ),
      },
    });
    render(app.at('/people/invitations'));
    await user.selectOptions(await screen.findByLabelText('Status'), '');
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/invitations' && !('status' in r.query)),
      ).toBe(true),
    );
    await user.click(await screen.findByRole('button', { name: 'Load more invitations' }));
    expect(await screen.findByText('Status: accepted')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'declined');
    expect(await screen.findByText('No invitation is declined.')).toBeInTheDocument();
  });

  it('is not available to roles without the read, without asking, and ACCESS_DENIED likewise', async () => {
    const app = createTestApp();
    const first = render(app.at('/people/invitations'));
    expect(
      await screen.findByText("The organization's invitations are not available to your role."),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/invitations')).toBe(false);
    first.unmount();

    const denied = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /invitations': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      },
    });
    render(denied.at('/people/invitations'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });

  it('is reachable from the People and families navigation', async () => {
    const app = createTestApp({ routes: { 'GET /me/permissions': READER } });
    render(app.at('/people/invitations'));
    const nav = await screen.findByRole('navigation', { name: 'People and families' });
    expect(within(nav).getByRole('link', { name: 'Invitations' })).toHaveAttribute(
      'href',
      '/people/invitations',
    );
  });
});
