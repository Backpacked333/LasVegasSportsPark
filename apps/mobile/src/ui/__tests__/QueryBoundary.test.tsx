/**
 * QueryBoundary's empty answer (SPK-UX-008 empty, ADR-008): `StateView`'s words, or with
 * `empty.source` the illustrated `EmptyState`, announced with the same words (SPK-UX-009).
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import { Image } from 'expo-image';
import type { ReactElement } from 'react';
import { AccessibilityInfo, Platform, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { QueryBoundary, type QueryLike } from '../QueryBoundary';

const ART = { uri: 'asset:/artwork/empty-payments.webp' };

function answered<T>(data: T): QueryLike<T> {
  return { data, error: null, fetchStatus: 'idle', updatedAt: null, refetch: () => undefined };
}

async function renderOnIos(ui: ReactElement): Promise<string[]> {
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => undefined);
  const os = Platform.OS;
  Platform.OS = 'ios';
  try {
    await renderSurface(ui);
  } finally {
    Platform.OS = os;
  }
  await act(async () => {
    await Promise.resolve();
  });
  const words = announce.mock.calls.map(([message]) => message);
  announce.mockRestore();
  return words;
}

describe('QueryBoundary empty answer (SPK-UX-008)', () => {
  it('SPK-UX-008: with an illustration, the empty answer is an EmptyState announced with its words and action', async () => {
    const onAction = jest.fn();
    const announced = await renderOnIos(
      <QueryBoundary
        query={answered<string[]>([])}
        label="receipts"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No receipts yet',
          description: 'Each payment the facility receives from you appears here.',
          actionLabel: 'Open payments',
          onAction,
          source: ART,
          testID: 'receipts-empty',
        }}
      >
        {() => <Text>Receipts</Text>}
      </QueryBoundary>,
    );
    expect(screen.getByRole('header', { name: 'No receipts yet' })).toBeOnTheScreen();
    expect(screen.UNSAFE_getByType(Image).props.source).toBe(ART);
    expect(screen.getByTestId('receipts-empty')).toHaveProp('accessibilityLiveRegion', 'polite');
    expect(screen.queryByText('Receipts')).toBeNull();
    expect(announced).toEqual([
      'No receipts yet. Each payment the facility receives from you appears here. Open payments.',
    ]);
    fireEvent.press(screen.getByRole('button', { name: 'Open payments' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("without an illustration it stays StateView's empty state, with the same announcement", async () => {
    const announced = await renderOnIos(
      <QueryBoundary
        query={answered<string[]>([])}
        label="receipts"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No receipts yet', description: 'Receipts appear here.' }}
      >
        {() => <Text>Receipts</Text>}
      </QueryBoundary>,
    );
    expect(screen.getByTestId('state-empty')).toBeOnTheScreen();
    expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);
    expect(announced).toEqual(['No receipts yet. Receipts appear here.']);
  });
});
