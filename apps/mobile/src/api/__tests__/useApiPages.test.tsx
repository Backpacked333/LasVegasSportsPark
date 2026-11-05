/**
 * "Load more" over a paged list in the customer app (§4.5 keyset cursors; SPK-UX-008 nothing
 * silently cut off): the API's cursor is sent unchanged, a failed next page keeps the loaded items
 * and shows the code with "Try again", offline disables the button, and nothing shows when no page
 * remains.
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text, View } from 'react-native';
import { createTestApp } from '../../testing/test-app';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { useApiPages } from '../useApiPages';

function booking(n: number) {
  return { id: `0192f1a0-0000-7000-8000-${String(n).padStart(12, '0')}` };
}

function MyBookings() {
  const pages = useApiPages({ path: '/me/bookings', request: { query: { limit: 2 } } });
  return (
    <View>
      <QueryBoundary
        query={pages}
        label="your bookings"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No bookings', description: 'Bookings you make appear here.' }}
      >
        {(items) => (
          <View accessibilityRole="list" accessibilityLabel="Bookings">
            {items.map((item) => (
              <Text key={item.id}>{`Booking ${item.id.slice(-2)}`}</Text>
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="bookings" />
    </View>
  );
}

function pagedRoute(fail: { page2?: boolean } = {}) {
  let page2Calls = 0;
  return (request: FakeRequest) => {
    if (!request.query.cursor) {
      return fakeResponse(200, { items: [booking(1), booking(2)], nextCursor: 'cursor-2' });
    }
    page2Calls += 1;
    if (fail.page2 && page2Calls === 1) {
      return fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-page' }));
    }
    return fakeResponse(200, { items: [booking(2), booking(3)], nextCursor: null });
  };
}

describe('useApiPages and LoadMore (§4.5, SPK-UX-008)', () => {
  it('loads the next page with the API cursor, shows a repeated item once, and stops at nextCursor null', async () => {
    const app = createTestApp({ routes: { 'GET /me/bookings': pagedRoute() } });
    render(<MyBookings />, { wrapper: app.wrapper });
    expect(await screen.findByText('Booking 02')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Load more bookings' }));
    expect(await screen.findByText('Booking 03')).toBeOnTheScreen();
    expect(screen.getAllByText('Booking 02')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more bookings' })).toBeNull();
    const pages = app.fake.requests.filter((r) => r.route === '/me/bookings');
    expect(pages.map((r) => r.query)).toEqual([{ limit: '2' }, { limit: '2', cursor: 'cursor-2' }]);
  });

  it('a failed next page keeps the loaded items and shows the code with "Try again"', async () => {
    const app = createTestApp({ routes: { 'GET /me/bookings': pagedRoute({ page2: true }) } });
    render(<MyBookings />, { wrapper: app.wrapper });
    await screen.findByText('Booking 02');
    fireEvent.press(screen.getByRole('button', { name: 'Load more bookings' }));
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: corr-page/),
    ).toBeOnTheScreen();
    expect(screen.getByText('Booking 01')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Booking 03')).toBeOnTheScreen();
  });

  it('offline, "Load more" is disabled and says it needs a connection', async () => {
    const app = createTestApp({ routes: { 'GET /me/bookings': pagedRoute() } });
    render(<MyBookings />, { wrapper: app.wrapper });
    await screen.findByText('Booking 02');
    act(() => app.sources.setReachable(false));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more bookings' })).toBeDisabled(),
    );
    expect(screen.getByText('Loading more bookings needs a connection.')).toBeOnTheScreen();
  });

  it('a list the API refuses is "not available"; an empty one says what would appear', async () => {
    const denied = createTestApp({
      routes: { 'GET /me/bookings': { status: 403, body: apiErrorBody('ACCESS_DENIED') } },
    });
    const { unmount } = render(<MyBookings />, { wrapper: denied.wrapper });
    expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Load more bookings' })).toBeNull();
    unmount();

    const empty = createTestApp({
      routes: { 'GET /me/bookings': { status: 200, body: { items: [], nextCursor: null } } },
    });
    render(<MyBookings />, { wrapper: empty.wrapper });
    expect(await screen.findByRole('header', { name: 'No bookings' })).toBeOnTheScreen();
  });
});
