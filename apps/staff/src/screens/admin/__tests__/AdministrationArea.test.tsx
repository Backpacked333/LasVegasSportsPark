/**
 * SPK-UX-005: the Administration area page links the built screens SCR-S-46 to SCR-S-48 and the
 * Reports area renders its own screens instead of the placeholder.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { page } from '../../../features/insight-admin/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';

describe('Administration and Reports areas', () => {
  it('links SCR-S-46, SCR-S-47 and SCR-S-48 from the Administration page', async () => {
    render(createTestApp().at('/admin'));
    const nav = await screen.findByRole('navigation', { name: 'Administration screens' });
    expect(
      within(nav).getByRole('link', { name: 'Accounts, roles and permissions' }),
    ).toHaveAttribute('href', '/admin/accounts');
    expect(
      within(nav).getByRole('link', { name: 'Integrations and configuration' }),
    ).toHaveAttribute('href', '/admin/integrations');
    expect(
      within(nav).getByRole('link', { name: 'Migration imports and reconciliation' }),
    ).toHaveAttribute('href', '/admin/migration');
  });

  it('opens the Reports area on the operating reports, not a placeholder', async () => {
    render(
      createTestApp({ routes: { 'GET /reports/metric-definitions': page([]) } }).at('/reports'),
    );
    expect(await screen.findByRole('heading', { name: 'Operating reports' })).toBeInTheDocument();
    expect(screen.queryByText(/Not built yet/)).toBeNull();
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(within(main).getByRole('link', { name: 'Reports' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
