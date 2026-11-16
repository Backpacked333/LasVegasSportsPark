/**
 * ChoiceCard's optional words and test id (ADR-008, Phase 3): a feature kit's adapter can keep its
 * own accessible name and hint on the shared card, and the card is named by `choiceName` with the
 * group's error as its hint when it does not (SPK-UX-009).
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { drawnStyle, renderUi } from '../../testing/ui-actions';
import { ChoiceCard, ChoiceGroup } from '../ChoiceList';
import { classicTheme } from '../theme';

const OPTION = { value: 'sat', label: 'Saturday', description: 'Morning session' };

describe('ChoiceCard (ADR-008)', () => {
  it('SPK-UX-009: by default it is named by choiceName and reads the group error as its hint', async () => {
    await renderUi(
      <ChoiceCard
        option={OPTION}
        mode="single"
        checked={false}
        error="Choose a day."
        onPress={() => undefined}
      />,
    );
    const card = screen.getByRole('radio', { name: 'Saturday, Morning session' });
    expect(card).toHaveProp('accessibilityHint', 'Error: Choose a day.');
    expect(card).not.toBeChecked();
  });

  it('a kit can give its own name, hint and test id', async () => {
    const onPress = jest.fn();
    await renderUi(
      <ChoiceCard
        option={OPTION}
        mode="multiple"
        checked
        disabled={false}
        error="Choose one."
        onPress={onPress}
        accessibilityLabel="Saturday. Morning session"
        accessibilityHint="Morning session. Error: Choose one."
        testID="card"
      />,
    );
    const card = screen.getByRole('checkbox', { name: 'Saturday. Morning session' });
    expect(card).toBe(screen.getByTestId('card'));
    expect(card).toHaveProp('accessibilityHint', 'Morning session. Error: Choose one.');
    expect(card).toBeChecked();
    expect(screen.getByText('Morning session')).toBeOnTheScreen();
    fireEvent.press(card);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('SPK-UX-009: a tile shows its short label, reads its full name, and marks the choice with "✓"', async () => {
    const onPress = jest.fn();
    const { rerender } = await renderUi(
      <ChoiceCard
        option={{ value: '09', label: '9:00 to 10:00', shortLabel: '9:00', description: '$80.00' }}
        mode="single"
        checked={false}
        layout="tile"
        onPress={onPress}
      />,
    );
    const tile = screen.getByRole('radio', { name: '9:00 to 10:00, $80.00' });
    expect(screen.getByText('9:00')).toBeOnTheScreen();
    fireEvent.press(tile);
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <ChoiceCard
        option={{ value: '09', label: '9:00 to 10:00', shortLabel: '9:00', description: '$80.00' }}
        mode="single"
        checked
        layout="tile"
        onPress={onPress}
      />,
    );
    expect(screen.getByRole('radio', { name: '9:00 to 10:00, $80.00' })).toBeChecked();
    expect(screen.getByText('✓ 9:00')).toBeOnTheScreen();
    expect(drawnStyle(screen.getByRole('radio')).backgroundColor).toBe(
      classicTheme.colors.floodlight,
    );
  });

  it('a leading node starts the card and the glyph moves to its end', async () => {
    await renderUi(
      <ChoiceCard
        option={OPTION}
        mode="multiple"
        checked={false}
        leading={<Text testID="avatar">SA</Text>}
        onPress={() => undefined}
      />,
    );
    const card = screen.getByRole('checkbox', { name: 'Saturday, Morning session' });
    // The leading node first, the glyph ("check_box_outline_blank", hidden) last.
    expect(card).toHaveTextContent('SASaturdayMorning sessioncheck_box_outline_blank');
  });

  it("SPK-UX-009: ChoiceGroup is named, and its error is the group's hint and every card's", async () => {
    await renderUi(
      <ChoiceGroup label="Start time" error="Choose a start time." layout="tile">
        <ChoiceCard
          option={{ value: '09', label: '9:00' }}
          mode="single"
          checked={false}
          layout="tile"
          onPress={() => undefined}
        />
        <ChoiceCard
          option={{ value: '10', label: '10:00' }}
          mode="single"
          checked={false}
          error={null}
          layout="tile"
          onPress={() => undefined}
        />
      </ChoiceGroup>,
    );
    const group = screen.getByLabelText('Start time');
    expect(group).toHaveProp('accessibilityRole', 'radiogroup');
    expect(group).toHaveProp('accessibilityHint', 'Error: Choose a start time.');
    expect(screen.getByRole('radio', { name: '9:00' })).toHaveProp(
      'accessibilityHint',
      'Error: Choose a start time.',
    );
    // A card's own error wins over the group's.
    expect(screen.getByRole('radio', { name: '10:00' })).not.toHaveProp('accessibilityHint');
    expect(screen.queryByText('Start time')).toBeNull();
  });

  it('ChoiceGroup can show its label and be a list of checkboxes', async () => {
    await renderUi(
      <ChoiceGroup label="Add" role="list" showLabel>
        <ChoiceCard
          option={{ value: 'a', label: 'Email' }}
          mode="multiple"
          checked={false}
          onPress={() => undefined}
        />
      </ChoiceGroup>,
    );
    const group = screen.getByLabelText('Add');
    expect(group).toHaveProp('accessibilityRole', 'list');
    expect(group).not.toHaveProp('accessibilityHint');
    expect(screen.getByText('Add')).toBeOnTheScreen();
    expect(screen.getByRole('checkbox', { name: 'Email' })).not.toHaveProp('accessibilityHint');
  });
});
