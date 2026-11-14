/**
 * Screen frame: the connectivity banner (SCR-C-40) on every screen, then the content. Scrolls so
 * large text never truncates a status (SPK-UX-009). The page takes the theme's page colour; cards
 * sit on it. A button under an open keyboard answers the first tap (the tap is not spent on
 * closing the keyboard), and the scroll indicator stays visible in Legends mode.
 *
 * Under a floating glass tab bar (`BottomBarInsetContext`, set by the tabs navigator) the content
 * scrolls beneath the bar and ends above it: the last control is never covered.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { ConnectivityBanner } from '../connectivity/ConnectivityBanner';
import { makeStyles, spacing, useTheme } from './theme';

/** Height of a bar floating over the bottom of the screen; 0 when the bar is in the layout. */
export const BottomBarInsetContext = createContext(0);

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const { dark } = useTheme();
  const styles = useStyles();
  const bottomBar = useContext(BottomBarInsetContext);
  return (
    <View style={styles.root}>
      <ConnectivityBanner />
      {scroll ? (
        <ScrollView
          contentContainerStyle={[
            styles.content,
            bottomBar > 0 && { paddingBottom: spacing.xl + bottomBar },
          ]}
          scrollIndicatorInsets={{ bottom: bottomBar }}
          keyboardShouldPersistTaps="handled"
          indicatorStyle={dark ? 'white' : 'black'}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.root, bottomBar > 0 && { paddingBottom: bottomBar }]}>{children}</View>
      )}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.page },
  content: { flexGrow: 1, paddingTop: spacing.xs, paddingBottom: spacing.xl },
}));
