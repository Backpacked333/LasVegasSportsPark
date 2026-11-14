/**
 * GlassSurface (ADR-001, SPK-UX-009): which device gets which surface, and that a screen never
 * depends on glass being there.
 */
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { GlassProvider, GlassSurface, glassModeFor, useGlassMode } from '../GlassSurface';
import { Hero, HeroText } from '../Hero';
import { classicTheme } from '../theme';

function Mode() {
  return <Text>{useGlassMode()}</Text>;
}

describe('glassModeFor (ADR-001)', () => {
  it('offers liquid glass only where the system has it', () => {
    expect(glassModeFor({ os: 'ios', liquidGlass: true, reduceTransparency: false })).toBe(
      'liquid',
    );
    expect(glassModeFor({ os: 'ios', liquidGlass: false, reduceTransparency: false })).toBe('blur');
  });

  it('is solid on Android and on the web', () => {
    expect(glassModeFor({ os: 'android', liquidGlass: false, reduceTransparency: false })).toBe(
      'solid',
    );
    expect(glassModeFor({ os: 'web', liquidGlass: true, reduceTransparency: false })).toBe('solid');
  });

  it('SPK-UX-009: reduce transparency always wins', () => {
    expect(glassModeFor({ os: 'ios', liquidGlass: true, reduceTransparency: true })).toBe('solid');
    expect(glassModeFor({ os: 'ios', liquidGlass: false, reduceTransparency: true })).toBe('solid');
  });
});

describe('GlassSurface', () => {
  it('is solid without a provider: screens never depend on glass', () => {
    render(
      <GlassSurface testID="surface">
        <Mode />
      </GlassSurface>,
    );
    expect(screen.getByText('solid')).toBeOnTheScreen();
    expect(screen.getByTestId('surface')).toHaveStyle({ backgroundColor: '#FFFFFF' });
  });

  it('paints the tint when solid, so labels chosen for the tint stay readable', () => {
    render(<GlassSurface testID="surface" tint="#0C2219" />);
    expect(screen.getByTestId('surface')).toHaveStyle({ backgroundColor: '#0C2219' });
  });

  it.each(['liquid', 'blur'] as const)('renders its children in %s mode', (mode) => {
    render(
      <GlassProvider mode={mode}>
        <GlassSurface testID="surface">
          <Text>Tabs</Text>
        </GlassSurface>
      </GlassProvider>,
    );
    expect(screen.getByText('Tabs')).toBeOnTheScreen();
    expect(screen.getByTestId('surface')).toBeOnTheScreen();
  });

  it('a tinted surface in blur mode stays solid: there is nothing behind it to blur', () => {
    render(
      <GlassProvider mode="blur">
        <GlassSurface testID="surface" tint="#0C2219" />
      </GlassProvider>,
    );
    expect(screen.getByTestId('surface')).toHaveStyle({ backgroundColor: '#0C2219' });
  });

  it('asks the device when no mode is fixed, and settles without glass in this runtime', async () => {
    render(
      <GlassProvider>
        <Mode />
      </GlassProvider>,
    );
    // No liquid glass here; the answer is one of the two modes that need no system glass.
    expect(await screen.findByText(/^(solid|blur)$/)).toBeOnTheScreen();
  });
});

describe('Hero band on glass (ADR-001, SPK-UX-009)', () => {
  it('is the solid night band without glass, and the pitch band for a team', () => {
    render(
      <>
        <Hero title="Saturday skills" eyebrow="Class" testID="night" />
        <Hero title="Lions" tone="pitch" testID="pitch" />
      </>,
    );
    expect(screen.getByTestId('night')).toHaveStyle({
      backgroundColor: classicTheme.colors.night,
    });
    expect(screen.getByTestId('pitch')).toHaveStyle({
      backgroundColor: classicTheme.colors.pitch,
    });
  });

  it('keeps its eyebrow, title and text as the same labels on coloured glass', () => {
    render(
      <GlassProvider mode="liquid">
        <Hero title="Saturday skills" eyebrow="Class" testID="band">
          <HeroText>Starts at 9:00</HeroText>
        </Hero>
      </GlassProvider>,
    );
    expect(screen.getAllByRole('header').map((node) => node.props.children as string)).toEqual([
      'Class',
      'Saturday skills',
    ]);
    expect(screen.getByText('Starts at 9:00')).toBeOnTheScreen();
    expect(screen.getByTestId('band')).toHaveProp('tintColor', classicTheme.colors.night);
  });
});
