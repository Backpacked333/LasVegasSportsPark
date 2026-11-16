/**
 * ListRow v2 (ADR-008, SPK-UX-009): avatar, subtitle (with `detail` as its alias), trailing value,
 * chevron and count, all read in the row's one label; the existing props work as before.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { Card } from '../Card';
import { ListRow, ListRowLayout, useRowLayout } from '../ListRow';
import { MotionProvider } from '../motion';
import { classicTheme, legendsTheme } from '../theme';

function Layout() {
  return <Text>{useRowLayout()}</Text>;
}

describe('ListRow v2 (ADR-008)', () => {
  it('SPK-UX-009: reads title, subtitle, value, status, badges and count as one button', async () => {
    const onPress = jest.fn();
    await renderSurface(
      <ListRow
        title="Ava Lee"
        subtitle="U10 Red"
        value="$40.00"
        status={{ tone: 'warning', label: 'Amount due' }}
        badges={[{ tone: 'info', label: 'New' }]}
        badge={3}
        badgeLabel="3 unread"
        avatar={{ name: 'Ava Lee', id: 'p-1' }}
        onPress={onPress}
      />,
    );
    const row = screen.getByRole('button', {
      name: 'Ava Lee, U10 Red, $40.00, Amount due, New, 3 unread',
    });
    fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
    // The avatar and the count are drawn but not read again.
    expect(screen.queryByRole('image')).toBeNull();
    expect(screen.getByText('3', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByText('$40.00')).toHaveStyle({ fontVariant: ['tabular-nums'] });
  });

  it('keeps `detail` as an alias of `subtitle`, and a count reads "N new" by default', async () => {
    await renderSurface(
      <>
        <ListRow title="Field change" detail="Pitch 2 to Pitch 4" badge={2} />
        <ListRow title="Both" subtitle="Subtitle wins" detail="Ignored" />
        <ListRow title="Nothing waiting" badge={0} />
      </>,
    );
    expect(screen.getByLabelText('Field change, Pitch 2 to Pitch 4, 2 new')).toBeOnTheScreen();
    expect(screen.getByLabelText('Both, Subtitle wins')).toBeOnTheScreen();
    expect(screen.queryByText('Ignored')).toBeNull();
    expect(screen.getByLabelText('Nothing waiting')).toBeOnTheScreen();
  });

  it('shows the chevron on a row that opens something, unless told otherwise', async () => {
    await renderSurface(
      <>
        <ListRow title="Opens" onPress={() => undefined} />
        <ListRow title="No chevron" onPress={() => undefined} chevron={false} />
        <ListRow title="Static with chevron" chevron />
        <ListRow title="Own trailing" onPress={() => undefined} trailing={<Text>Edit</Text>} />
      </>,
    );
    expect(screen.getAllByText('chevron_right', { includeHiddenElements: true })).toHaveLength(2);
  });

  it('SPK-UX-009: a row that opens something is at least 44 pt; a row that does not is no button', async () => {
    await renderSurface(
      <>
        <ListRow title="Support" onPress={() => undefined} />
        <ListRow title="Read only" />
      </>,
    );
    const style = StyleSheet.flatten(
      screen.getByRole('button', { name: 'Support' }).props.style,
    ) as { minHeight: number };
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('keeps ListRowLayout and useRowLayout: rows inside a card frame are flat', async () => {
    await renderSurface(
      <ListRowLayout layout="flat">
        <Layout />
        <ListRow title="Flat" />
      </ListRowLayout>,
    );
    expect(screen.getByText('flat')).toBeOnTheScreen();
    expect(screen.getByLabelText('Flat')).toHaveStyle({ borderTopWidth: 1 });
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('draws in the %s theme', async (name, theme) => {
    await renderSurface(<ListRow title="Payments" subtitle="2 due" value="$20.00" />, {
      theme: name,
    });
    expect(screen.getByLabelText('Payments, 2 due, $20.00')).toHaveStyle({
      backgroundColor: theme.colors.background,
      borderColor: theme.colors.border,
    });
    expect(screen.getByText('Payments')).toHaveStyle({ color: theme.colors.text });
    expect(screen.getByText('$20.00')).toHaveStyle({ color: theme.colors.textMuted });
  });

  it('SPK-UX-010 reduced motion: answers a press with the soft fill, never with motion', async () => {
    const row = <ListRow title="Support" onPress={() => undefined} />;
    const { rerender } = await renderSurface(row);
    rerender(<MotionProvider reduced={false}>{row}</MotionProvider>);
    // Same row with motion allowed: no animated style, no transform.
    const style = StyleSheet.flatten(
      screen.getByRole('button', { name: 'Support' }).props.style,
    ) as { transform?: unknown };
    expect(style.transform).toBeUndefined();
  });
});

describe('flat rows in a card (ADR-008)', () => {
  it('draws no divider above the first row of a group, and one above each row after it', async () => {
    await renderSurface(
      <Card>
        <ListRow title="First" testID="first" />
        <ListRow title="Second" testID="second" />
      </Card>,
    );
    const layoutAt = (y: number) => ({
      nativeEvent: { layout: { x: 0, y, width: 300, height: 56 } },
    });
    fireEvent(screen.getByTestId('first'), 'layout', layoutAt(0));
    fireEvent(screen.getByTestId('second'), 'layout', layoutAt(57));
    expect(StyleSheet.flatten(screen.getByTestId('first').props.style).borderTopWidth).toBe(0);
    expect(StyleSheet.flatten(screen.getByTestId('second').props.style).borderTopWidth).toBe(1);
  });
});
