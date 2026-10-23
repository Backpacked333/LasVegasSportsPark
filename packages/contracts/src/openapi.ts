import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { z } from './zod';

/**
 * Single OpenAPI registry (specification §4.8: publish exact schemas before client integration).
 * Each module registers its paths and components from its `api/<module>.ts` contract file.
 */
export const openApiRegistry = new OpenAPIRegistry();

export const ErrorResponseSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string(),
    nextAction: z.string(),
    details: z.unknown().optional(),
  })
  .openapi('ErrorResponse');

openApiRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

export function buildOpenApiDocument(version: string): OpenAPIObject {
  const generator = new OpenApiGeneratorV31(openApiRegistry.definitions);
  return generator.generateDocument({
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
