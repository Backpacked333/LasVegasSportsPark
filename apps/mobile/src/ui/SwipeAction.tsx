/**
 * SwipeAction (handoff M 2d, INTERACTIONS 2d row 3; ADR-008 visual system v2, **Proposed**): a row
 * that reveals one action when swiped left ("Mark read"), and runs it on a full swipe. The
 * revealed action is also a button, and the same action is offered to screen readers as a named
 * accessibility action on the row, so the gesture is never the only way (SPK-UX-009); screens add
 * a visible alternative too ("Mark all read").
 *
 * Screens never import gesture libraries directly: this wraps react-native-gesture-handler's
 * reanimated swipeable. Without an action (`action` null) the row is drawn as it is, with no
 * gesture.
 */
import { useRef, type ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Icon } from './Icon';
import { fonts, makeStyles, spacing, useTheme } from './theme';

export interface SwipeActionProps {
  children: ReactNode;
  /** The revealed action, or null for none. */
  action: { label: string; icon: string; onAction: () => void } | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SwipeAction({ children, action, style, testID }: SwipeActionProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const ref = useRef<SwipeableMethods>(null);
  if (!action) return <View style={style}>{children}</View>;
  const run = () => {
    ref.current?.close();
    action.onAction();
  };
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1.5}
      rightThreshold={64}
      overshootRight={false}
      containerStyle={style}
      onSwipeableOpen={(direction) => {
        if (direction === 'left') run();
      }}
      renderRightActions={() => (
        <Pressable
          onPress={run}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={styles.action}
          testID={testID ? `${testID}-action` : undefined}
        >
          <Icon name={action.icon} size={22} color={colors.primaryText} />
          <Text style={styles.label}>{action.label}</Text>
        </Pressable>
      )}
      testID={testID}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  action: {
    width: 96,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
  },
  label: { ...fonts.semibold, fontSize: 13, lineHeight: 16, color: colors.primaryText },
}));
