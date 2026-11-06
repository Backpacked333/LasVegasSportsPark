/**
 * SPK-UX-003, SPK-UX-009: the header inbox button carries the unread count
 * (`GET /v1/me/inbox/unread-count`) in its accessible name and as a badge with the number; no
 * count (failed read, nothing unread) is the plain name and no badge.
 */
import { renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { createTestApp } from '../../testing/test-app';
import { inboxButtonLabel, unreadBadgeText } from '../../api/inbox-unread';
import { RootNavigator } from '../RootNavigator';

function renderApp(unread: { status: number; body: unknown } | null) {
  const app = createTestApp({
    routes: {
      'GET /me/inbox': { status: 200, body: { items: [], nextCursor: null } },
      ...(unread ? { 'GET /me/inbox/unread-count': unread } : {}),
    },
  });
  const TestRootLayout = () => (
    <app.wrapper>
      <RootNavigator />
    </app.wrapper>
  );
  renderRouter({ appDir: 'app', overrides: { _layout: TestRootLayout } }, { initialUrl: '/' });
  return app;
}

describe('inbox unread badge (SPK-UX-003)', () => {
  it('names the unread count on the inbox button and shows it as a badge', async () => {
    renderApp({ status: 200, body: { unread: 3, capped: false, cap: 99 } });
    expect(
      await screen.findByRole('button', { name: 'Notification inbox, 3 unread' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByTestId('quick-inbox-badge', { includeHiddenElements: true }),
    ).toHaveTextContent('3');
  });

  it('beyond the cap says "more than" and shows "<cap>+"', async () => {
    renderApp({ status: 200, body: { unread: 99, capped: true, cap: 99 } });
    expect(
      await screen.findByRole('button', { name: 'Notification inbox, more than 99 unread' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByTestId('quick-inbox-badge', { includeHiddenElements: true }),
    ).toHaveTextContent('99+');
  });

  it('nothing unread, or a count that could not be read, is the plain name without a badge', async () => {
    const app = renderApp(null);
    await screen.findByRole('button', { name: 'Notification inbox' });
    // The read was made (and answered NOT_FOUND by the fake API): no guess is shown.
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.path.endsWith('/me/inbox/unread-count'))).toBe(true),
    );
    expect(screen.queryByTestId('quick-inbox-badge', { includeHiddenElements: true })).toBeNull();
    expect(unreadBadgeText({ unread: 0, capped: false, cap: 99 })).toBeNull();
    expect(inboxButtonLabel({ unread: 0, capped: false, cap: 99 })).toBe('Notification inbox');
  });
});
