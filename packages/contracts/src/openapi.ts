import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { ErrorCodes, NEXT_ACTIONS, type ErrorCode, type ErrorNextAction } from './errors';
import { namedSchemas, z } from './zod';

/**
 * Single OpenAPI registry (specification §4.8: publish exact schemas before client integration).
 * Each module registers its paths and components from its `api/<module>.ts` contract file.
 */
export const openApiRegistry = new OpenAPIRegistry();

/** The §4.10 error body: `code` and `nextAction` are the closed lists clients switch on. */
export const ErrorResponseSchema = z
  .object({
    code: z.enum(Object.keys(ErrorCodes) as [ErrorCode, ...ErrorCode[]]),
    message: z.string(),
    correlationId: z.string(),
    nextAction: z.enum(NEXT_ACTIONS as unknown as [ErrorNextAction, ...ErrorNextAction[]]),
    details: z.unknown().optional(),
  })
  .openapi('ErrorResponse');

openApiRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

type Definitions = OpenAPIRegistry['definitions'];

function generate(definitions: Definitions, version: string): OpenAPIObject {
  return new OpenApiGeneratorV31(definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Sportspark Operating API',
      version,
      description:
        'Versioned, command-oriented API for the Sportspark facility operating platform. Organization context is derived from the authenticated principal, never from request identifiers.',
    },
    servers: [{ url: '/v1' }],
    security: [{ bearerAuth: [] }],
  });
}

/**
 * Builds the published document (§4.8).
 *
 * zod-to-openapi copies a named schema's refId onto `.nullable()`, so the component used to come
 * from whichever variant a route met first. Every named schema the document uses is therefore
 * generated first from its base (`namedSchemas()`), and a nullable use of a named schema, which
 * the generator emits as `allOf [$ref, { type: [..., 'null'] }]`, is rewritten to
 * `anyOf [$ref, { type: 'null' }]` (`nullableReferences`). No component is nullable itself.
 */
export function buildOpenApiDocument(version: string): OpenAPIObject {
  const definitions = openApiRegistry.definitions;
  const used = new Set(Object.keys(generate([...definitions], version).components?.schemas ?? {}));
  const bases: Definitions = [];
  for (const [name, schema] of namedSchemas()) {
    if (used.has(name)) bases.push({ type: 'schema', schema });
  }
  return nullableReferences(generate([...bases, ...definitions], version));
}

type Json = unknown;

function isNullMarker(node: Record<string, unknown>): boolean {
  return (
    (Array.isArray(node['type']) && (node['type'] as unknown[]).includes('null')) ||
    (Array.isArray(node['enum']) && (node['enum'] as unknown[]).includes(null))
  );
}

function isRef(node: unknown): node is { $ref: string } {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as Record<string, unknown>)['$ref'] === 'string' &&
    Object.keys(node).length === 1
  );
}

/** Rewrites every nullable use of a named schema to `anyOf [$ref, { type: 'null' }]`. */
export function nullableReferences<T>(document: T): T {
  const visit = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(visit);
    if (typeof node !== 'object' || node === null) return node;
    const object = Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, visit(v)]),
    );
    const allOf = object['allOf'];
    if (Array.isArray(allOf) && allOf.length === 2) {
      const ref = allOf.find(isRef);
      const other = allOf.find((part) => part !== ref) as Record<string, unknown> | undefined;
      if (ref && other && typeof other === 'object' && isNullMarker(other)) {
        const { type: _type, enum: _enum, ...rest } = other;
        const { allOf: _allOf, ...outer } = object;
        return { ...outer, ...rest, anyOf: [ref, { type: 'null' }] };
      }
    }
    const oneOf = object['oneOf'];
    if (
      Array.isArray(oneOf) &&
      oneOf.length === 2 &&
      oneOf.some(isRef) &&
      oneOf.some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>)['type'] === 'null' &&
          Object.keys(part).length === 1,
      )
    ) {
      const { oneOf: _oneOf, ...outer } = object;
      return { ...outer, anyOf: [oneOf.find(isRef), { type: 'null' }] };
    }
    return object;
  };
  return visit(document) as T;
}
