/**
 * Handoff M 4c Notification settings (SPK-COMMS-001, SPK-COMMS-007): changes locked on, "New
 * programs" saving at once with Undo, and what the API cannot express shown as proposed.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { CHILD, me, names, ok } from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { NotificationSettingsScreen } from '../NotificationSettingsScreen';

const pref = (channel: string, category: string, enabled: boolean, locked = false) => ({
  channel,
  category,
  enabled,
  stored: true,
  locked,
  updatedAt: null,
});

const PREFS = {
  personId: '0192f1a0-0000-7000-8000-00000000a001',
  preferences: [
    pref('in_app', 'operational', true, true),
    pref('push', 'operational', true),
    pref('push', 'promotional', true),
    pref('email', 'promotional', true),
  ],
};

function renderSettings(patch = ok(PREFS)) {
  const app = createTestApp({
    toasts: true,
    routes: {
      'GET /me': ok(me([{ subjectPersonId: CHILD, permissions: ['view'] }])),
      'GET /person-names': names({ [CHILD]: 'Maya' }),
      'GET /me/communication-preferences': ok(PREFS),
      'PATCH /me/communication-preferences': patch,
    },
  });
  render(<NotificationSettingsScreen />, { wrapper: app.wrapper });
  return app;
}

describe('handoff M 4c Notification settings', () => {
  it('changes and cancellations are locked on, said in words', async () => {
    renderSettings();
    expect(
      await screen.findByLabelText('Always on: changes and cancellations cannot be turned off'),
    ).toBeOnTheScreen();
  });

  it('"New programs" saves at once for every promotional channel, with Undo that sends the previous choice', async () => {
    const app = renderSettings();
    const toggle = await screen.findByRole('switch', { name: 'New programs for your kids' });
    expect(toggle).toBeChecked();
    fireEvent.press(toggle);
    expect(screen.getByRole('switch', { name: 'New programs for your kids' })).not.toBeChecked();
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1),
    );
    expect(app.fake.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      preferences: [
        { channel: 'push', category: 'promotional', enabled: false },
        { channel: 'email', category: 'promotional', enabled: false },
      ],
    });
    const toast = await screen.findByTestId('toast');
    fireEvent.press(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(2),
    );
    expect(app.fake.requests.filter((r) => r.method === 'PATCH')[1]?.body).toEqual({
      preferences: [
        { channel: 'push', category: 'promotional', enabled: true },
        { channel: 'email', category: 'promotional', enabled: true },
      ],
    });
  });

  it('a change that does not save is put back, with Try again', async () => {
    renderSettings({ status: 500, body: { error: { code: 'INTERNAL_ERROR' } } });
    fireEvent.press(await screen.findByRole('switch', { name: 'New programs for your kids' }));
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveTextContent(/That setting didn't save\.Try again$/),
    );
    expect(screen.getByRole('switch', { name: 'New programs for your kids' })).toBeChecked();
  });

  it('what the API cannot express yet is proposed: reminders, per child, quiet hours', async () => {
    renderSettings();
    expect(
      await screen.findByLabelText('Game reminders, proposed: not available yet'),
    ).toBeDisabled();
    expect(
      await screen.findByLabelText('Updates for Maya, proposed: not available yet'),
    ).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Quiet hours, 9 PM to 7 AM, proposed' }));
    expect(await screen.findByTestId('notify-quiet-proposed')).toBeOnTheScreen();
  });
});
