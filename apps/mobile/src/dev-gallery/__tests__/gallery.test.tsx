/**
 * The design system gallery (ADR-008, development builds only): the route `app/dev-gallery.tsx`
 * renders every `src/ui` component in either theme without crashing, its local theme switch
 * re-renders the gallery in the other theme, and its trigger specimens work (a toast, a sheet).
 * Outside development builds the gallery module is not loaded at all.
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Stack } from 'expo-router';
import DevGalleryRoute from '../../../app/dev-gallery';
import type * as GalleryEntry from '../index';
import { createTestApp } from '../../testing/test-app';
import { classicTheme, legendsTheme, type ThemeName } from '../../ui/theme';
import { ToastProvider } from '../../ui/Toast';

async function renderGallery(theme: ThemeName) {
  const app = createTestApp({ theme });
  const Layout = () => (
    <app.wrapper>
      <ToastProvider>
        <Stack />
      </ToastProvider>
    </app.wrapper>
  );
  const router = renderRouter(
    { _layout: Layout, 'dev-gallery': DevGalleryRoute },
    { initialUrl: '/dev-gallery' },
  );
  // The providers read the session and the connectivity once; let those answers land.
  await act(async () => undefined);
  return { app, router };
}

const STATES = [
  'loading',
  'empty',
  'error',
  'offline-stale',
  'unavailable',
  'pending-decision',
  'turned-off',
] as const;

describe('design system gallery (ADR-008)', () => {
  it.each(['classic', 'legends'] as const)(
    'renders every component group in the %s theme',
    async (theme) => {
      const { router } = await renderGallery(theme);
      expect(router.getPathname()).toBe('/dev-gallery');
      expect(screen.getByRole('header', { name: 'Design system gallery' })).toBeOnTheScreen();
      // The theme switch starts in the theme the app is in.
      expect(
        screen.getByRole('radio', {
          name: theme === 'legends' ? 'Legends theme' : 'Classic theme',
        }),
      ).toBeChecked();
      for (const group of ['Text', 'Button', 'IconButton', 'Sheet', 'MediaCard', 'StateView']) {
        expect(screen.getByRole('header', { name: group })).toBeOnTheScreen();
      }
      // Buttons in their states, an icon button with its count, MediaCard as one button.
      expect(screen.getByRole('button', { name: 'Button primary' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Saving' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeOnTheScreen();
      expect(
        screen.getByRole('button', {
          name: 'Fall league, U10 Saturday league, Saturdays 9 am, Pitch 2, Ages 9 to 10',
        }),
      ).toBeOnTheScreen();
      expect(screen.getByRole('switch', { name: 'Game reminders' })).toBeOnTheScreen();
      expect(screen.getByLabelText('Show')).toHaveProp('accessibilityRole', 'tablist');
      expect(screen.getByRole('tab', { name: 'Upcoming' })).toBeSelected();
      expect(screen.getByRole('progressbar', { name: 'Loading registrations' })).toBeOnTheScreen();
      for (const state of STATES) expect(screen.getByTestId(`state-${state}`)).toBeOnTheScreen();
    },
  );

  it('switches between the classic and the Legends theme locally', async () => {
    const { app } = await renderGallery('classic');
    expect(screen.getByText('Tone default')).toHaveStyle({ color: classicTheme.colors.text });

    fireEvent.press(screen.getByRole('radio', { name: 'Legends theme' }));
    expect(screen.getByRole('radio', { name: 'Legends theme' })).toBeChecked();
    expect(screen.getByText('Tone default')).toHaveStyle({ color: legendsTheme.colors.text });
    // The app's own stored choice is left as it was.
    expect(app.themeStore.read()).toBe('classic');
  });

  it('shows a toast and opens a sheet from their specimens', async () => {
    await renderGallery('classic');
    fireEvent.press(screen.getByRole('button', { name: 'Show a success toast' }));
    expect(await screen.findByText('Preferences saved')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Open a sheet' }));
    expect(await screen.findByRole('header', { name: 'Filters' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Done' })).toBeOnTheScreen();
  });

  it('is left out when __DEV__ is false (release builds)', () => {
    const globals = globalThis as unknown as { __DEV__: boolean };
    const dev = globals.__DEV__;
    globals.__DEV__ = false;
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- loads the module afresh with __DEV__ off
        const gallery = require('../index') as typeof GalleryEntry;
        expect(gallery.DesignSystemGallery).toBeNull();
      });
    } finally {
      globals.__DEV__ = dev;
    }
  });
});
