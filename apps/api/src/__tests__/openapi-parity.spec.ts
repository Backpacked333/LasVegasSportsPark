import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../modules';
import { applicationRouteFacts, emitOpenApiDocument } from '../openapi-document';
import { createTestApp, type TestApp } from '../testing';

type Layer = { route?: { path: string; methods: Record<string, boolean> } };
type Json = Record<string, unknown>;

/** Served routes that are not part of the client API, with the reason. */
const UNPUBLISHED: Record<string, string> = {
  'GET /ready':
    'Deployment readiness probe (503 while the database is unavailable); clients use GET /health.',
  'GET /health': 'Liveness probe; documented as well, but parity does not depend on it.',
};

/**
 * Served routes the contracts do not document yet, each naming the work item that documents it.
 * An entry that has become documented fails the test, so the list only shrinks.
 */
const KNOWN_UNDOCUMENTED: Record<string, string> = {};

/** Commands that are consequential-free reads or provider callbacks: never Idempotency-Key. */
const HEADER_FREE = [
  'POST /discounts/evaluate',
  'POST /passes/scan',
  'POST /releases/collector-checks',
  'POST /webhooks/payments/{provider}',
  'POST /webhooks/messaging/{provider}',
  'POST /webhooks/access-control/{provider}',
];

const document = emitOpenApiDocument('0.1.0') as unknown as {
  paths: Record<string, Json>;
  components: Json;
};

function operations(): Array<{ key: string; operation: Json }> {
  const out: Array<{ key: string; operation: Json }> = [];
  for (const [route, item] of Object.entries(document.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = item[method] as Json | undefined;
      if (operation) out.push({ key: `${method.toUpperCase()} ${route}`, operation });
    }
  }
  return out;
}

function hasHeader(operation: Json, name: string): boolean {
  return ((operation['parameters'] as Json[] | undefined) ?? []).some(
    (p) => p['in'] === 'header' && String(p['name']).toLowerCase() === name.toLowerCase(),
  );
}

describe('OpenAPI parity with the served routes (K-02, §4.8, §4.9)', () => {
  let app: TestApp;
  const served = new Set<string>();

  beforeAll(async () => {
    app = await createTestApp({ imports: DOMAIN_MODULES, principalResolver: 'module' });
    const express = app.app.getHttpAdapter().getInstance() as {
      router?: { stack: Layer[] };
      _router?: { stack: Layer[] };
    };
    for (const layer of (express.router ?? express._router)?.stack ?? []) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        const route = layer.route.path.replace(/^\/v1(?=\/)/, '').replace(/:(\w+)/g, '{$1}');
        served.add(`${method.toUpperCase()} ${route}`);
      }
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('route facts name exactly the routes the application serves', () => {
    expect(served.size).toBeGreaterThan(100);
    const facts = new Set(applicationRouteFacts().map((f) => `${f.method} ${f.path}`));
    expect([...served].filter((k) => !facts.has(k)).sort()).toEqual([]);
    expect([...facts].filter((k) => !served.has(k)).sort()).toEqual([]);
  });

  it('§4.8: every served route is documented and every documented operation is served', () => {
    const documented = new Set(operations().map((o) => o.key));
    const undocumented = [...served]
      .filter((k) => !documented.has(k) && !(k in UNPUBLISHED) && !(k in KNOWN_UNDOCUMENTED))
      .sort();
    expect(undocumented).toEqual([]);
    expect([...documented].filter((k) => !served.has(k)).sort()).toEqual([]);
    // The exemption lists only name served routes, and a known gap that is now documented is
    // removed from the list.
    expect(Object.keys(UNPUBLISHED).filter((k) => !served.has(k))).toEqual([]);
    expect(Object.keys(KNOWN_UNDOCUMENTED).filter((k) => documented.has(k))).toEqual([]);
  });

  it('§4.9: every @Idempotent route declares Idempotency-Key and no other route does', () => {
    const idempotent = new Set(
      applicationRouteFacts()
        .filter((f) => f.idempotent)
        .map((f) => `${f.method} ${f.path}`),
    );
    const withHeader = operations()
      .filter((o) => hasHeader(o.operation, 'Idempotency-Key'))
      .map((o) => o.key);
    expect(withHeader.filter((k) => !idempotent.has(k)).sort()).toEqual([]);
    expect([...idempotent].filter((k) => !withHeader.includes(k)).sort()).toEqual([]);
    for (const key of HEADER_FREE.filter((k) => served.has(k))) {
      expect(idempotent.has(key), key).toBe(false);
    }
    // Every consequential command (a write that is not a read-only POST or a webhook) is idempotent.
    const writes = [...served].filter((k) => /^(POST|PUT|PATCH|DELETE) /.test(k));
    const notIdempotent = writes.filter(
      (k) => !idempotent.has(k) && !HEADER_FREE.includes(k) && k !== 'POST /dev/tokens',
    );
    expect(notIdempotent.sort()).toEqual([]);
  });

  it('public routes declare no security and every other route keeps the bearer requirement', () => {
    const publicRoutes = new Set(
      applicationRouteFacts()
        .filter((f) => f.isPublic)
        .map((f) => `${f.method} ${f.path}`),
    );
    for (const { key, operation } of operations()) {
      if (publicRoutes.has(key)) expect(operation['security'], key).toEqual([]);
      else expect(operation['security'], key).toBeUndefined();
    }
  });

  it('SPK-AT-027: every operation accepts X-Sportspark-Client and answers 426 unless any build may call it', () => {
    const anyVersion = new Set(
      applicationRouteFacts()
        .filter((f) => f.anyClientVersion)
        .map((f) => `${f.method} ${f.path}`),
    );
    expect(anyVersion.has('GET /health')).toBe(true);
    const parameters = document.components['parameters'] as Json;
    expect(parameters['ClientInfo']).toMatchObject({ name: 'X-Sportspark-Client', in: 'header' });
    for (const { key, operation } of operations()) {
      const params = (operation['parameters'] as Json[] | undefined) ?? [];
      expect(
        params.some((p) => p['$ref'] === '#/components/parameters/ClientInfo'),
        key,
      ).toBe(true);
      const responses = operation['responses'] as Json;
      expect('426' in responses, key).toBe(!anyVersion.has(key));
    }
  });

  it('the committed docs/api/openapi.json equals a fresh emission (run pnpm build && pnpm openapi)', () => {
    const committed = readFileSync(
      path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'api', 'openapi.json'),
      'utf8',
    );
    expect(committed === `${JSON.stringify(document, null, 2)}\n`, 'openapi.json is stale').toBe(
      true,
    );
  });
});
