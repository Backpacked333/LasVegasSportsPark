/**
 * SCR-S-20 Person search and record (SPK-IAM-001, SPK-IAM-002, SPK-SUPPORT-001, SPK-SUPPORT-002,
 * §4.14): search by name prefix or exact contact with `GET /v1/people?query`, validated before any
 * request, names only (a child by given name), paged, never in the address; the record and the
 * scoped timeline come from the API; sources the viewer may not read are listed as not available;
 * contact points are made primary or removed with the person's expected revision; the account and
 * claims show whether the record is claimable; a protected NOT_FOUND never says the person exists.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { CHILD_ID, PERSON_ID, authority, person, searchPage, timeline } from './fixtures';

const LOOKUP = mePermissions({ actions: ['identity.lookup_person'] });

describe('SCR-S-20 PeopleScreen', () => {
  it('SPK-IAM-002: validates the search before any request, then lists names only with how each matched', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': LOOKUP,
        'GET /people': { status: 200, body: searchPage() },
      },
    });
    render(app.at('/people'));
    const form = await screen.findByRole('search', { name: 'Search people' });
    await user.type(within(form).getByLabelText(/Name, email address or phone number/), 'A');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    expect(within(form).getByText(/Enter at least 2 characters/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/Name, email address or phone number/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(app.fake.requests.some((r) => r.route === '/people')).toBe(false);
    await user.type(within(form).getByLabelText(/Name, email address or phone number/), 'lex');
    await user.selectOptions(within(form).getByLabelText('Kind'), 'adult');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    const results = await screen.findByRole('list', { name: 'Matching people' });
    expect(within(results).getByRole('link', { name: 'Alex Rivera' })).toHaveAttribute(
      'href',
      `/people/${PERSON_ID}`,
    );
    // §4.14: a child is listed by given name only.
    expect(within(results).getByRole('link', { name: 'Mia' })).toBeInTheDocument();
    expect(within(results).queryByText(/Mia Rivera/)).toBeNull();
    expect(within(results).getAllByText(/matched on name/).length).toBe(2);
    const read = app.fake.requests.find((r) => r.route === '/people');
    expect(read?.query).toEqual({ query: 'Alex', limit: '25', kind: 'adult' });
  });

  it('pages with the API cursor and never puts the search term in the address', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': LOOKUP,
        'GET /people': (req) =>
          fakeResponse(
            200,
            req.query['cursor'] === 'p-2'
              ? {
                  items: [
                    {
                      id: '0192f1a0-0000-7000-8000-000000000104',
                      givenName: 'Alexis',
                      familyName: 'Rowe',
                      kind: 'adult',
                      status: 'inactive',
                      matchedOn: 'contact',
                    },
                  ],
                  nextCursor: null,
                }
              : searchPage('p-2'),
          ),
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      },
    });
    render(app.at('/people'));
    const form = await screen.findByRole('search', { name: 'Search people' });
    await user.type(
      within(form).getByLabelText(/Name, email address or phone number/),
      'Alex Rivera',
    );
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    await screen.findByRole('list', { name: 'Matching people' });
    await user.click(screen.getByRole('button', { name: 'Load more people' }));
    expect(await screen.findByText('Alexis Rowe')).toBeInTheDocument();
    expect(screen.getByText(/matched on contact/)).toBeInTheDocument();
    expect(screen.getByText('Status: inactive')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Alex Rivera' }));
    expect(await screen.findByRole('heading', { name: 'Alex Rivera' })).toBeInTheDocument();
    // Only the opaque id reaches a path; the search term only travels as the API query.
    for (const r of app.fake.requests) expect(r.path).not.toMatch(/Alex|Rivera/);
  });

  it('says when no person matches, without saying anything about other organizations', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': LOOKUP,
        'GET /people': { status: 200, body: { items: [], nextCursor: null } },
      },
    });
    render(app.at('/people'));
    const form = await screen.findByRole('search', { name: 'Search people' });
    await user.type(within(form).getByLabelText(/Name, email address or phone number/), 'Zed');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No person matches')).toBeInTheDocument();
    expect(screen.getByText(/Only people of this organization are searched/)).toBeInTheDocument();
  });

  it('shows search as not available to roles without lookup, and ACCESS_DENIED likewise', async () => {
    const app = createTestApp();
    render(app.at('/people'));
    expect(
      await screen.findByText(/Person search is not available to your role/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('search', { name: 'Search people' })).toBeNull();

    const user = userEvent.setup();
    const denied = createTestApp({
      routes: {
        'GET /me/permissions': LOOKUP,
        'GET /people': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      },
    });
    render(denied.at('/people'));
    const form = await screen.findByRole('search', { name: 'Search people' });
    await user.type(within(form).getByLabelText(/Name, email address or phone number/), 'Alex');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    const results = await screen.findByRole('region', { name: 'Search results' });
    expect(await within(results).findByText('Not available')).toBeInTheDocument();
  });

  it('shows a failed search with its code and a retry', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': LOOKUP,
        'GET /people': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-s' })),
      },
    });
    render(app.at('/people'));
    const form = await screen.findByRole('search', { name: 'Search people' });
    await user.type(within(form).getByLabelText(/Name, email address or phone number/), 'Alex');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    expect(
      await screen.findByText('Error code: INTERNAL_ERROR. Reference: corr-s'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('SCR-S-20 PersonRecordScreen', () => {
  it('SPK-SUPPORT-001: shows the person, contact points and the scoped timeline', async () => {
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    expect(await screen.findByRole('heading', { name: 'Alex Rivera' })).toBeInTheDocument();
    expect(screen.getByText('Status: active')).toBeInTheDocument();
    const contacts = screen.getByRole('list', { name: 'Contact points' });
    expect(within(contacts).getByText('Verified')).toBeInTheDocument();
    expect(within(contacts).getByText('Primary')).toBeInTheDocument();
    const entries = await screen.findByRole('list', { name: 'Timeline' });
    expect(within(entries).getByText('Payment for U10 fall program')).toBeInTheDocument();
    expect(
      within(entries).getByText(/payment · payment_attempt.succeeded · \$25\.00/),
    ).toBeInTheDocument();
    expect(within(entries).getByText('Status: succeeded')).toBeInTheDocument();
    // Dependents in scope link to their own records; the child is shown as the API minimizes it.
    const scope = screen.getByRole('list', { name: 'People in this timeline’s scope' });
    expect(within(scope).getByRole('link', { name: 'Mia' })).toHaveAttribute(
      'href',
      `/people/${CHILD_ID}`,
    );
    // A source the viewer may not read is listed, not hidden.
    const notIncluded = screen.getByRole('region', { name: 'Timeline sources not included' });
    expect(within(notIncluded).getByText('communications.messages')).toBeInTheDocument();
    expect(within(notIncluded).getByText('Not available to you')).toBeInTheDocument();
    // Work with the person: relationships, review, duplicate check, support case.
    expect(
      screen.getByRole('link', { name: 'Household, relationships and grants' }),
    ).toHaveAttribute('href', `/people/${PERSON_ID}/relationships`);
    expect(screen.getByRole('link', { name: 'Open a support case' })).toHaveAttribute(
      'href',
      `/admin/cases/new?subject=${PERSON_ID}`,
    );
  });

  it('pages older timeline entries with the API cursor', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': (req) =>
          fakeResponse(
            200,
            req.query['cursor'] === 'c-2'
              ? timeline({
                  entries: [
                    {
                      ...timeline().entries[0],
                      id: 'case:1',
                      title: 'Support case opened',
                      category: 'support',
                      kind: 'case.opened',
                      amount: null,
                    },
                  ],
                })
              : timeline({ nextCursor: 'c-2' }),
          ),
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    await user.click(await screen.findByRole('button', { name: 'Show older entries' }));
    const older = await screen.findByRole('list', { name: 'Older timeline entries' });
    expect(within(older).getByText('Support case opened')).toBeInTheDocument();
    const second = app.fake.requests.filter((r) => r.route === '/customers/{personId}/timeline');
    expect(second[second.length - 1]?.query).toMatchObject({ cursor: 'c-2', limit: '50' });
  });

  it('says a child’s timeline is minimized', async () => {
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person(PERSON_ID, { kind: 'child' }) },
        'GET /customers/{personId}/timeline': {
          status: 200,
          body: timeline({
            person: {
              id: PERSON_ID,
              kind: 'child',
              displayName: 'Alex',
              status: 'active',
              minimized: true,
            },
          }),
        },
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    expect(
      await screen.findByText(/shown by given name only, without date of birth or contacts/),
    ).toBeInTheDocument();
    // §4.14: the record itself is minimized too, not only described as such.
    expect(screen.getByRole('heading', { name: 'Alex' })).toBeInTheDocument();
    expect(screen.queryByText('Rivera')).toBeNull();
    expect(screen.queryByText(/Rivera/)).toBeNull();
    expect(screen.queryByText('1990-04-02')).toBeNull();
    expect(screen.queryByText(/@example\.test/)).toBeNull();
  });

  it('shows a protected NOT_FOUND as not available and never names the person', async () => {
    const app = createTestApp({
      routes: {
        'GET /people/{id}': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/customers/{personId}/timeline')).toBe(false);
  });

  it('shows a timeline the viewer may not read as not available while the record stays', async () => {
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': () =>
          fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    expect(await screen.findByRole('heading', { name: 'Alex Rivera' })).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Customer timeline' });
    await waitFor(() => expect(within(section).getByText('Not available')).toBeInTheDocument());
  });

  it('shows other timeline failures with their code and a retry', async () => {
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-tl' })),
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    expect(
      await screen.findByText('Error code: INTERNAL_ERROR. Reference: corr-tl'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('treats a malformed address as not available without calling the API', async () => {
    const app = createTestApp();
    render(app.at('/people/not-a-reference'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/people/{id}')).toBe(false);
  });
});

describe('SCR-S-20 contact points', () => {
  const CONTACTS = mePermissions({ actions: ['identity.add_contact_point'] });
  const twoContacts = () =>
    person(PERSON_ID, {
      contactPoints: [
        ...person().contactPoints,
        {
          id: '0192f1a0-0000-7000-8000-0000000001c2',
          personId: PERSON_ID,
          kind: 'email',
          value: 'second@example.test',
          isPrimary: false,
          verifiedAt: null,
          createdAt: '2026-10-24T12:00:00.000Z',
        },
      ],
    });

  it('SPK-IAM-001: makes a contact point primary with the person’s expected revision', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': CONTACTS,
        'GET /people/{id}': () => {
          reads += 1;
          return fakeResponse(200, twoContacts());
        },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
        'POST /people/{id}/contact-points/{contactPointId}/make-primary': {
          status: 200,
          body: { ...twoContacts().contactPoints[1], isPrimary: true },
        },
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    await user.click(
      await screen.findByRole('button', { name: 'Make primary: email second@example.test' }),
    );
    expect(await screen.findByText('Now the primary email.')).toBeInTheDocument();
    const post = app.fake.requests.find(
      (r) => r.route === '/people/{id}/contact-points/{contactPointId}/make-primary',
    );
    expect(post?.params).toEqual({
      id: PERSON_ID,
      contactPointId: '0192f1a0-0000-7000-8000-0000000001c2',
    });
    expect(post?.body).toEqual({ expectedRevision: 3 });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    // The record is read again after the change.
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it('removes a contact point only after confirmation, and shows the last-verified refusal with its reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': CONTACTS,
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
        'POST /people/{id}/contact-points/{contactPointId}/remove': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message:
                'The only verified contact point of a person with an account cannot be removed.',
              details: { code: 'LAST_VERIFIED_CONTACT' },
            }),
          ),
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    const contact = person().contactPoints[0] as { value: string };
    await user.click(await screen.findByRole('button', { name: `Remove: email ${contact.value}` }));
    expect(app.fake.requests.some((r) => r.route?.endsWith('/remove'))).toBe(false);
    expect(screen.getByText(/the audit record keeps a masked copy/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: `Confirm removing email ${contact.value}` }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /only verified contact of a person with an account.*LAST_VERIFIED_CONTACT/,
    );
    const post = app.fake.requests.find((r) => r.route?.endsWith('/remove'));
    expect(post?.body).toEqual({ expectedRevision: 3 });
  });

  it('STALE_REVISION on a contact change offers Reload, which re-reads the person', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': CONTACTS,
        'GET /people/{id}': () => fakeResponse(200, twoContacts()),
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
        'POST /people/{id}/contact-points/{contactPointId}/make-primary': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    await user.click(
      await screen.findByRole('button', { name: 'Make primary: email second@example.test' }),
    );
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    const reads = app.fake.requests.filter((r) => r.route === '/people/{id}').length;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/people/{id}').length).toBe(reads + 1),
    );
  });

  it('offers no contact change without the role, offline, or for a child', async () => {
    const plain = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      },
    });
    const { unmount } = render(plain.at(`/people/${PERSON_ID}`));
    await screen.findByRole('list', { name: 'Contact points' });
    expect(screen.queryByRole('button', { name: /^Remove: / })).toBeNull();
    unmount();

    const offline = createTestApp({
      routes: {
        'GET /me/permissions': CONTACTS,
        'GET /people/{id}': { status: 200, body: twoContacts() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      },
    });
    const second = render(offline.at(`/people/${PERSON_ID}`));
    await screen.findByRole('button', { name: 'Make primary: email second@example.test' });
    act(() => offline.connectivity.set(false));
    expect(
      await screen.findByText('Offline: contact points cannot be changed until you reconnect.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Make primary/ })).toBeNull();
    second.unmount();

    const child = createTestApp({
      routes: {
        'GET /me/permissions': CONTACTS,
        'GET /people/{id}': { status: 200, body: person(CHILD_ID, { kind: 'child' }) },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      },
    });
    render(child.at(`/people/${CHILD_ID}`));
    expect(await screen.findByText('Kept on the record, not shown here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove: / })).toBeNull();
  });
});

describe('SCR-S-20 account and claims', () => {
  it('SPK-IAM-002: shows whether an account represents the person and each claim’s effective status', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({ actions: ['identity.read_authority'] }),
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
        'GET /people/{id}/authority': { status: 200, body: authority() },
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    const section = await screen.findByRole('region', { name: 'Account and claims' });
    expect(await within(section).findByText('Account: none')).toBeInTheDocument();
    expect(within(section).getByText(/a staff-entered record can be claimed/)).toBeInTheDocument();
    const claims = within(section).getByRole('list', { name: 'Claims' });
    // The API's effective status (past expiry) is shown, not the stored one.
    expect(within(claims).getByText('Claim status: expired')).toBeInTheDocument();
    expect(within(claims).getByText(/sent to a\*\*\*@example\.test/)).toBeInTheDocument();
  });

  it('says the account is not available to roles without the read, without asking', async () => {
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    expect(
      await screen.findByText('The account and claims of a person are not available to you.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/people/{id}/authority')).toBe(false);
  });
});
