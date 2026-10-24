/**
 * Section frame and per-section read state for screens built from several reads (SCR-C-03 Home,
 * SCR-C-18 Schedule, SCR-C-20 detail). Each section shows its own SPK-UX-008 state, so one failed
 * read never hides the others: loading, error with the API's code and recovery, offline with
 * nothing cached, and a protected NOT_FOUND or a denial as "not available" without implying a
 * record exists (§4.10). The page shows the age of what it displays once, not per section.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { StateView } from '../../ui/StateView';
import { colors, spacing, type } from '../../ui/theme';

export function Section({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

export interface ReadLike {
  data: unknown;
  error: ApiError | null;
  fetchStatus?: 'fetching' | 'paused' | 'idle';
  refetch?: () => unknown;
}

/**
 * The state to show instead of a section's content while it has no data, or null once it has.
 * `unavailable` overrides the default "not available" wording for this section.
 */
export function SectionQueryState({
  read,
  label,
  unavailable,
}: {
  read: ReadLike;
  label: string;
  unavailable?: { title?: string; description?: string };
}) {
  const now = useNow();
  const { reachable } = useConnectivity();
  if (read.data !== undefined) return null;
  const retry = read.refetch ? () => void read.refetch?.() : undefined;
  if (read.error) {
    const presentation = presentationForError(read.error);
    if (presentation === 'unavailable') {
      return <StateView variant="unavailable" {...unavailable} />;
    }
    if (presentation === 'offline') {
      return (
        <StateView variant="offline-stale" offline updatedAt={null} now={now} onRetry={retry} />
      );
    }
    return <StateView variant="error" error={read.error} onRetry={retry} />;
  }
  if (read.fetchStatus === 'paused' || reachable === false) {
    return <StateView variant="offline-stale" offline updatedAt={null} now={now} onRetry={retry} />;
  }
  return <StateView variant="loading" label={label} />;
}

/** Oldest receipt time among the reads that have data: the age the page states (§4.15). */
export function oldestUpdate(dates: readonly (Date | null)[]): Date | null {
  let oldest: Date | null = null;
  for (const d of dates) if (d && (!oldest || d < oldest)) oldest = d;
  return oldest;
}

export function Caption({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.caption} testID={testID}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm, paddingVertical: spacing.md },
  title: { ...type.heading, color: colors.text, paddingHorizontal: spacing.lg },
  caption: { ...type.caption, color: colors.textMuted, paddingHorizontal: spacing.lg },
});
