/**
 * "Load more" for a paged list (`useApiPages`; §4.5, SPK-UX-008): shown only while the API says
 * more exists, so nothing is silently cut off. Loading the next page is announced; a failure keeps
 * the loaded items and shows the code with "Try again"; offline, the button is disabled and says
 * it needs a connection (§4.15).
 */
import { presentationForError } from '@sportspark/api-client';
import type { ApiPagesResult } from '../api/useApiPages';
import { useApp } from '../providers/AppProviders';
import { Button } from './Button';
import { StateView } from './StateView';

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
  const { online } = useApp();
  if (pages.data === undefined || !pages.hasNextPage) return null;
  const failure = pages.nextPageError;
  return (
    <div className="load-more" data-testid="load-more">
      {failure && presentationForError(failure) !== 'offline' ? (
        <StateView variant="error" error={failure} onRetry={pages.loadMore} />
      ) : null}
      {pages.isFetchingNextPage ? (
        <p role="progressbar" aria-busy="true" aria-label={`Loading more ${label}`}>
          Loading more {label}…
        </p>
      ) : (
        <Button
          variant="secondary"
          onClick={pages.loadMore}
          disabled={!online}
          aria-label={`Load more ${label}`}
        >
          Load more
        </Button>
      )}
      {!online || (failure && presentationForError(failure) === 'offline') ? (
        <p className="caption">Loading more {label} needs a connection.</p>
      ) : null}
    </div>
  );
}
