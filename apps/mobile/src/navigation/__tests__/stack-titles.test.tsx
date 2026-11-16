/**
 * PA-11, SPK-UX-011 (**Proposed**): the stack titles customers read above a screen use the
 * customer words of `src/copy/vocabulary.ts` (game, class packs, in-person receipts), and the
 * preferences route keeps the words of its row on You.
 */
import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { createTestApp } from '../../testing/test-app';
import { RootNavigator } from '../RootNavigator';

const mockScreens: { name: string; options?: { title?: string } }[] = [];
jest.mock('expo-router', () => {
  const actual = jest.requireActual('expo-router');
  const Stack = ({ children }: { children: ReactNode }) => children;
  Stack.Screen = (props: { name: string; options?: { title?: string } }) => {
    mockScreens.push(props);
    return null;
  };
  return { ...actual, Stack };
});

function titleOf(name: string): string | undefined {
  return mockScreens.find((screen) => screen.name === name)?.options?.title;
}

describe('RootNavigator stack titles (PA-11)', () => {
  it('PA-11 SPK-UX-011: game, class packs, in-person receipts and notifications use customer words', () => {
    const app = createTestApp();
    render(<RootNavigator />, { wrapper: app.wrapper });
    expect(titleOf('fixtures/[id]')).toBe('Game');
    expect(titleOf('session-packages/index')).toBe('Class packs');
    expect(titleOf('pos-receipts/index')).toBe('In-person receipts');
    expect(titleOf('preferences')).toBe('Notifications and calendar');
  });
});
