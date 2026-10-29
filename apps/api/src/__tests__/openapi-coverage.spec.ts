import { buildOpenApiDocument } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../modules';
import { createTestApp } from '../testing';

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

/** Served routes that are not part of the client API, with the reason. */
const UNPUBLISHED: Record<string, string> = {
  'GET /ready':
    'Deployment readiness probe (503 while the database is unavailable); clients use GET /health.',
};

/**
 * §4.8 "publish exact schemas before client integration": every route the complete application
 * serves under /v1 is registered in the OpenAPI document clients are generated from (CLAUDE.md:
 * contracts registered with the OpenAPI registry), so no served endpoint is missing from
 * docs/api/openapi.json.
 */
describe('OpenAPI coverage (§4.8)', () => {
  it('§4.8: every route the complete application serves is registered in the OpenAPI document', async () => {
    const app = await createTestApp({ imports: DOMAIN_MODULES, principalResolver: 'module' });
    try {
      const express = app.app.getHttpAdapter().getInstance() as {
        router?: { stack: Layer[] };
        _router?: { stack: Layer[] };
      };
      const stack = (express.router ?? express._router)?.stack ?? [];
      const served = new Set<string>();
      for (const layer of stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          const path = layer.route.path.replace(/^\/v1(?=\/)/, '').replace(/:(\w+)/g, '{$1}');
          served.add(`${method.toUpperCase()} ${path}`);
        }
      }
      expect(served.size).toBeGreaterThan(100);
      const document = buildOpenApiDocument('test');
      const published = new Set<string>();
      for (const [path, item] of Object.entries(document.paths ?? {})) {
        for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
          if ((item as Record<string, unknown>)[method]) {
            published.add(`${method.toUpperCase()} ${path}`);
          }
        }
      }
      const missing = [...served]
        .filter((route) => !published.has(route) && !(route in UNPUBLISHED))
        .sort();
      expect(missing).toEqual([]);
      // An exemption names a route that is still served.
      expect(Object.keys(UNPUBLISHED).filter((route) => !served.has(route))).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
