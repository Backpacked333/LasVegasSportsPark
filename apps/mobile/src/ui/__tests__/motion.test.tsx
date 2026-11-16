/**
 * Motion (ADR-008, SPK-UX-009): nothing moves without a provider or while the device asks for
 * reduced motion, and the provider follows the device setting as it changes.
 */
import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Text } from 'react-native';
import {
  MOTION_DURATIONS,
  MotionProvider,
  motionFor,
  useMotion,
  type MotionToken,
} from '../motion';

const TOKENS = Object.keys(MOTION_DURATIONS) as MotionToken[];

function Probe() {
  const motion = useMotion();
  return (
    <Text>
      {motion.reduced ? 'reduced' : 'full'} {TOKENS.map((t) => motion.duration(t)).join(',')}
    </Text>
  );
}

type Listener = (value: boolean) => void;

/** Stands in for the device: answers the first read with `initial`, then lets the test change it. */
function fakeReduceMotion(initial: Promise<boolean>) {
  const listeners: Listener[] = [];
  const remove = jest.fn();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(initial);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockImplementation((event: string, listener: unknown) => {
      if (event === 'reduceMotionChanged') listeners.push(listener as Listener);
      return { remove } as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>;
    });
  return {
    remove,
    change(value: boolean) {
      for (const listener of listeners) listener(value);
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('motionFor (ADR-008)', () => {
  it('SPK-UX-009: every duration is 0 while motion is reduced', () => {
    const motion = motionFor(true);
    expect(motion.reduced).toBe(true);
    expect(TOKENS.map((t) => motion.duration(t))).toEqual([0, 0, 0, 0]);
  });

  it('gives the token durations otherwise', () => {
    const motion = motionFor(false);
    expect(motion.reduced).toBe(false);
    expect(TOKENS.map((t) => motion.duration(t))).toEqual([0, 120, 220, 320]);
  });
});

describe('useMotion and MotionProvider (ADR-008)', () => {
  it('is reduced without a provider: screen tests never depend on an animation', () => {
    render(<Probe />);
    expect(screen.getByText('reduced 0,0,0,0')).toBeOnTheScreen();
  });

  it('a fixed answer wins and the device is not asked', () => {
    const spy = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled');
    render(
      <MotionProvider reduced={false}>
        <Probe />
      </MotionProvider>,
    );
    expect(screen.getByText('full 0,120,220,320')).toBeOnTheScreen();
    expect(spy).not.toHaveBeenCalled();
  });

  it('SPK-UX-009: stays reduced until the device answers, then follows its setting', async () => {
    const device = fakeReduceMotion(Promise.resolve(false));
    const view = render(
      <MotionProvider>
        <Probe />
      </MotionProvider>,
    );
    expect(screen.getByText('reduced 0,0,0,0')).toBeOnTheScreen();
    expect(await screen.findByText('full 0,120,220,320')).toBeOnTheScreen();

    act(() => device.change(true));
    expect(screen.getByText('reduced 0,0,0,0')).toBeOnTheScreen();
    act(() => device.change(false));
    expect(screen.getByText('full 0,120,220,320')).toBeOnTheScreen();

    view.unmount();
    expect(device.remove).toHaveBeenCalledTimes(1);
  });

  it('stays reduced when the device cannot answer', async () => {
    fakeReduceMotion(Promise.reject(new Error('not available')));
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('reduced 0,0,0,0')).toBeOnTheScreen();
  });
});
