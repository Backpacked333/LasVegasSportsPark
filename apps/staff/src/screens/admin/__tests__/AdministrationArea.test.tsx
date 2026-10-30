/**
 * SPK-UX-005: the Administration area page links the built screens SCR-S-46 to SCR-S-48 and the
 * Reports area renders its own screens instead of the placeholder.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { page } from '../../../features/insight-admin/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';

describe('Administration and Reports areas', () => {
  it('links SCR-S-46 (with audit records), SCR-S-47 (with capability switches and provider events), SCR-S-48 and the conditional SCR-S-56', async () => {
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
    expect(
      within(nav).getByRole('link', { name: 'Access hardware (conditional)' }),
    ).toHaveAttribute('href', '/admin/access-hardware');
    expect(within(nav).getByRole('link', { name: 'Audit records' })).toHaveAttribute(
      'href',
      '/admin/audit',
    );
    expect(within(nav).getByRole('link', { name: 'Capability switches' })).toHaveAttribute(
      'href',
      '/admin/capabilities',
    );
    expect(within(nav).getByRole('link', { name: 'Provider events' })).toHaveAttribute(
      'href',
      '/admin/provider-events',
    );
  });

  it('opens the Reports area on the operating reports, not a placeholder', async () => {
    render(
      createTestApp({ routes: { 'GET /reports/metric-definitions': page([]) } }).at('/reports'),
    );
    expect(await screen.findByRole('heading', { name: 'Operating reports' })).toBeInTheDocument();
    expect(screen.queryByText(/Not built yet/)).toBeNull();
    const main = screen.getByRole('navigation', { name: 'Main' });
    // The areas come from GET /v1/me/permissions: wait for the link before checking it.
    expect(await within(main).findByRole('link', { name: 'Reports' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
