/**
 * SCR-S-20 Person search and record (SPK-IAM-001, SPK-IAM-002, SPK-SUPPORT-001, SPK-SUPPORT-002,
 * §4.14): search by name is not available (no API); a reference is validated before any request;
 * the record and the scoped timeline come from the API; sources the viewer may not read are listed
 * as not available; a protected NOT_FOUND never says the person exists; the URL carries only the
 * opaque id.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import { CHILD_ID, PERSON_ID, person, timeline } from './fixtures';

describe('SCR-S-20 PeopleScreen', () => {
  it('says search by name is not available and validates the reference before any request', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/people'));
    expect(
      await screen.findByText('Search by name or contact is not available yet'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Person reference/), 'Alex Rivera');
    await user.click(screen.getByRole('button', { name: 'Open record' }));
    expect(screen.getByText(/Enter a person reference: 36 characters/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Person reference/)).toHaveAttribute('aria-invalid', 'true');
    expect(app.fake.requests.some((r) => r.route === '/people/{id}')).toBe(false);
  });

  it('opens the record by reference, with only the opaque id in the address', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      },
    });
    render(app.at('/people'));
    await user.type(await screen.findByLabelText(/Person reference/), PERSON_ID);
    expect(await screen.findByTestId('person-preview')).toHaveTextContent(
      'Alex Rivera · adult · status active',
    );
    await user.click(screen.getByRole('button', { name: 'Open record' }));
    expect(await screen.findByRole('heading', { name: 'Alex Rivera' })).toBeInTheDocument();
    for (const r of app.fake.requests) expect(r.path).not.toMatch(/Alex|Rivera/);
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
