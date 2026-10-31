/**
 * Shared cases for a customer Package G placeholder screen (§3.16, §6.5; K-12, DEC-016,
 * SPK-UX-008): turned off by default naming the decisions that may turn it on (with what stays
 * available for `whenOff="notice"` screens), the "not built" marker and what stays pending once on,
 * the permissions read's error with its code and "Try again", and the sign-in prompt without a
 * session. A builder who replaces a placeholder replaces its test file too.
 */
import type { CapabilityId } from '@sportspark/api-client';
import { apiErrorBody, fakePermissions, fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ComponentType } from 'react';
import { createTestApp, mePermissions } from '../../testing/test-app';

export interface CustomerPlaceholderCase {
  Screen: ComponentType;
  testID: string;
  title: string;
  reference: string;
  capability: CapabilityId;
  /** The decisions the turned-off state names, as shown: "DEC-016, DEC-072". */
  decisions: string;
  /** Text kept under the notice (whenOff="notice"); undefined for a blocking gate. */
  stillAvailable?: string;
  /** The pending decisions once on, as shown: "POL-038, DEC-007". */
  pending: string;
}

export function describeCustomerPackageGPlaceholder(c: CustomerPlaceholderCase) {
  describe(`${c.title} placeholder (Package G, DEC-016)`, () => {
    it(`is turned off by default, naming ${c.decisions}`, async () => {
      const app = createTestApp();
      render(<c.Screen />, { wrapper: app.wrapper });
      const page = screen.getByTestId(c.testID);
      const state = await within(page).findByTestId('state-turned-off');
      expect(within(state).getByLabelText(`${c.title} turned off`)).toBeOnTheScreen();
      expect(within(state).getByText(new RegExp(`\\(${c.decisions}\\)`))).toBeOnTheScreen();
      if (c.stillAvailable) {
        // What the customer already has stays readable while the switch is off.
        expect(within(page).getByText(c.stillAvailable)).toBeOnTheScreen();
        expect(within(page).getByText(`Not built yet (${c.reference}).`)).toBeOnTheScreen();
      } else {
        expect(within(page).queryByText(`Not built yet (${c.reference}).`)).toBeNull();
      }
    });

    it('turned on: marks the screen as not built, accessibly, and names what stays pending', async () => {
      const app = createTestApp({
        routes: { 'GET /me/permissions': mePermissions({ enabled: [c.capability] }) },
      });
      render(<c.Screen />, { wrapper: app.wrapper });
      const page = screen.getByTestId(c.testID);
      expect(await within(page).findByText(`Not built yet (${c.reference}).`)).toBeOnTheScreen();
      expect(within(page).getByRole('header', { name: c.title })).toBeOnTheScreen();
      expect(within(page).queryByTestId('state-turned-off')).toBeNull();
      expect(within(page).getByText(new RegExp(`depends on ${c.pending}`))).toBeOnTheScreen();
    });

    it('shows the permissions read error with its code and "Try again", then the screen', async () => {
      let calls = 0;
      const app = createTestApp({
        routes: {
          'GET /me/permissions': () => {
            calls += 1;
            return calls === 1
              ? fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-g' }))
              : fakeResponse(
                  200,
                  fakePermissions({ principalKind: 'customer', enabled: [c.capability] }),
                );
          },
        },
      });
      render(<c.Screen />, { wrapper: app.wrapper });
      expect(
        await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-g/),
      ).toBeOnTheScreen();
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText(`Not built yet (${c.reference}).`)).toBeOnTheScreen();
    });

    it('a refused permissions read is "not available"; without a session it asks to sign in', async () => {
      const denied = createTestApp({
        routes: { 'GET /me/permissions': { status: 403, body: apiErrorBody('ACCESS_DENIED') } },
      });
      const { unmount } = render(<c.Screen />, { wrapper: denied.wrapper });
      expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
      expect(screen.queryByText(/Not built yet/)).toBeNull();
      unmount();

      const signedOut = createTestApp({ session: null });
      render(<c.Screen />, { wrapper: signedOut.wrapper });
      expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
      expect(signedOut.fake.requests.filter((r) => r.route === '/me/permissions')).toHaveLength(0);
    });
  });
}
