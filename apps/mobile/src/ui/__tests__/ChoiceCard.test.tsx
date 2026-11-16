/**
 * ChoiceCard's optional words and test id (ADR-008, Phase 3): a feature kit's adapter can keep its
 * own accessible name and hint on the shared card, and the card is named by `choiceName` with the
 * group's error as its hint when it does not (SPK-UX-009).
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { renderUi } from '../../testing/ui-actions';
import { ChoiceCard } from '../ChoiceList';

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
});
