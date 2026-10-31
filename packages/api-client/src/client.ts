/**
 * Typed fetch wrapper for the Sportspark API (spec §4.8 to §4.10, §4.13).
 *
 * - Bearer token from the injected `SessionStore` on every request.
 * - `Idempotency-Key` from the caller's `CommandIntent` on every command (§4.9).
 * - The §4.10 error body parsed into `ApiError`; no connection and timeouts become typed errors too,
 *   including a body that stalls or breaks after the status line arrived.
 * - `X-Sportspark-Client` identifies app, platform and version on every request (§4.13), and the
 *   API's update-required answer (426 CLIENT_UPDATE_REQUIRED, below a configured minimum version:
 *   DEC-061) surfaces as `UpdateRequiredError`.
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
  /**
   * Called when a command answers ACCESS_DENIED `details.code: 'CAPABILITY_DISABLED'` (K-12): the
   * apps refresh `GET /v1/me/permissions` so every gate shows the switch as it now is.
   */
  onCapabilityDisabled?: (error: ApiError) => void;
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

/**
 * The response body as text, still under the request's timeout and the caller's abort: `fetch`
 * resolves once the headers arrive, so a body that stalls or fails after that must not escape the
 * typed errors (a 2xx whose body never arrived is a command whose answer was lost).
 */
function readText(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('The request was aborted.'));
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      response.body?.cancel().catch(() => undefined);
      reject(signal.reason ?? new Error('The request was aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    response.text().then(
      (text) => {
        signal.removeEventListener('abort', onAbort);
        resolve(text);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}

/** The response's `Date` header as a time, or null when it is absent, unreadable or invalid. */
function serverDateOf(response: Response): Date | null {
  const header = response.headers.get('Date');
  if (!header) return null;
  const at = new Date(header);
  return Number.isNaN(at.getTime()) ? null : at;
}

function parseBody(text: string): { parsed: unknown; ok: boolean } {
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
    try {
      return await exchange(method, template, opts);
    } catch (error) {
      // Screens tell a failed read (nothing changed) from a command that may have taken effect.
      if (error instanceof ApiError && error.method === null) error.method = method;
      throw error;
    }
  }

  async function exchange(
    method: HttpMethod,
    template: string,
    opts: LooseOptions,
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
    let text: string;
    // The timeout and the caller's abort cover the whole exchange, body included: a body that
    // stalls or breaks after the status line is a lost answer (timeout or network), never a raw
    // error, so the intent keeps its key and a retry gets the stored outcome (§4.9).
    try {
      response = await fetchImpl(url, {
        method: method.toUpperCase(),
        headers,
        body,
        signal: controller.signal,
      });
      text = await readText(response, controller.signal);
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
    const { parsed, ok: parsedOk } = parseBody(text);

    if (!response.ok) {
      const error = errorFromResponse(
        response.status,
        parsedOk ? parsed : undefined,
        correlationId,
      );
      if (error instanceof UpdateRequiredError) options.onUpdateRequired?.(error);
      else if (error.isAuthenticationRequired) options.onAuthenticationRequired?.(error);
      else if (error.isCapabilityDisabled) options.onCapabilityDisabled?.(error);
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
    return {
      data: parsed,
      status: response.status,
      correlationId,
      replayed,
      receivedAt: now(),
      serverDate: serverDateOf(response),
    };
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
