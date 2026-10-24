/**
 * Data layer: typed GET queries over the API client with TanStack Query (§4.8). The cache holds
 * the full `ApiResponse`, so every result carries `updatedAt` (the client's receipt time from the
 * injected clock) and screens can show the age of what they display (§4.15, SPK-UX-008).
 */
import {
  apiQueryKey,
  type ApiError,
  type ApiResponse,
  type OptionsArg,
  type PathsWithMethod,
  type ResponseBody,
} from '@sportspark/api-client';
import { useQuery, type Query, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../providers/AppProviders';

type GetPath = PathsWithMethod<'get'>;
type RequestOf<P extends GetPath> = NonNullable<OptionsArg<P, 'get'>[0]>;

export type ApiQueryArgs<P extends GetPath> = {
  path: P;
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
} & (undefined extends OptionsArg<P, 'get'>[0]
  ? { request?: Omit<RequestOf<P>, 'signal'> }
  : { request: Omit<RequestOf<P>, 'signal'> });

export type ApiQueryResult<P extends GetPath> = Omit<
  UseQueryResult<ApiResponse<ResponseBody<P, 'get'>>, ApiError>,
  'data'
> & {
  data: ResponseBody<P, 'get'> | undefined;
  /** When the shown data was received, or null when nothing has loaded yet. */
  updatedAt: Date | null;
};

/** Receipt time of a cached query's data: the client's `receivedAt` when the query is ours. */
export function receivedAtOf(query: Query): number | null {
  const data = query.state.data as Partial<ApiResponse<unknown>> | undefined;
  if (data?.receivedAt instanceof Date) return data.receivedAt.getTime();
  return query.state.dataUpdatedAt > 0 ? query.state.dataUpdatedAt : null;
}

export function useApiQuery<P extends GetPath>(args: ApiQueryArgs<P>): ApiQueryResult<P> {
  const api = useApi();
  const request = (args.request ?? {}) as Record<string, unknown>;
  const query = useQuery<ApiResponse<ResponseBody<P, 'get'>>, ApiError>({
    queryKey: apiQueryKey(args.path, request as { path?: object; query?: object }),
    queryFn: ({ signal }) =>
      (
        api.request as (
          method: 'get',
          path: string,
          options: object,
        ) => Promise<ApiResponse<ResponseBody<P, 'get'>>>
      )('get', args.path, { ...request, signal }),
    enabled: args.enabled,
    staleTime: args.staleTime,
    refetchInterval: args.refetchInterval,
  });
  return {
    ...query,
    data: query.data?.data,
    updatedAt: query.data?.receivedAt ?? null,
  } as ApiQueryResult<P>;
}
