/**
 * "Load more" for a paged list (`useApiPages`; §4.5, SPK-UX-008): shown only while the API says
 * more exists, so nothing is silently cut off. Loading the next page is announced; a failure keeps
 * the loaded items and shows the code with "Try again"; offline, the button is disabled and says
 * it needs a connection (§4.15).
 */
import { presentationForError } from '@sportspark/api-client';
import { StyleSheet, Text, View } from 'react-native';
import type { ApiPagesResult } from '../api/useApiPages';
import { useConnectivity } from '../providers/AppProviders';
import { Button } from './Button';
import { StateView } from './StateView';
import { colors, spacing, type } from './theme';

export function LoadMore({
  pages,
  label,
}: {
  pages: Pick<
    ApiPagesResult<unknown>,
    'data' | 'hasNextPage' | 'isFetchingNextPage' | 'nextPageError' | 'loadMore'
  >;
  /** What the next page holds, e.g. "bookings". */
  label: string;
}) {
  const { reachable } = useConnectivity();
  if (pages.data === undefined || !pages.hasNextPage) return null;
  const failure = pages.nextPageError;
  const offline =
    reachable === false || (failure !== null && presentationForError(failure) === 'offline');
  return (
    <View style={styles.box} testID="load-more">
      {failure && presentationForError(failure) !== 'offline' ? (
        <StateView variant="error" error={failure} onRetry={pages.loadMore} />
      ) : null}
      <Button
        label={pages.isFetchingNextPage ? `Loading more ${label}…` : `Load more ${label}`}
        variant="secondary"
        busy={pages.isFetchingNextPage}
        disabled={reachable === false}
        onPress={pages.loadMore}
      />
      {offline ? (
        <Text style={styles.caption}>{`Loading more ${label} needs a connection.`}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: spacing.lg, gap: spacing.sm, alignItems: 'flex-start' },
  caption: { ...type.caption, color: colors.textMuted },
});
