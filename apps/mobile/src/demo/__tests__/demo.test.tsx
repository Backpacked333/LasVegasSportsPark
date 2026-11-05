/**
 * Demo mode in the customer app (src/demo): parent sign-in with the seeded account, the family
 * tour, and that it shows only when the app config asks for demo mode.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { readDemoAccounts } from '../../config/app-config';
import { SignInScreen } from '../../screens/sign-in/SignInScreen';
import { createTestApp, TEST_SESSION } from '../../testing/test-app';
import { DemoOverlay, DemoSignIn } from '../index';
import { getDemoState, resetDemoState, setDemoState } from '../store';
import { FAMILY_TOUR } from '../tour';

const mockReplace = jest.fn();
const mockNavigate = jest.fn();
let mockPathname = '/';
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, navigate: mockNavigate, push: jest.fn() }),
  usePathname: () => mockPathname,
}));

const PARENT = '0192f1a0-0000-7000-8000-0000000000ee';

afterEach(() => {
  resetDemoState();
  mockPathname = '/';
});

describe('demo accounts config', () => {
  it('keeps only subjects that map to account UUIDs', () => {
    expect(readDemoAccounts(JSON.stringify({ 'dev-parent': PARENT, other: 'x' }))).toEqual({
      'dev-parent': PARENT,
    });
    expect(readDemoAccounts('nope')).toEqual({});
    expect(readDemoAccounts(null)).toEqual({});
  });
});

describe('demo sign-in', () => {
  it('replaces the development sign-in only when the app is in demo mode', () => {
    const real = createTestApp({ session: null });
    const { unmount } = render(<SignInScreen />, { wrapper: real.wrapper });
    expect(screen.getByText('Development sign-in')).toBeOnTheScreen();
    unmount();

    const demo = createTestApp({ session: null, config: { appMode: 'demo', demoAccounts: {} } });
    render(<SignInScreen />, { wrapper: demo.wrapper });
    expect(screen.getByText('Demo mode')).toBeOnTheScreen();
  });

  it('signs in as the seeded parent and starts the family tour', async () => {
    const app = createTestApp({
      session: null,
      config: { appMode: 'demo', demoAccounts: { 'dev-parent': PARENT } },
      routes: {
        'POST /dev/tokens': {
          status: 201,
          body: { token: 'demo-token', accountId: PARENT, expiresAt: null },
        },
      },
    });
    const Screen = DemoSignIn!;
    render(<Screen />, { wrapper: app.wrapper });

    fireEvent.press(screen.getByRole('button', { name: 'Sign in as the parent' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(app.fake.requests.find((r) => r.route === '/dev/tokens')?.body).toEqual({
      accountId: PARENT,
    });
    expect(await app.sessionStore.load()).toMatchObject({ token: 'demo-token' });
    expect(getDemoState()).toMatchObject({ active: true, step: 0, open: true });
  });

  it('says how to start the demo when no accounts were seeded', () => {
    const app = createTestApp({ session: null, config: { appMode: 'demo', demoAccounts: {} } });
    const Screen = DemoSignIn!;
    render(<Screen />, { wrapper: app.wrapper });

    expect(screen.getByText('Demo accounts not set up')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in as the parent' })).toBeDisabled();
  });
});

describe('demo overlay', () => {
  it('is not shown outside demo mode', () => {
    const app = createTestApp({ session: TEST_SESSION });
    const Overlay = DemoOverlay!;
    render(<Overlay />, { wrapper: app.wrapper });
    expect(screen.queryByText(/Demo mode/)).toBeNull();
  });

  it('steps through the family tour and ends the demo by signing out', async () => {
    setDemoState({ active: true, step: 0, open: true });
    const app = createTestApp({ session: TEST_SESSION, config: { appMode: 'demo' } });
    const Overlay = DemoOverlay!;
    render(<Overlay />, { wrapper: app.wrapper });

    expect(
      await screen.findByText(`Family tour · step 1 of ${FAMILY_TOUR.length}`),
    ).toBeOnTheScreen();
    expect(screen.getByText('Demo mode · sample data, nothing here is real')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(mockNavigate).toHaveBeenCalledWith('/discover');
    expect(screen.getByText(`Family tour · step 2 of ${FAMILY_TOUR.length}`)).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'End demo' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/sign-in'));
    expect(await app.sessionStore.load()).toBeNull();
  });
});
