/**
 * Shared cases for a Package G placeholder page (SCR-S-51 to SCR-S-57; K-12, DEC-016,
 * SPK-UX-005, SPK-UX-008): reachable from its area's navigation, turned off by default naming the
 * decisions that may turn it on, the "not built" marker and what stays pending once on, the
 * permissions read's error with its code and "Try again", and "not available" when the read is
 * refused. A builder who replaces a placeholder replaces its test file too.
 */
import { CAPABILITY_PRESENTATION } from '@sportspark/api-client';
import { apiErrorBody, fakePermissions, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../testing/test-app';
import type { PackageGScreen } from './registry';

export interface AreaEntry {
  /** Where the area's navigation is shown. */
  from: string;
  /** The navigation's accessible name. */
  nav: string;
  /** The entry's link text. */
  link: string;
}

export function describePackageGPlaceholder(screenMeta: PackageGScreen, entry: AreaEntry) {
  const decisions = CAPABILITY_PRESENTATION[screenMeta.capability].decisions;

  describe(`${screenMeta.id} ${screenMeta.title} placeholder (Package G, DEC-016)`, () => {
    it(`opens from the ${entry.nav} navigation and is turned off by default, naming ${decisions.join(' and ')}`, async () => {
      const user = userEvent.setup();
      const app = createTestApp();
      render(app.at(entry.from));
      const nav = await screen.findByRole('navigation', { name: entry.nav });
      await user.click(within(nav).getByRole('link', { name: entry.link }));
      const page = await screen.findByTestId(`package-g-${screenMeta.slug}`);
      expect(within(page).getByRole('heading', { name: screenMeta.title })).toBeInTheDocument();
      expect(page).toHaveAccessibleName(screenMeta.title);
      const state = await within(page).findByTestId('state-turned-off');
      expect(state).toHaveTextContent(`${screenMeta.title} turned off`);
      expect(state).toHaveTextContent(`(${decisions.join(', ')})`);
      expect(within(page).queryByText(`Not built yet (${screenMeta.id}).`)).toBeNull();
    });

    it('turned on: marks the screen as not built and names what stays pending', async () => {
      const app = createTestApp({
        routes: { 'GET /me/permissions': mePermissions({ enabled: [screenMeta.capability] }) },
      });
      render(app.at(screenMeta.path));
      const page = await screen.findByTestId(`package-g-${screenMeta.slug}`);
      expect(
        await within(page).findByText(`Not built yet (${screenMeta.id}).`),
      ).toBeInTheDocument();
      expect(within(page).queryByTestId('state-turned-off')).toBeNull();
      if (screenMeta.pending) {
        expect(within(page).getByTestId('state-pending-decision')).toHaveTextContent(
          `depends on ${screenMeta.pending.decisions.join(', ')}`,
        );
      }
    });

    it('shows the permissions read error with its code and "Try again", then the page', async () => {
      const user = userEvent.setup();
      let calls = 0;
      const app = createTestApp({
        routes: {
          'GET /me/permissions': () => {
            calls += 1;
            return calls === 1
              ? fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-g' }))
              : fakeResponse(200, fakePermissions({ enabled: [screenMeta.capability] }));
          },
        },
      });
      render(app.at(screenMeta.path));
      const page = await screen.findByTestId(`package-g-${screenMeta.slug}`);
      expect(
        await within(page).findByText('Error code: INTEGRATION_UNAVAILABLE. Reference: c-g'),
      ).toBeInTheDocument();
      await user.click(within(page).getByRole('button', { name: 'Try again' }));
      expect(
        await within(page).findByText(`Not built yet (${screenMeta.id}).`),
      ).toBeInTheDocument();
    });

    it('a refused permissions read is "not available", never implying anything exists', async () => {
      const app = createTestApp({
        routes: { 'GET /me/permissions': { status: 403, body: apiErrorBody('ACCESS_DENIED') } },
      });
      render(app.at(screenMeta.path));
      const page = await screen.findByTestId(`package-g-${screenMeta.slug}`);
      expect(await within(page).findByTestId('state-unavailable')).toHaveTextContent(
        'Not available',
      );
      expect(within(page).queryByText(/Not built yet/)).toBeNull();
    });
  });
}
