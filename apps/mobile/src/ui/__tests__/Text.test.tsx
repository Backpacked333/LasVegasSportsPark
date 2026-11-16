/**
 * Text (ADR-008 visual system v2; SPK-UX-009 headers, text scaling; SPK-UX-010 one type scale):
 * variants draw the theme's type styles, tones the theme's colour tokens, and only `heading` makes
 * a header.
 */
import { render, screen } from '@testing-library/react-native';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { Text, TEXT_TONES, TEXT_VARIANTS, type TextTone, type TextVariant } from '../Text';
import { THEMES, type } from '../theme';

const VARIANTS = Object.keys(TEXT_VARIANTS) as TextVariant[];
const TONES = Object.keys(TEXT_TONES) as TextTone[];

describe('Text (ADR-008)', () => {
  it('is body text in the text colour by default, and not a header', () => {
    render(<Text>Pitch 2 is open</Text>);
    const text = screen.getByText('Pitch 2 is open');
    const style = drawnStyle(text);
    expect(style.fontSize).toBe(type.body.fontSize);
    expect(style.color).toBe(THEMES.classic.colors.text);
    expect(screen.queryByRole('header')).toBeNull();
  });

  it('SPK-UX-009: `heading` exposes the line as a header named by its words', () => {
    render(
      <Text variant="largeTitle" heading>
        Your week
      </Text>,
    );
    expect(screen.getByRole('header', { name: 'Your week' })).toBeOnTheScreen();
  });

  it('the variant alone never makes a header', () => {
    render(<Text variant="title1">Summer camp</Text>);
    expect(screen.queryByRole('header')).toBeNull();
  });

  it.each(VARIANTS)('the %s variant draws its type style', (variant) => {
    render(<Text variant={variant}>Words</Text>);
    const style = drawnStyle(screen.getByText('Words'));
    expect(style.fontSize).toBe(TEXT_VARIANTS[variant].fontSize);
    expect(style.lineHeight).toBe(TEXT_VARIANTS[variant].lineHeight);
    expect(style.fontFamily).toBe(TEXT_VARIANTS[variant].fontFamily);
  });

  it('maps the variants onto the scale of theme.ts', () => {
    expect(TEXT_VARIANTS.title2).toBe(type.title);
    expect(TEXT_VARIANTS.headline).toBe(type.heading);
    expect(TEXT_VARIANTS.label).toBe(type.eyebrow);
    expect(TEXT_VARIANTS.largeTitle).toBe(type.largeTitle);
  });

  it.each(THEME_NAMES)('draws every tone in the %s theme from its tokens', async (name) => {
    const { colors } = THEMES[name];
    await renderUi(
      <>
        {TONES.map((tone) => (
          <Text key={tone} tone={tone}>
            {tone}
          </Text>
        ))}
      </>,
      { theme: name },
    );
    for (const tone of TONES) {
      expect(drawnStyle(screen.getByText(tone)).color).toBe(colors[TEXT_TONES[tone]]);
    }
  });

  it('tabular sets fixed-width figures; numberOfLines passes through', () => {
    render(
      <Text tabular numberOfLines={1}>
        18:30
      </Text>,
    );
    const text = screen.getByText('18:30');
    expect(drawnStyle(text).fontVariant).toEqual(['tabular-nums']);
    expect(text).toHaveProp('numberOfLines', 1);
  });

  it('SPK-UX-009: scales with the OS text size and is not a touch target', () => {
    render(<Text>Scaled</Text>);
    const text = screen.getByText('Scaled');
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has nothing to animate: it renders the same with motion on', async () => {
    await renderUi(<Text variant="callout">Still</Text>, { motion: 'full' });
    expect(drawnStyle(screen.getByText('Still')).transform).toBeUndefined();
  });
});
