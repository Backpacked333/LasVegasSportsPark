import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z, type ZodType } from 'zod';

// Under zod 4 the `.openapi()` extension only applies to schemas created after extension.
// Every contract file (and every module API file in apps/api) must import `z` from here.
extendZodWithOpenApi(z);

/**
 * Index of every named contract schema (§4.8 "publish exact schemas before client integration").
 *
 * zod-to-openapi 9.1 copies a named schema's refId onto the result of `.nullable()` (and
 * `.optional()`, `.min()`, ...), so the component would come from whichever variant the generator
 * met first: a `.nullable()` use met first made the component itself nullable. The index lets
 * `buildOpenApiDocument` generate every named base schema before the routes that use variants of it
 * (`openapi.ts`). A name given to two different schemas is a collision the contracts test reports.
 */
interface NamedEntry {
  schema: ZodType;
  sources: Set<unknown>;
}

const named = new Map<string, NamedEntry>();

type OpenApiMethod = (this: ZodType, ...args: unknown[]) => ZodType;
const prototype = z.ZodType.prototype as unknown as { openapi: OpenApiMethod };
const originalOpenApi = prototype.openapi;
prototype.openapi = function namedOpenApi(this: ZodType, ...args: unknown[]): ZodType {
  const result = originalOpenApi.apply(this, args);
  const refId = typeof args[0] === 'string' ? args[0] : undefined;
  if (refId) {
    const entry = named.get(refId);
    if (entry) entry.sources.add(this);
    else named.set(refId, { schema: result, sources: new Set([this]) });
  }
  return result;
};

/** Every schema registered with `.openapi('<Name>')`, by name (the first registration wins). */
export function namedSchemas(): ReadonlyMap<string, ZodType> {
  return new Map([...named.entries()].map(([name, entry]) => [name, entry.schema]));
}

/** Names given to more than one distinct schema: each would emit one component for both. */
export function namedSchemaCollisions(): readonly string[] {
  return [...named.entries()]
    .filter(([, entry]) => entry.sources.size > 1)
    .map(([name]) => name)
    .sort();
}

/**
 * A boolean query flag (`?active=true`): only the strings `true` and `false` are accepted, so a
 * typo never reads as false (z.coerce.boolean would turn any non-empty string into true).
 */
export const QueryBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');

export { z };
