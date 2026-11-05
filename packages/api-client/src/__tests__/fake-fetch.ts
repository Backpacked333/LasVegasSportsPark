/** Deterministic fetch double for client tests: records every request, answers from a script. */
import type { FetchLike } from '../client';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (
  request: RecordedRequest,
  init: RequestInit,
) => Response | Promise<Response>;

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function fakeFetch(responder: Responder): FetchLike & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fn = async (input: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const recorded: RecordedRequest = {
      url: input,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(recorded);
    // Like the platform fetch: an already-aborted signal rejects immediately.
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    return responder(recorded, init);
  };
  return Object.assign(fn, { requests });
}

/** A key generator that yields key-00000001, key-00000002, ... */
export function sequentialKeys(): () => string {
  let n = 0;
  return () => `key-${String(++n).padStart(8, '0')}`;
}
