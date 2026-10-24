/**
 * Type helpers over the generated OpenAPI `paths` (spec §4.8). They turn
 * `paths['/assignments/{id}/accept']['post']` into the request options and the success body the
 * client accepts and returns, so a call that does not match the published contract fails to compile.
 */
import type { CommandIntent } from './idempotency';
import type { components, paths } from './generated/paths';

export type { components, paths };
export type Schemas = components['schemas'];
/** A named schema from the OpenAPI document, e.g. `Schema<'Assignment'>`. */
export type Schema<Name extends keyof Schemas> = Schemas[Name];

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type CommandMethod = Exclude<HttpMethod, 'get'>;

type Defined<T> = Exclude<T, undefined>;
type IsNever<T> = [T] extends [never] ? true : false;

/** Paths that define the given method. */
export type PathsWithMethod<M extends HttpMethod> = {
  [P in keyof paths]: IsNever<Defined<paths[P][M]>> extends true ? never : P;
}[keyof paths];

/** The operation object for a path and method. */
export type Operation<P extends keyof paths, M extends HttpMethod> = Defined<paths[P][M]>;

type ParametersOf<O> = O extends { parameters: infer X } ? X : never;
type ParamGroup<O, G extends 'path' | 'query' | 'header'> =
  ParametersOf<O> extends { [K in G]?: infer X } ? Defined<X> : never;

export type PathParams<O> = ParamGroup<O, 'path'>;
export type QueryParams<O> = ParamGroup<O, 'query'>;

type RequestBodyOf<O> = O extends { requestBody?: infer B } ? Defined<B> : never;
export type RequestBody<O> =
  RequestBodyOf<O> extends { content: { 'application/json': infer J } } ? J : never;
type BodyIsRequired<O> = O extends { requestBody: unknown } ? true : false;

type ResponsesOf<O> = O extends { responses: infer R } ? R : never;
type SuccessStatus = 200 | 201 | 202 | 204;
/** The JSON body of the operation's 2xx response (`undefined` for an empty 204). */
export type SuccessBody<O> = {
  [S in keyof ResponsesOf<O>]: S extends SuccessStatus
    ? ResponsesOf<O>[S] extends { content: { 'application/json': infer J } }
      ? J
      : undefined
    : never;
}[keyof ResponsesOf<O>];

type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

type PathOption<O> =
  IsNever<PathParams<O>> extends true ? { path?: undefined } : { path: PathParams<O> };
type QueryOption<O> =
  IsNever<QueryParams<O>> extends true
    ? { query?: undefined }
    : IsNever<RequiredKeys<QueryParams<O>>> extends true
      ? { query?: QueryParams<O> }
      : { query: QueryParams<O> };
type BodyOption<O> =
  IsNever<RequestBody<O>> extends true
    ? { body?: undefined }
    : BodyIsRequired<O> extends true
      ? { body: RequestBody<O> }
      : { body?: RequestBody<O> };

/** Options every request accepts. */
export interface TransportOptions {
  /** Abort the request (screen unmounted, user navigated away). */
  signal?: AbortSignal;
  /** Overrides the client's default timeout. A timed-out command has an unknown outcome. */
  timeoutMs?: number;
}

/**
 * A command (any non-GET method) must carry the user intent it belongs to: the intent's
 * idempotency key is sent as `Idempotency-Key` and reused when the same intent is retried (§4.9).
 * The OpenAPI document does not declare the header on every command, so the client requires it
 * on all of them; the API ignores the header where a route is not idempotent.
 */
type IntentOption<M extends HttpMethod> = M extends 'get'
  ? { intent?: undefined }
  : { intent: CommandIntent };

export type RequestOptions<P extends keyof paths, M extends HttpMethod> = PathOption<
  Operation<P, M>
> &
  QueryOption<Operation<P, M>> &
  BodyOption<Operation<P, M>> &
  IntentOption<M> &
  TransportOptions;

type AllOptional<T> = IsNever<RequiredKeys<T>> extends true ? true : false;

/** Lets a caller omit the options argument when nothing in it is required. */
export type OptionsArg<P extends keyof paths, M extends HttpMethod> =
  AllOptional<RequestOptions<P, M>> extends true
    ? [options?: RequestOptions<P, M>]
    : [options: RequestOptions<P, M>];

export type ResponseBody<P extends keyof paths, M extends HttpMethod> = SuccessBody<
  Operation<P, M>
>;

/** A successful response with the metadata screens need for stale-data display and support. */
export interface ApiResponse<T> {
  data: T;
  status: number;
  /** `X-Correlation-Id` echoed by the API; quote it when contacting support (§4.10). */
  correlationId: string | null;
  /** `Idempotent-Replayed: true` when the API returned the stored outcome of an earlier attempt. */
  replayed: boolean;
  /** When the client received the response (client clock), for "updated <time>" labels. */
  receivedAt: Date;
}
