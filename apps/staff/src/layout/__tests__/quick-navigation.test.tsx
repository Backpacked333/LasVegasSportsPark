/**
 * Quick navigation and the shell conveniences around it (SPK-UX-005 areas from the API, SPK-UX-009
 * keyboard access, SPK-UX-008 states): the "Jump to" dialog, its keyboard shortcuts, what it
 * offers, the collapsible sidebar and the browser tab title.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FACILITY_B, createTestApp, mePermissions } from '../../testing/test-app';
import { THEME_STORAGE_KEY } from '../../theme/ThemeProvider';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.title = '';
});

async function openFromHeader(user: ReturnType<typeof userEvent.setup>) {
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  await within(nav).findByRole('link', { name: 'Today' });
  await user.click(screen.getByRole('button', { name: 'Jump to a screen or an action' }));
  return screen.getByRole('dialog', { name: 'Quick navigation' });
}

function optionNames(dialog: HTMLElement): string[] {
  return within(dialog)
    .getAllByRole('option')
    .map((o) => o.querySelector('.palette-option-title')?.textContent ?? '');
}

describe('quick navigation (SPK-UX-005, SPK-UX-009)', () => {
  it('opens from the header as a modal dialog with the search field focused', async () => {
    const user = userEvent.setup();
    render(createTestApp().at('/today'));
    const dialog = await openFromHeader(user);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const field = within(dialog).getByRole('combobox', { name: 'Search screens and actions' });
    expect(field).toHaveFocus();
    expect(within(dialog).getByRole('listbox', { name: 'Results' })).toBeInTheDocument();
  });

  it('before anything is typed offers the areas, the workspace and the actions', async () => {
    const user = userEvent.setup();
    render(createTestApp().at('/today'));
    const dialog = await openFromHeader(user);
    const names = optionNames(dialog);
    expect(names).toEqual(
      expect.arrayContaining([
        'Schedule',
        'Finance',
        'Administration',
        'My assignments',
        'Turn on Legends mode',
        'Sign out',
      ]),
    );
    expect(within(dialog).getByRole('group', { name: 'Go to' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'Actions' })).toBeInTheDocument();
  });

  it('SPK-UX-005: offers only the areas the API lists, and none of the screens of the others', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /me/permissions': mePermissions({ areas: ['today', 'finance'] }) },
    });
    render(app.at('/today'));
    const dialog = await openFromHeader(user);
    const names = optionNames(dialog);
    expect(names).toContain('Finance');
    expect(names).not.toContain('Schedule');
    await user.keyboard('closures');
    expect(within(dialog).queryByRole('option')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Nothing matches “closures”');
  });

  it('typing narrows the list and Enter opens the first match', async () => {
    const user = userEvent.setup();
    render(createTestApp().at('/today'));
    const dialog = await openFromHeader(user);
    await user.keyboard('payment att');
    expect(optionNames(dialog)[0]).toBe('Payment attempts');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Quick navigation' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Payment attempts · Sportspark staff'));
  });

  it('SPK-UX-009: arrow keys move the active option; Escape closes and returns focus', async () => {
    const user = userEvent.setup();
    render(createTestApp().at('/today'));
    const dialog = await openFromHeader(user);
    const field = within(dialog).getByRole('combobox');
    const options = within(dialog).getAllByRole('option');
    expect(field).toHaveAttribute('aria-activedescendant', options[0]?.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(field).toHaveAttribute('aria-activedescendant', options[1]?.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(field).toHaveAttribute('aria-activedescendant', options.at(-1)?.id);
    await user.keyboard('{Home}');
    expect(field).toHaveAttribute('aria-activedescendant', options[0]?.id);
    // Tab keeps focus in the field (one focus stop inside the dialog).
    await user.keyboard('{Tab}');
    expect(field).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Quick navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jump to a screen or an action' })).toHaveFocus();
  });

  it('Ctrl+K opens and closes it from anywhere; "/" opens it outside a field only', async () => {
    const user = userEvent.setup();
    render(createTestApp().at('/today'));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await within(nav).findByRole('link', { name: 'Today' });
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Quick navigation' })).toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog', { name: 'Quick navigation' })).not.toBeInTheDocument();

    screen.getByRole('combobox', { name: 'Facility' }).focus();
    await user.keyboard('/');
    expect(screen.queryByRole('dialog', { name: 'Quick navigation' })).not.toBeInTheDocument();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('/');
    expect(screen.getByRole('dialog', { name: 'Quick navigation' })).toBeInTheDocument();
  });

  it('an action runs in place: Legends mode turns on without leaving the page', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    const dialog = await openFromHeader(user);
    await user.keyboard('legends');
    expect(optionNames(dialog)).toEqual(['Turn on Legends mode']);
    await user.keyboard('{Enter}');
    expect(document.documentElement).toHaveAttribute('data-theme', 'legends');
    expect(app.services.preferences?.get(THEME_STORAGE_KEY)).toBe('legends');
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });

  it('switches the facility the viewer works in, within their scope', async () => {
    const user = userEvent.setup();
    render(createTestApp().at('/today'));
    const dialog = await openFromHeader(user);
    await user.keyboard('work in north park 2');
    await user.click(within(dialog).getByRole('option', { name: /Work in North Park 2/ }));
    const select = screen.getByRole('combobox', { name: 'Facility' }) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe('North Park 2');
  });

  it('remembers recently opened screens (the screen, never a record) and offers them first', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await user.click(await within(nav).findByRole('link', { name: 'Finance' }));
    await user.click(within(nav).getByRole('link', { name: 'Schedule' }));
    await user.click(screen.getByRole('button', { name: 'Jump to a screen or an action' }));
    const dialog = screen.getByRole('dialog', { name: 'Quick navigation' });
    const recent = within(dialog).getByRole('group', { name: 'Recent' });
    expect(
      within(recent)
        .getAllByRole('option')
        .map((o) => o.querySelector('.palette-option-title')?.textContent),
    ).toEqual(['Finance', 'Today']);
    // Schedule opens its calendar: neither is offered as "recent" while it is on screen.
    expect(app.services.preferences?.get('sportspark.recent')).toBe(
      JSON.stringify(['/schedule/calendar', '/schedule', '/finance', '/today']),
    );
  });

  it('SPK-UX-008: while the areas load, says so and still offers the workspace and actions', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /me/permissions': () => new Promise(() => undefined) },
    });
    render(app.at('/today'));
    await screen.findByTestId('nav-loading');
    await user.click(screen.getByRole('button', { name: 'Jump to a screen or an action' }));
    const dialog = screen.getByRole('dialog', { name: 'Quick navigation' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Your areas are still loading');
    const names = optionNames(dialog);
    expect(names).toContain('My assignments');
    expect(names).toContain('Sign out');
    expect(names).not.toContain('Finance');
  });
});

describe('shell conveniences (SCR-S-01)', () => {
  it('the sidebar collapses to a rail and back; the choice is kept and links keep their names', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    const { container } = render(app.at('/today'));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await within(nav).findByRole('link', { name: 'Finance' });
    const collapse = screen.getByRole('button', { name: 'Collapse the sidebar' });
    expect(collapse).toHaveAttribute('aria-pressed', 'false');
    await user.click(collapse);
    expect(collapse).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.shell')).toHaveAttribute('data-rail', 'true');
    expect(app.services.preferences?.get('sportspark.sidebar')).toBe('rail');
    expect(within(nav).getByRole('link', { name: 'Finance' })).toBeInTheDocument();
    await user.click(collapse);
    expect(container.querySelector('.shell')).toHaveAttribute('data-rail', 'false');
    expect(app.services.preferences?.get('sportspark.sidebar')).toBeNull();
  });

  it('starts collapsed when that was the stored choice', async () => {
    const app = createTestApp({ preferences: { 'sportspark.sidebar': 'rail' } });
    const { container } = render(app.at('/today'));
    await screen.findByRole('navigation', { name: 'Main' });
    expect(container.querySelector('.shell')).toHaveAttribute('data-rail', 'true');
  });

  it('titles the browser tab with the screen shown', async () => {
    const user = userEvent.setup();
    render(createTestApp().at('/today'));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await waitFor(() => expect(document.title).toBe('Today · Sportspark staff'));
    await user.click(await within(nav).findByRole('link', { name: 'Reports' }));
    await waitFor(() => expect(document.title).toBe('Reports · Sportspark staff'));
  });

  it('SPK-UX-009: keeps one page heading for the product and a named sign-out control', async () => {
    render(createTestApp().at('/today'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sportspark staff' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByTestId('live-indicator')).toHaveTextContent('Live · ');
  });

  it('remembers the facility the viewer works in across reloads, and forgets it on sign-out', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    const first = render(app.at('/today'));
    const select = await screen.findByRole('combobox', { name: 'Facility' });
    await screen.findByRole('option', { name: 'North Park 2' });
    await user.selectOptions(select, FACILITY_B);
    expect(app.services.preferences?.get('sportspark.facility')).toBe(FACILITY_B);
    first.unmount();

    // A reload: the same browser preferences, a new page.
    render(app.at('/today'));
    const again = (await screen.findByRole('combobox', { name: 'Facility' })) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'North Park 2' });
    expect(again.value).toBe(FACILITY_B);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(app.services.preferences?.get('sportspark.facility')).toBeNull());
  });

  it('a stored facility outside the scope the API answers is dropped', async () => {
    const app = createTestApp({
      preferences: { 'sportspark.facility': '0192f1a0-0000-7000-8000-00000000fa99' },
    });
    render(app.at('/today'));
    const select = (await screen.findByRole('combobox', { name: 'Facility' })) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'North Park 2' });
    await waitFor(() => expect(select.value).toBe(''));
    expect(app.services.preferences?.get('sportspark.facility')).toBeNull();
  });

  it('Escape closes the phone menu', async () => {
    const user = userEvent.setup();
    render(createTestApp().at('/today'));
    const menu = await screen.findByRole('button', { name: 'Menu' });
    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
  });
});
