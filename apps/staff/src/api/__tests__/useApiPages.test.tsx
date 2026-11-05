/**
 * "Load more" over a paged list (§4.5 keyset cursors; SPK-UX-008 nothing silently cut off):
 * the API's cursor is sent unchanged, a failed next page keeps the loaded items and shows the
 * code with "Try again", offline disables the button, and nothing shows when no page remains.
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../testing/test-app';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { useApiPages } from '../useApiPages';

const FACILITY = '0192f1a0-0000-7000-8000-00000000fa01';

function receipt(n: number) {
  return { id: `0192f1a0-0000-7000-8000-${String(n).padStart(12, '0')}`, n };
}

function BookingList() {
  const pages = useApiPages({
    path: '/bookings',
    request: { query: { facilityId: FACILITY, limit: 2 } },
  });
  return (
    <>
      <QueryBoundary
        query={pages}
        label="bookings"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No bookings', description: 'Bookings appear here.' }}
      >
        {(items) => (
          <ul aria-label="Bookings">
            {items.map((item) => (
              <li key={item.id}>{item.id.slice(-2)}</li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="bookings" />
    </>
  );
}

function pagedRoute(fail: { page2?: boolean } = {}) {
  let page2Calls = 0;
  return (request: FakeRequest) => {
    if (!request.query.cursor) {
      return fakeResponse(200, { items: [receipt(1), receipt(2)], nextCursor: 'cursor-2' });
    }
    expect(request.query.cursor).toBe('cursor-2');
    expect(request.query.limit).toBe('2');
    page2Calls += 1;
    if (fail.page2 && page2Calls === 1) {
      return fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-page' }));
    }
    // The boundary item 02 appears again on the next page and is shown once.
    return fakeResponse(200, { items: [receipt(2), receipt(3)], nextCursor: null });
  };
}

describe('useApiPages and LoadMore (§4.5, SPK-UX-008)', () => {
  it('loads the next page with the API cursor and stops when nextCursor is null', async () => {
    const app = createTestApp({ routes: { 'GET /bookings': pagedRoute() } });
    render(<BookingList />, { wrapper: app.wrapper });
    const list = await screen.findByRole('list', { name: 'Bookings' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['01', '02']);
    await userEvent.click(screen.getByRole('button', { name: 'Load more bookings' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Bookings' }))
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['01', '02', '03']),
    );
    expect(screen.queryByRole('button', { name: 'Load more bookings' })).toBeNull();
    const first = app.fake.requests.find((r) => r.route === '/bookings');
    expect(first?.query).toEqual({ facilityId: FACILITY, limit: '2' });
  });

  it('a failed next page keeps the loaded items and shows the code with "Try again"', async () => {
    const app = createTestApp({ routes: { 'GET /bookings': pagedRoute({ page2: true }) } });
    render(<BookingList />, { wrapper: app.wrapper });
    await screen.findByRole('list', { name: 'Bookings' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more bookings' }));
    expect(
      await screen.findByText('Error code: INTERNAL_ERROR. Reference: corr-page'),
    ).toBeInTheDocument();
    // The list itself did not fail: its two items stay and no list-level error replaces them.
    expect(
      within(screen.getByRole('list', { name: 'Bookings' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Bookings' })).getAllByRole('listitem'),
      ).toHaveLength(3),
    );
  });

  it('offline, "Load more" is disabled and says it needs a connection', async () => {
    const app = createTestApp({ routes: { 'GET /bookings': pagedRoute() } });
    render(<BookingList />, { wrapper: app.wrapper });
    await screen.findByRole('list', { name: 'Bookings' });
    act(() => app.connectivity.set(false));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more bookings' })).toBeDisabled(),
    );
    expect(screen.getByText('Loading more bookings needs a connection.')).toBeInTheDocument();
  });

  it('a list the API refuses is "not available", and an empty one says what would appear', async () => {
    const denied = createTestApp({
      routes: { 'GET /bookings': { status: 403, body: apiErrorBody('ACCESS_DENIED') } },
    });
    const { unmount } = render(<BookingList />, { wrapper: denied.wrapper });
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    expect(screen.queryByRole('button', { name: 'Load more bookings' })).toBeNull();
    unmount();

    const empty = createTestApp({
      routes: { 'GET /bookings': { status: 200, body: { items: [], nextCursor: null } } },
    });
    render(<BookingList />, { wrapper: empty.wrapper });
    expect(await screen.findByRole('heading', { name: 'No bookings' })).toBeInTheDocument();
  });
});
