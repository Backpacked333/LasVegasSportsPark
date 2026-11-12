/**
 * Legends mode (SPK-UX-010 visual system, SPK-UX-009 operable and announced): the switch in the
 * dashboard header and on the sign-in page turns the night theme with the gold accent on and off,
 * exposes its state, and the choice is kept in this browser's display preferences.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPreferences } from '../../providers/preferences';
import { createTestApp } from '../../testing/test-app';
import { LegendsToggle } from '../LegendsToggle';
import { THEME_STORAGE_KEY, ThemeProvider } from '../ThemeProvider';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('Legends mode (SPK-UX-010)', () => {
  it('the header offers a switch named "Legends mode", off by default', async () => {
    const app = createTestApp();
    render(app.at('/today'));
    const toggle = await screen.findByRole('switch', { name: 'Legends mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('turning it on applies the legends theme to the document and keeps the choice', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    const toggle = await screen.findByRole('switch', { name: 'Legends mode' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement).toHaveAttribute('data-theme', 'legends');
    expect(app.services.preferences?.get(THEME_STORAGE_KEY)).toBe('legends');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#0a0907',
    );
  });

  it('turning it off returns to the classic theme and forgets the choice', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ preferences: { [THEME_STORAGE_KEY]: 'legends' } });
    render(app.at('/today'));
    const toggle = await screen.findByRole('switch', { name: 'Legends mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'legends'));
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(app.services.preferences?.get(THEME_STORAGE_KEY)).toBeNull();
  });

  it('SPK-UX-009: the switch is operable from the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider store={memoryPreferences()}>
        <LegendsToggle />
      </ThemeProvider>,
    );
    const toggle = screen.getByRole('switch', { name: 'Legends mode' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('the sign-in page offers the switch before signing in', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ session: null });
    render(app.at('/sign-in'));
    const toggle = await screen.findByRole('switch', { name: 'Legends mode' });
    await user.click(toggle);
    expect(document.documentElement).toHaveAttribute('data-theme', 'legends');
  });

  it('a stored value that is not a theme reads as the classic theme', async () => {
    const app = createTestApp({ preferences: { [THEME_STORAGE_KEY]: 'neon' } });
    render(app.at('/today'));
    const toggle = await screen.findByRole('switch', { name: 'Legends mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('outside the provider the switch renders off and does nothing', async () => {
    const user = userEvent.setup();
    render(<LegendsToggle />);
    const toggle = screen.getByRole('switch', { name: 'Legends mode' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
