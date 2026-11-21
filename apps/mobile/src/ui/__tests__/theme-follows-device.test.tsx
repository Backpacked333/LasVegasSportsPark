/**
 * Handoff M 5d: "The theme follows the switch in You, or can follow the phone's dark mode."
 * Without a stored choice the theme follows the device appearance; the switch's choice wins once
 * made, and is kept.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { LegendsModeToggle } from '../LegendsModeToggle';
import { ThemeProvider } from '../ThemeProvider';
import { MemoryThemeStore } from '../theme-preference';
import { useTheme } from '../theme';

let mockDeviceScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockDeviceScheme,
}));

function Probe() {
  return <Text testID="probe">{useTheme().name}</Text>;
}

describe('Legends mode follows the phone until the switch is used (handoff M 5d)', () => {
  it('a phone in dark mode opens in Legends mode when nothing was chosen', () => {
    mockDeviceScheme = 'dark';
    render(
      <ThemeProvider store={new MemoryThemeStore()}>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('legends');
  });

  it('a phone in light mode opens in the classic theme when nothing was chosen', () => {
    mockDeviceScheme = 'light';
    render(
      <ThemeProvider store={new MemoryThemeStore()}>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('classic');
  });

  it('the switch in You wins over the phone and is kept', () => {
    mockDeviceScheme = 'dark';
    const store = new MemoryThemeStore();
    render(
      <ThemeProvider store={store}>
        <LegendsModeToggle />
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('switch', { name: 'Legends mode' })).toBeChecked();
    fireEvent.press(screen.getByRole('switch', { name: 'Legends mode' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('classic');
    expect(store.read()).toBe('classic');
  });

  it('a stored choice is used whatever the phone says', () => {
    mockDeviceScheme = 'dark';
    render(
      <ThemeProvider store={new MemoryThemeStore('classic')}>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('classic');
  });
});
