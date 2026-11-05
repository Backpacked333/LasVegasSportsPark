/**
 * Screen frame: the connectivity banner (SCR-C-40) on every screen, then the content. Scrolls so
 * large text never truncates a status (SPK-UX-009).
 */
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ConnectivityBanner } from '../connectivity/ConnectivityBanner';
import { colors } from './theme';

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return (
    <View style={styles.root}>
      <ConnectivityBanner />
      {scroll ? (
        <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
      ) : (
        <View style={styles.root}>{children}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1 },
});
