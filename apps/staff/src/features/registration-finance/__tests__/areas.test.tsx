/**
 * Area homes and accessibility of the registration and finance screens (SPK-UX-005, SPK-UX-009):
 * the area pages list their screens, the navigation marks the current page, the conditional
 * finance screens built elsewhere stay marked as not built, and every form control and button on
 * the busiest screens has an accessible name. Status is text, not colour (badges carry a label).
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  BASKET_ID,
  OFFERING_ID,
  basket,
  entitlement,
  hold,
  nameRoutes,
  offering,
  ok,
  program,
  reconciliationReport,
} from './fixtures';

function expectNamedControls(container: HTMLElement) {
  const controls = container.querySelectorAll('input, select, textarea');
  expect(controls.length).toBeGreaterThan(0);
  controls.forEach((control) => {
    const element = control as HTMLInputElement;
    const named = (element.labels?.length ?? 0) > 0 || element.getAttribute('aria-label');
    expect(named, `unnamed ${element.tagName} ${element.id}`).toBeTruthy();
  });
  container.querySelectorAll('button').forEach((button) => {
    expect((button.textContent ?? '').trim() || button.getAttribute('aria-label')).toBeTruthy();
  });
  container.querySelectorAll('.badge').forEach((badge) => {
    expect(badge.querySelector('.badge-label')?.textContent?.trim()).toBeTruthy();
  });
}

describe('registration and finance areas', () => {
  it('SPK-UX-005: the Registrations home lists SCR-S-24 to SCR-S-27 and marks the current page', async () => {
    const app = createTestApp();
    render(app.at('/registrations'));
    const list = await screen.findByRole('list', { name: 'Registration screens' });
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Registration queue and approvals',
      'Assisted registration',
      'Waitlist management',
      'Cancellation and transfer',
    ]);
    const nav = screen.getByRole('navigation', { name: 'Registrations and waitlists' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const main = screen.getByRole('navigation', { name: 'Main' });
    // The areas come from GET /v1/me/permissions: wait for the link before checking it.
    expect(
      await within(main).findByRole('link', { name: 'Registrations and waitlists' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('the Finance home lists SCR-S-35 to SCR-S-38 and links the conditional SCR-S-53 to SCR-S-55 and SCR-S-57 pages', async () => {
    const app = createTestApp();
    render(app.at('/finance'));
    const list = await screen.findByRole('list', { name: 'Finance screens' });
    expect(within(list).getAllByRole('link')).toHaveLength(4);
    const conditional = screen.getByRole('list', { name: 'Conditional capabilities' });
    expect(
      within(conditional)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Memberships', '/finance/memberships'],
      ['Session packages', '/finance/session-packages'],
      ['Point of sale', '/finance/point-of-sale'],
      ['Accounting export batches', '/finance/accounting-exports'],
    ]);
    expect(screen.queryByText(/Not built yet/)).toBeNull();
    expect(screen.getByText(/depends on DEC-022/)).toBeInTheDocument();
  });

  it('SPK-UX-009: every control on the offering setup screen has an accessible name', async () => {
    const app = createTestApp({
      routes: {
        'GET /offerings/{id}': ok(offering()),
        'GET /offerings/{id}/sessions': ok([]),
        'GET /offerings/{id}/price-rules': ok([]),
        'GET /policy-versions': ok({ items: [], nextCursor: null }),
        'GET /entitlement-definitions': ok([entitlement()]),
      },
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    await screen.findByRole('form', { name: 'Offering configuration' });
    expectNamedControls(screen.getByRole('main'));
  });

  it('SPK-UX-009: every control on the assisted registration and reconciliation screens has an accessible name', async () => {
    const app = createTestApp({
      routes: {
        ...nameRoutes(),
        'GET /baskets/{id}': ok(basket({ holds: [hold()] })),
        'GET /programs': ok({ items: [program()], nextCursor: null }),
        'GET /finance/reconciliation-report': ok(reconciliationReport()),
      },
    });
    const { unmount } = render(app.at(`/registrations/assisted/${BASKET_ID}`));
    await screen.findByRole('form', { name: 'Add a participant and offering' });
    expectNamedControls(screen.getByRole('main'));
    unmount();
    render(app.at('/finance/reconciliation'));
    await screen.findByRole('form', { name: 'Record a cash or external tender' });
    expectNamedControls(screen.getByRole('main'));
  });
});
