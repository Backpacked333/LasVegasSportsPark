/**
 * Section (ADR-008, SPK-UX-009): a titled group whose title is a header, with a "See all" action
 * named after its section, in card, plain and carousel looks.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { ListRow } from '../ListRow';
import { MotionProvider } from '../motion';
import { Section } from '../Section';
import { classicTheme, legendsTheme } from '../theme';

describe('Section (ADR-008)', () => {
  it('SPK-UX-009: the title is a header and the action a button named after the section', async () => {
    const onPress = jest.fn();
    await renderSurface(
      <>
        <Section title="Upcoming" action={{ label: 'See all', onPress }}>
          <ListRow title="Game at 9 am" />
        </Section>
        <Section title="Teams" action={{ label: 'See all', onPress: () => undefined }}>
          <ListRow title="U10 Red" />
        </Section>
      </>,
    );
    expect(screen.getByRole('header', { name: 'Upcoming' })).toBeOnTheScreen();
    const action = screen.getByRole('button', { name: 'See all, Upcoming' });
    expect(screen.getByRole('button', { name: 'See all, Teams' })).toBeOnTheScreen();
    fireEvent.press(action);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('SPK-UX-009: the action is at least 44 pt tall, and can be named explicitly', async () => {
    await renderSurface(
      <Section
        title="Payments"
        action={{ label: 'See all', accessibilityLabel: 'All payments', onPress: () => undefined }}
      >
        <Text>Row</Text>
      </Section>,
    );
    const action = screen.getByRole('button', { name: 'All payments' });
    const style = StyleSheet.flatten((action.props.style as unknown) ?? {}) as {
      minHeight?: number;
    };
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it('draws rows flat inside its card, and leaves plain and carousel content on the page', async () => {
    await renderSurface(
      <>
        <Section title="In a card">
          <ListRow title="Flat row" />
        </Section>
        <Section title="Plain" variant="plain">
          <ListRow title="Card row" />
        </Section>
        <Section title="Row of cards" variant="carousel">
          <Text>Carousel here</Text>
        </Section>
      </>,
    );
    expect(screen.getByLabelText('Flat row')).toHaveStyle({ borderTopWidth: 1 });
    expect(screen.getByLabelText('Card row')).toHaveStyle({ borderRadius: 20 });
    expect(screen.getByText('Carousel here')).toBeOnTheScreen();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('uses the text and accent colours of the %s theme', async (name, theme) => {
    await renderSurface(
      <Section title="Upcoming" action={{ label: 'See all', onPress: () => undefined }}>
        <Text>Row</Text>
      </Section>,
      { theme: name },
    );
    expect(screen.getByRole('header', { name: 'Upcoming' })).toHaveStyle({
      color: theme.colors.text,
    });
    expect(screen.getByText('See all')).toHaveStyle({ color: theme.colors.primary });
  });

  it('SPK-UX-009 reduced motion: is static with or without motion', async () => {
    const view = (
      <Section title="Upcoming">
        <Text>Row</Text>
      </Section>
    );
    const { rerender } = await renderSurface(view);
    rerender(<MotionProvider reduced={false}>{view}</MotionProvider>);
    expect(screen.getByRole('header', { name: 'Upcoming' })).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
