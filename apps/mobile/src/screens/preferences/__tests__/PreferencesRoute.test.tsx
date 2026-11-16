/**
 * SCR-C-36 (PA-11 SPK-UX-011, **Proposed**): the preferences route is titled "Notifications and
 * calendar", the words of its row on You, and draws the preferences screen.
 */
import { render, screen } from '@testing-library/react-native';
import { createTestApp } from '../../../testing/test-app';
import { PREFERENCES_TITLE, PreferencesRoute } from '../PreferencesScreen';

const mockStackScreen = jest.fn((_props: { options?: { title?: string } }) => null);
jest.mock('expo-router', () => {
  const actual = jest.requireActual('expo-router');
  return {
    ...actual,
    Stack: { ...actual.Stack, Screen: (props: never) => mockStackScreen(props) },
  };
});

describe('SCR-C-36 PreferencesRoute', () => {
  it('PA-11: the stack title is "Notifications and calendar"', async () => {
    const app = createTestApp({ session: null });
    render(<PreferencesRoute />, { wrapper: app.wrapper });
    expect(PREFERENCES_TITLE).toBe('Notifications and calendar');
    expect(mockStackScreen).toHaveBeenCalledWith(
      expect.objectContaining({ options: { title: 'Notifications and calendar' } }),
    );
    expect(await screen.findByRole('header', { name: 'Appearance' })).toBeOnTheScreen();
  });
});
