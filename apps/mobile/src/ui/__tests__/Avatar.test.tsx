/**
 * Avatar and AvatarStack (ADR-008, SPK-UX-009): initials on the person's own tone, named by the
 * person or hidden when the name is beside it; a stack reads every name.
 */
import { screen } from '@testing-library/react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { Avatar, AvatarStack, avatarStackLabel, initialsFor } from '../Avatar';
import { MotionProvider } from '../motion';
import { avatarToneFor, classicTheme, legendsTheme } from '../theme';

const FAMILY = [
  { name: 'Ava Lee', id: 'p-1' },
  { name: 'Ben Ortiz', id: 'p-2' },
  { name: 'Cara Diaz', id: 'p-3' },
  { name: 'Dan Moe', id: 'p-4' },
  { name: 'Eli Park', id: 'p-5' },
];

describe('Avatar (ADR-008)', () => {
  it('draws up to two initials', () => {
    expect(initialsFor('Ava Lee')).toBe('AL');
    expect(initialsFor('  maria  de la cruz ')).toBe('MC');
    expect(initialsFor('Ben')).toBe('B');
    expect(initialsFor('')).toBe('?');
  });

  it('SPK-UX-009: initials ignore brackets and punctuation; a bracketed name is the person', () => {
    expect(initialsFor('You (Dev)')).toBe('D');
    expect(initialsFor('You (Robin Lee)')).toBe('RL');
    expect(initialsFor("Mary-Jane O'Neil")).toBe('MO');
    expect(initialsFor('(Ava) ')).toBe('A');
    expect(initialsFor('Ben ()')).toBe('B');
    expect(initialsFor('"Coach" Sam!')).toBe('CS');
    expect(initialsFor('-- ?')).toBe('?');
  });

  it("SPK-UX-009: is an image named by the person's name, and not a control", async () => {
    await renderSurface(<Avatar name="Ava Lee" id="p-1" />);
    expect(screen.getByRole('image', { name: 'Ava Lee' })).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('SPK-UX-009: is hidden when decorative, so the name beside it is read once', async () => {
    await renderSurface(<Avatar name="Ava Lee" decorative testID="avatar" />);
    expect(screen.queryByRole('image')).toBeNull();
    expect(screen.queryByTestId('avatar')).toBeNull();
    expect(screen.getByText('AL', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)("keeps the person's tone of the %s theme everywhere", async (name, theme) => {
    await renderSurface(
      <>
        <Avatar name="Ava Lee" id="p-1" testID="one" />
        <Avatar name="Ava L." id="p-1" testID="two" />
      </>,
      { theme: name },
    );
    const tone = avatarToneFor(theme, 'p-1');
    expect(screen.getByTestId('one')).toHaveStyle({ backgroundColor: tone.background });
    expect(screen.getByTestId('two')).toHaveStyle({ backgroundColor: tone.background });
    for (const initials of screen.getAllByText('AL')) {
      expect(initials).toHaveStyle({ color: tone.foreground });
    }
  });

  it('SPK-UX-009 reduced motion: is static with or without motion', async () => {
    const { rerender } = await renderSurface(<Avatar name="Ava Lee" />);
    const still = screen.getByRole('image', { name: 'Ava Lee' }).props.style;
    rerender(
      <MotionProvider reduced={false}>
        <Avatar name="Ava Lee" />
      </MotionProvider>,
    );
    expect(screen.getByRole('image', { name: 'Ava Lee' }).props.style).toEqual(still);
  });
});

describe('AvatarStack (ADR-008)', () => {
  it('SPK-UX-009: draws a few avatars and "+N", and reads every name as one element', async () => {
    await renderSurface(<AvatarStack people={FAMILY} max={3} />);
    const stack = screen.getByRole('image', {
      name: 'Ava Lee, Ben Ortiz, Cara Diaz, Dan Moe and Eli Park',
    });
    expect(stack).toBeOnTheScreen();
    expect(screen.getByText('+2')).toBeOnTheScreen();
    // The avatars inside are decorative: only the stack is read.
    expect(screen.getAllByRole('image')).toHaveLength(1);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has no "+N" when every avatar fits, and joins names in plain words', async () => {
    expect(avatarStackLabel([{ name: 'Ava Lee' }])).toBe('Ava Lee');
    expect(avatarStackLabel([{ name: 'Ava Lee' }, { name: 'Ben Ortiz' }])).toBe(
      'Ava Lee and Ben Ortiz',
    );
    await renderSurface(<AvatarStack people={FAMILY.slice(0, 2)} />, { theme: 'legends' });
    expect(screen.getByRole('image', { name: 'Ava Lee and Ben Ortiz' })).toBeOnTheScreen();
    expect(screen.queryByText(/^\+/)).toBeNull();
  });
});
