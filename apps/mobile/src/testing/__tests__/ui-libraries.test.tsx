/**
 * The UI libraries added for the customer visual system v2 (ADR-008) load and render under Jest
 * with the setup in src/testing/jest.setup.ts, so components built on them can be tested like any
 * other. This proves the setup, not native behaviour (§6.2: a test render is not native acceptance).
 */
import { BottomSheetModal, BottomSheetModalProvider, BottomSheetView } from '@gorhom/bottom-sheet';
import DateTimePicker from '@react-native-community/datetimepicker';
import { render, screen } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

function Fading() {
  const opacity = useSharedValue(0.5);
  const style = useAnimatedStyle(() => ({ opacity: withTiming(opacity.value, { duration: 0 }) }));
  return (
    <Animated.View testID="fading" style={style}>
      <Text>Animated content</Text>
    </Animated.View>
  );
}

describe('UI libraries under Jest (ADR-008)', () => {
  it('renders reanimated views with their animated style', () => {
    render(<Fading />);
    expect(screen.getByText('Animated content')).toBeOnTheScreen();
    expect(screen.getByTestId('fading')).toHaveStyle({ opacity: 0.5 });
  });

  it('renders gesture-handler roots and detectors', () => {
    render(
      <GestureHandlerRootView style={{ flex: 1 }}>
        <GestureDetector gesture={Gesture.Tap()}>
          <View accessible accessibilityRole="button" accessibilityLabel="Tap target" />
        </GestureDetector>
      </GestureHandlerRootView>,
    );
    expect(screen.getByRole('button', { name: 'Tap target' })).toBeOnTheScreen();
  });

  it('renders bottom-sheet content in place', () => {
    render(
      <BottomSheetModalProvider>
        <BottomSheetModal>
          <BottomSheetView>
            <Text>Sheet content</Text>
          </BottomSheetView>
        </BottomSheetModal>
      </BottomSheetModalProvider>,
    );
    expect(screen.getByText('Sheet content')).toBeOnTheScreen();
  });

  it('renders images, gradients, vector shapes and the date picker', () => {
    render(
      <View>
        <Image testID="image" source={{ uri: 'https://example.test/a.webp' }} />
        <LinearGradient testID="gradient" colors={['#000000', '#FFFFFF']} />
        <Svg testID="svg" width={10} height={10}>
          <Path d="M0 0L10 10" />
        </Svg>
        <DateTimePicker testID="picker" value={new Date('2026-10-24T12:00:00.000Z')} />
      </View>,
    );
    for (const id of ['image', 'gradient', 'svg', 'picker']) {
      expect(screen.getByTestId(id)).toBeOnTheScreen();
    }
  });
});
