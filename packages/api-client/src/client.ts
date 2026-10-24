/**
 * Typed fetch wrapper for the Sportspark API (spec §4.8 to §4.10, §4.13).
 *
 * - Bearer token from the injected `SessionStore` on every request.
 * - `Idempotency-Key` from the caller's `CommandIntent` on every command (§4.9).
 * - The §4.10 error body parsed into `ApiError`; no connection and timeouts become typed errors too.
 * - `X-Sportspark-Client` identifies app, platform and version on every request (§4.13), and the
 *   proposed update-required answer surfaces as `UpdateRequiredError` (DEC-061, DEC-092).
 *
 * The client never decides authorization: it sends what the screen asks for and reports what the
 * API answers (ACCESS_DENIED, protected NOT_FOUND) for the screen to render.
 */
import { CLIENT_INFO_HEADER, formatClientInfo, type ClientInfo } from './client-info';
import {
  ApiError,
  UpdateRequiredError,
  errorFromResponse,
  networkError,
  timeoutError,
} from './errors';
import {
  CommandIntentTracker,
  createCommandIntent,
  defaultKeyGenerator,
  type CommandIntent,
  type KeyGenerator,
} from './idempotency';
import type { SessionStore } from './session';
import type {
  ApiResponse,
  HttpMethod,
  OptionsArg,
  PathsWithMethod,
  ResponseBody,
  TransportOptions,
  paths,
} from './types';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
export const DEFAULT_TIMEOUT_MS = 20_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** API origin plus version prefix, e.g. `http://localhost:3000/v1` or `/v1` behind a proxy. */
  baseUrl: string;
  session: SessionStore;
  clientInfo: ClientInfo;
  fetch?: FetchLike;
  /** Secure random key source; React Native injects expo-crypto's `randomUUID`. */
  generateKey?: KeyGenerator;
  timeoutMs?: number;
  /** Called once per response that says this build must be updated (SCR-C-39). */
  onUpdateRequired?: (error: UpdateRequiredError) => void;
  /** Called when the API answers AUTHENTICATION_REQUIRED: the session expired or was revoked. */
  onAuthenticationRequired?: (error: ApiError) => void;
  /** Client clock for `receivedAt` (injected in tests). */
  now?: () => Date;
}

type Method<M extends HttpMethod> = <P extends PathsWithMethod<M>>(
  path: P,
  ...args: OptionsArg<P, M>
) => Promise<ResponseBody<P, M>>;

type RequestMethod = <M extends HttpMethod, P extends PathsWithMethod<M>>(
  method: M,
  path: P,
  ...args: OptionsArg<P, M>
) => Promise<ApiResponse<ResponseBody<P, M>>>;

export interface ApiClient {
  readonly baseUrl: string;
  readonly clientInfo: ClientInfo;
  /** Full response with correlation id, replay flag and receipt time. */
  request: RequestMethod;
  get: Method<'get'>;
  post: Method<'post'>;
  put: Method<'put'>;
  patch: Method<'patch'>;
  delete: Method<'delete'>;
  /** A new user intent with a fresh idempotency key. */
  newIntent(): CommandIntent;
  /** A tracker that keeps one intent per unchanged input until `complete()`. */
  intentTracker(): CommandIntentTracker;
}

interface LooseOptions extends TransportOptions {
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  intent?: CommandIntent;
}

export function buildUrl(
  baseUrl: string,
  template: string,
  pathParams?: Record<string, string | number>,
  query?: Record<string, unknown>,
): string {
  const resolved = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathParams?.[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing path parameter "${name}" for ${template}`);
    }
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return `${baseUrl.replace(/\/+$/, '')}${resolved}${qs ? `?${qs}` : ''}`;
}

async function readBody(response: Response): Promise<{ parsed: unknown; ok: boolean }> {
  const text = await response.text();
  if (text.length === 0) return { parsed: undefined, ok: true };
  try {
    return { parsed: JSON.parse(text) as unknown, ok: true };
  } catch {
    return { parsed: undefined, ok: false };
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const generateKey = options.generateKey ?? defaultKeyGenerator;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientHeader = formatClientInfo(options.clientInfo);
  const now = options.now ?? (() => new Date());

  async function send(
    method: HttpMethod,
    template: string,
    opts: LooseOptions = {},
  ): Promise<ApiResponse<unknown>> {
    if (method !== 'get' && !opts.intent) {
      throw new Error(`${method.toUpperCase()} ${template} needs a CommandIntent (§4.9).`);
    }
    const url = buildUrl(options.baseUrl, template, opts.path, opts.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [CLIENT_INFO_HEADER]: clientHeader,
    };
    const session = await options.session.load();
    if (session) headers.Authorization = `Bearer ${session.token}`;
    if (opts.intent) headers[IDEMPOTENCY_KEY_HEADER] = opts.intent.key;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const timeoutMs = opts.timeoutMs ?? defaultTimeout;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    if (opts.signal?.aborted) {
      clearTimeout(timer);
      throw opts.signal.reason ?? new Error('The request was aborted.');
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: method.toUpperCase(),
        headers,
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) throw timeoutError(timeoutMs);
      // A caller-initiated abort (screen left) is not a failure; let the caller see the abort.
      if (opts.signal?.aborted) throw cause;
      throw networkError(cause);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }

    const correlationId = response.headers.get(CORRELATION_ID_HEADER);
    const replayed = response.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true';
    const { parsed, ok: parsedOk } = await readBody(response);

    if (!response.ok) {
      const error = errorFromResponse(
        response.status,
        parsedOk ? parsed : undefined,
        correlationId,
      );
      if (error instanceof UpdateRequiredError) options.onUpdateRequired?.(error);
      else if (error.isAuthenticationRequired) options.onAuthenticationRequired?.(error);
      throw error;
    }
    if (!parsedOk) {
      throw new ApiError({
        kind: 'unexpected_response',
        status: response.status,
        code: 'UNEXPECTED_RESPONSE',
        message: 'The service returned a response that could not be read.',
        nextAction: 'contact_support',
        correlationId,
      });
    }
    return { data: parsed, status: response.status, correlationId, replayed, receivedAt: now() };
  }

  const request = ((method: HttpMethod, path: string, opts?: LooseOptions) =>
    send(method, path, opts)) as RequestMethod;
  const dataOnly =
    (method: HttpMethod) =>
    async (path: string, opts?: LooseOptions): Promise<unknown> =>
      (await send(method, path, opts)).data;

  return {
    baseUrl: options.baseUrl,
    clientInfo: options.clientInfo,
    request,
    get: dataOnly('get') as Method<'get'>,
    post: dataOnly('post') as Method<'post'>,
    put: dataOnly('put') as Method<'put'>,
    patch: dataOnly('patch') as Method<'patch'>,
    delete: dataOnly('delete') as Method<'delete'>,
    newIntent: () => createCommandIntent(generateKey),
    intentTracker: () => new CommandIntentTracker(generateKey),
  };
}

/** Every path template in the OpenAPI document, e.g. `'/assignments/{id}/accept'`. */
export type ApiPath = keyof paths;
