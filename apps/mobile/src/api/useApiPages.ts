/**
 * "Load more" over a paged API list (§4.5 keyset cursors, §4.8; SPK-UX-008): the first page loads
 * like any read, each "Load more" asks for the page after the last one with the API's opaque
 * `nextCursor`, and the list never hides that more exists. Typed from the OpenAPI document: only
 * paths whose answer is `{ items, nextCursor }` are accepted.
 *
 *   const bookings = useApiPages({ path: '/me/bookings', request: { query: { limit: 20 } } });
 *   <QueryBoundary query={bookings} ...>{(items) => <BookingRows items={items} />}</QueryBoundary>
 *   <LoadMore pages={bookings} label="bookings" />
 *
 * The boundary fields (`data`, `error`, `fetchStatus`, `updatedAt`, `refetch`) describe the list:
 * a failed "Load more" keeps the loaded items on screen and is reported in `nextPageError` (shown
 * by `LoadMore` next to its button), not as a failure of the whole list. `updatedAt` is the age
 * of the oldest loaded page (§4.15). Items repeated across a page boundary are shown once (`keyOf`,
 * default the item's `id`).
 */
import {
  idOf,
  mergePages,
  nextCursorOf,
  pagedQueryKey,
  pagesReceivedAt,
  withCursor,
  type ApiError,
  type ApiResponse,
  type OptionsArg,
  type PageItem,
  type PagedGetPath,
  type ResponseBody,
} from '@sportspark/api-client';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApi } from '../providers/AppProviders';

type RequestOf<P extends PagedGetPath> = NonNullable<OptionsArg<P, 'get'>[0]>;
type PageBody<P extends PagedGetPath> = ResponseBody<P, 'get'>;

export type ApiPagesArgs<P extends PagedGetPath> = {
  path: P;
  enabled?: boolean;
  staleTime?: number;
  keyOf?: (item: PageItem<P>) => string;
} & (undefined extends OptionsArg<P, 'get'>[0]
  ? { request?: Omit<RequestOf<P>, 'signal'> }
  : { request: Omit<RequestOf<P>, 'signal'> });

export interface ApiPagesResult<T> {
  /** Every loaded item, in order; undefined until the first page arrives. */
  data: T[] | undefined;
  /** A failure of the list itself (first page or refresh); null when only "Load more" failed. */
  error: ApiError | null;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  updatedAt: Date | null;
  refetch: () => unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** The last "Load more" failed; the loaded items stay. */
  nextPageError: ApiError | null;
  loadMore: () => void;
}

export function useApiPages<P extends PagedGetPath>(
  args: ApiPagesArgs<P>,
): ApiPagesResult<PageItem<P>> {
  const api = useApi();
  const request = (args.request ?? {}) as { path?: object; query?: object };
  const query = useInfiniteQuery<
    ApiResponse<PageBody<P>>,
    ApiError,
    InfiniteData<ApiResponse<PageBody<P>>, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: pagedQueryKey(args.path, request),
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      (
        api.request as (
          method: 'get',
          path: string,
          options: object,
        ) => Promise<ApiResponse<PageBody<P>>>
      )('get', args.path, { ...request, query: withCursor(request.query, pageParam), signal }),
    getNextPageParam: (last) =>
      nextCursorOf(last.data as { nextCursor: string | null } | undefined),
    enabled: args.enabled,
    staleTime: args.staleTime,
  });
  const pages = query.data?.pages;
  // Pass a stable `keyOf` (module level) to keep `data` the same array between renders.
  const keyOf = args.keyOf;
  const items = useMemo(
    () =>
      pages
        ? mergePages(
            pages.map((p) => p.data as unknown as { items: readonly PageItem<P>[] }),
            keyOf ?? (idOf as (item: PageItem<P>) => string),
          )
        : undefined,
    [pages, keyOf],
  );
  const nextPageFailed = query.isFetchNextPageError && pages !== undefined;
  return {
    data: items,
    error: nextPageFailed ? null : query.error,
    fetchStatus: query.fetchStatus,
    updatedAt: pages ? pagesReceivedAt(pages) : null,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    nextPageError: nextPageFailed ? query.error : null,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}
