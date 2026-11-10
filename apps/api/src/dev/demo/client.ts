import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { newId } from '@sportspark/contracts';
import { API_PREFIX } from '../../kernel/app-setup';

/** A signed-in demo actor: the bearer token of one local account. */
export interface DemoSession {
  subject: string;
  accountId: string;
  personId: string;
  token: string;
}

export interface DemoResponse<T = unknown> {
  status: number;
  body: T;
}

/** A command the API refused while the demo dataset was being created. */
export class DemoRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`demo seed: ${method} ${path} answered ${status}: ${JSON.stringify(body)}`);
  }
}

/**
 * The demo seed's HTTP client (§4.2: a module is the only writer of its tables, so the seed sends
 * the commands a client would). It talks to the assembled application over loopback, with a fresh
 * `Idempotency-Key` per command (§4.9); a refusal stops the seed with the API's own answer.
 */
export class DemoClient {
  constructor(private readonly baseUrl: string) {}

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    session: DemoSession | null,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<DemoResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (session) headers['Authorization'] = `Bearer ${session.token}`;
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = `demo-${newId()}`;
    }
    const payload = method === 'GET' ? null : JSON.stringify(body ?? {});
    if (payload !== null) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const response = await send(url, method, headers, payload);
    const text = response.text;
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed as T };
  }

  private async expectOk<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    session: DemoSession | null,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const response = await this.request<T>(method, path, session, body, query);
    if (response.status < 200 || response.status >= 300) {
      throw new DemoRequestError(method, path, response.status, response.body);
    }
    return response.body;
  }

  get<T = Record<string, unknown>>(
    path: string,
    session: DemoSession | null,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return this.expectOk<T>('GET', path, session, undefined, query);
  }

  post<T = Record<string, unknown>>(
    path: string,
    session: DemoSession | null,
    body: unknown = {},
  ): Promise<T> {
    return this.expectOk<T>('POST', path, session, body);
  }

  patch<T = Record<string, unknown>>(
    path: string,
    session: DemoSession | null,
    body: unknown = {},
  ): Promise<T> {
    return this.expectOk<T>('PATCH', path, session, body);
  }
}

/**
 * One request on a connection of its own (`agent: false`). The seed pauses between commands while
 * follow-ups drain, longer than the server keeps an idle connection, so a kept-alive connection
 * would be reset under the next command.
 */
function send(
  url: URL,
  method: string,
  headers: Record<string, string>,
  payload: string | null,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', reject);
    request.end(payload ?? undefined);
  });
}

/**
 * Opens the application's HTTP server for the seed. A server that already listens is used as it
 * is; otherwise it listens on an ephemeral loopback port until `close()` (the `seed:dev` script, a
 * test, and `dev:all`, which opens its own port only after the seed).
 */
export async function openDemoClient(
  app: INestApplication,
): Promise<{ client: DemoClient; close: () => Promise<void> }> {
  const server = app.getHttpServer() as Server;
  let opened = false;
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    opened = true;
  }
  const { port } = server.address() as AddressInfo;
  return {
    client: new DemoClient(`http://127.0.0.1:${port}/${API_PREFIX}`),
    close: async () => {
      if (!opened) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
