/**
 * Sign-in entry in a release build (SCR-C-01, SCR-C-02, §4.13; PA-11 SPK-UX-011 **Proposed**,
 * ADR-008): with the development and demo sign-ins absent, as `__DEV__` is false in a release
 * bundle, the screen says in plain words that signing in isn't available yet and that the front
 * desk can help, over the welcome artwork, with account recovery; DEC-018 is in the support fold.
 * The development and demo builds are covered in src/dev and src/demo.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { onboardingArtwork } from '../../../artwork/manifest';
import { createTestApp } from '../../../testing/test-app';
import { openSupportDetails } from '../../../testing/ui-surfaces';
import { SIGN_IN_UNAVAILABLE, SignInScreen } from '../SignInScreen';

// A release bundle: the development-only entry points are null (src/dev, src/demo).
jest.mock('../../../dev', () => ({ DevSignIn: null }));
jest.mock('../../../demo', () => ({ DemoSignIn: null, DemoOverlay: null }));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

describe('SCR-C-01 sign-in in a release build (DEC-018 open)', () => {
  it('PA-11: says signing in is not available yet and the front desk can help, with the decision only in the support fold', async () => {
    const app = createTestApp({ session: null });
    render(<SignInScreen />, { wrapper: app.wrapper });
    expect(screen.getByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    expect(
      screen.getByText("Signing in to the app isn't available yet. The front desk can help."),
    ).toBeOnTheScreen();
    expect(SIGN_IN_UNAVAILABLE).toBe(
      "Signing in to the app isn't available yet. The front desk can help.",
    );
    // No code in the visible words; the fold is closed until opened.
    expect(screen.queryByText(/DEC-018/)).toBeNull();
    await openSupportDetails(screen);
    expect(screen.getByText('Decision: DEC-018')).toBeOnTheScreen();
    expect(screen.getByText('Owner: Technical lead/account owners')).toBeOnTheScreen();
    expect(screen.queryByText('Development sign-in')).toBeNull();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('ADR-008: shows the welcome artwork, hidden from screen readers', () => {
    const app = createTestApp({ session: null });
    render(<SignInScreen />, { wrapper: app.wrapper });
    const art = screen.getByTestId('sign-in-art', { includeHiddenElements: true });
    expect(art).toHaveProp('importantForAccessibility', 'no-hide-descendants');
    expect(art.findByType(Image).props.source).toBe(onboardingArtwork.welcome);
  });

  it('SCR-C-02: "Recover an existing account" opens account recovery', () => {
    const app = createTestApp({ session: null });
    render(<SignInScreen />, { wrapper: app.wrapper });
    fireEvent.press(screen.getByRole('button', { name: 'Recover an existing account' }));
    expect(mockPush).toHaveBeenCalledWith('/recovery');
  });
});
