import {
  RequestMethod,
  type DynamicModule,
  type ForwardReference,
  type Type,
} from '@nestjs/common';
import { MODULE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  CLIENT_INFO_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  type buildOpenApiDocument,
} from '@sportspark/contracts';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { ANY_CLIENT_VERSION_KEY } from './client-compatibility.guard';
import { IDEMPOTENT_KEY } from './idempotency.interceptor';
import {
  recordAuthorityOf,
  type RecordAuthorityClassification,
} from './record-authority.decorator';

/**
 * Route facts (K-02, IF-07, §4.8, §4.9): what each served route declares through decorators,
 * read from Nest metadata without instantiating anything. They are the single source of the
 * `Idempotency-Key` header (`@Idempotent()`), of public access (`@Public()`), of the client
 * version gate exemption (`@AnyClientVersion()`) and of the §5.6 record-authority classification
 * (`@RecordAuthority` / `@NoRecordAuthority`) in the published document.
 */
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

export interface RouteFact {
  method: RouteMethod;
  /** OpenAPI form without the `/v1` prefix: `/people/{id}`. */
  path: string;
  idempotent: boolean;
  isPublic: boolean;
  anyClientVersion: boolean;
  recordAuthority:
    | { kind: 'guarded'; category: string; scope: unknown }
    | { kind: 'exempt'; reason: string }
    | null;
  controller: string;
  handler: string;
}

type ModuleLike = Type<unknown> | DynamicModule | ForwardReference | Promise<DynamicModule>;

const METHODS: Partial<Record<RequestMethod, RouteMethod>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** `people` + `:id/merge` → `/people/{id}/merge`. */
export function toOpenApiPath(...segments: string[]): string {
  const joined = `/${segments.join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function metadata<T>(key: string, ...targets: object[]): T | undefined {
  for (const target of targets) {
    const value = Reflect.getMetadata(key, target) as T | undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

function handlerNames(controller: Type<unknown>): string[] {
  const names = new Set<string>();
  let prototype = controller.prototype as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor && typeof descriptor.value === 'function') names.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return [...names];
}

function factsOfController(controller: Type<unknown>): RouteFact[] {
  const facts: RouteFact[] = [];
  const prefixes = asArray(Reflect.getMetadata(PATH_METADATA, controller) ?? '/') as string[];
  for (const name of handlerNames(controller)) {
    const handler = (controller.prototype as Record<string, unknown>)[name] as object;
    const routePaths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
    if (routePaths === undefined) continue;
    const requestMethod =
      (Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined) ??
      RequestMethod.GET;
    const method = METHODS[requestMethod];
    if (!method) continue;
    const classification: RecordAuthorityClassification | null = recordAuthorityOf(handler);
    for (const prefix of prefixes) {
      for (const routePath of asArray(routePaths) as string[]) {
        facts.push({
          method,
          path: toOpenApiPath(prefix, routePath),
          idempotent: metadata<boolean>(IDEMPOTENT_KEY, handler, controller) === true,
          isPublic: metadata<boolean>(IS_PUBLIC_KEY, handler, controller) === true,
          anyClientVersion: metadata<boolean>(ANY_CLIENT_VERSION_KEY, handler, controller) === true,
          recordAuthority: classification,
          controller: controller.name,
          handler: name,
        });
      }
    }
  }
  return facts;
}

/**
 * Every route the given root modules serve: their controllers and those of every module they
 * import, transitively (dynamic modules and forward references included). Nothing is instantiated.
 */
export function collectRouteFacts(rootModules: readonly ModuleLike[]): RouteFact[] {
  const seenModules = new Set<unknown>();
  const seenControllers = new Set<Type<unknown>>();
  const facts: RouteFact[] = [];
  const visit = (entry: unknown): void => {
    if (!entry || seenModules.has(entry)) return;
    if (entry instanceof Promise) {
      throw new Error('collectRouteFacts cannot read an asynchronous dynamic module');
    }
    seenModules.add(entry);
    if (typeof entry === 'object' && 'forwardRef' in entry) {
      visit((entry as ForwardReference).forwardRef());
      return;
    }
    const isDynamic = typeof entry === 'object' && 'module' in entry;
    const moduleClass = (isDynamic ? (entry as DynamicModule).module : entry) as Type<unknown>;
    const controllers = [
      ...asArray(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass)),
      ...(isDynamic ? asArray((entry as DynamicModule).controllers) : []),
    ] as Type<unknown>[];
    for (const controller of controllers) {
      if (seenControllers.has(controller)) continue;
      seenControllers.add(controller);
      facts.push(...factsOfController(controller));
    }
    const imports = [
      ...asArray(Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass)),
      ...(isDynamic ? asArray((entry as DynamicModule).imports) : []),
    ];
    if (isDynamic && !seenModules.has(moduleClass)) visit(moduleClass);
    for (const imported of imports) visit(imported);
  };
  for (const root of rootModules) visit(root);
  return facts.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
type Json = Record<string, unknown>;

/** §4.9: the header every `@Idempotent()` command requires. */
export const IDEMPOTENCY_KEY_PARAMETER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Required on this consequential command (§4.9). The same key with the same payload replays the stored outcome (`Idempotent-Replayed: true`); the same key with a different payload answers IDEMPOTENCY_CONFLICT; keys expire after the configured window.',
  schema: { type: 'string', minLength: 8, maxLength: 128 },
} as const;

/** K-03, SPK-AT-027: the client identification header, optional on every operation. */
export const CLIENT_INFO_PARAMETER = {
  name: 'X-Sportspark-Client',
  in: 'header',
  required: false,
  description:
    'Identifies the calling app build: `sportspark-(mobile|staff)/<semver[-pre]> (ios|android|web)`. Absent: served. Malformed: VALIDATION_FAILED (details.header). Below the configured minimum for its app and platform: 426 CLIENT_UPDATE_REQUIRED (details.app, platform, clientVersion, minimumVersion). Minimum versions are Proposed configuration pending DEC-061; the error is DEC-092.',
  schema: {
    type: 'string',
    pattern: '^sportspark-(mobile|staff)/[0-9A-Za-z.+-]+ \\((ios|android|web)\\)$',
  },
} as const;

const CLIENT_INFO_REF = { $ref: '#/components/parameters/ClientInfo' };

const CLIENT_UPDATE_RESPONSE = {
  description:
    'CLIENT_UPDATE_REQUIRED: this app build is below the minimum supported version for its platform (details.minimumVersion; SPK-AT-027, DEC-061, DEC-092)',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function isHeader(parameter: unknown, name: string): boolean {
  const p = parameter as Json | null;
  return (
    !!p &&
    p['in'] === 'header' &&
    typeof p['name'] === 'string' &&
    (p['name'] as string).toLowerCase() === name.toLowerCase()
  );
}

/**
 * Applies the route facts to the generated document, never inventing a route (the parity test
 * reports routes the document lacks):
 *
 * - `Idempotency-Key` (required) on exactly the `@Idempotent()` operations; a header a contract
 *   declared by hand elsewhere is removed, so the decorator is the one source (§4.9);
 * - `security: []` on `@Public()` operations;
 * - `X-Sportspark-Client` (`components.parameters.ClientInfo`) on every operation, and a 426
 *   response on every operation not marked `@AnyClientVersion()` (K-03, SPK-AT-027).
 */
export function applyRouteFacts(
  document: OpenApiDocument,
  facts: readonly RouteFact[],
): OpenApiDocument {
  const byKey = new Map(facts.map((fact) => [`${fact.method} ${fact.path}`, fact]));
  const copy = JSON.parse(JSON.stringify(document)) as OpenApiDocument & Json;
  const components = ((copy as Json)['components'] ?? {}) as Json;
  components['parameters'] = {
    ...((components['parameters'] as Json | undefined) ?? {}),
    ClientInfo: CLIENT_INFO_PARAMETER,
  };
  (copy as Json)['components'] = components;
  for (const [path, item] of Object.entries((copy.paths ?? {}) as Record<string, Json>)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method] as Json | undefined;
      if (!operation) continue;
      const fact = byKey.get(`${method.toUpperCase()} ${path}`);
      const parameters = ((operation['parameters'] as unknown[] | undefined) ?? []).filter(
        (p) =>
          !isHeader(p, IDEMPOTENCY_KEY_HEADER) &&
          !isHeader(p, CLIENT_INFO_HEADER) &&
          (p as Json)['$ref'] !== CLIENT_INFO_REF.$ref,
      );
      if (fact?.idempotent) parameters.push({ ...IDEMPOTENCY_KEY_PARAMETER });
      parameters.push({ ...CLIENT_INFO_REF });
      operation['parameters'] = parameters;
      if (fact?.isPublic) operation['security'] = [];
      if (!fact?.anyClientVersion) {
        const responses = (operation['responses'] ?? {}) as Json;
        responses['426'] = CLIENT_UPDATE_RESPONSE;
        operation['responses'] = responses;
      }
    }
  }
  return copy;
}
