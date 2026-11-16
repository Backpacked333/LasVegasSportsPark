/**
 * OfflineNotice (ADR-008, moved from the teams kit): a command that needs a connection while the
 * device is offline says so in words and a glyph, and that nothing is queued (SPK-UX-008, §4.15,
 * SPK-UX-009). The teams kit re-exports the same component.
 */
import { screen } from '@testing-library/react-native';
import * as teamsKit from '../../features/teams/ui';
import { renderUi } from '../../testing/ui-actions';
import { OfflineNotice } from '../OfflineNotice';

describe('OfflineNotice (ADR-008)', () => {
  it('SPK-UX-008: reads as one element "{what} needs a connection" and keeps the entries', async () => {
    await renderUi(<OfflineNotice what="Sending the invitation" testID="notice" />);
    const notice = screen.getByLabelText('Sending the invitation needs a connection');
    expect(notice).toBe(screen.getByTestId('notice'));
    expect(screen.getByText('Needs a connection')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Sending the invitation needs a connection. Nothing is queued: your entries are kept on this screen.',
      ),
    ).toBeOnTheScreen();
  });

  it('the teams kit re-exports it', () => {
    expect(teamsKit.OfflineNotice).toBe(OfflineNotice);
  });
});
