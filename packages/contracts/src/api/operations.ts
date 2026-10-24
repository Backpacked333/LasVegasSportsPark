import { z } from '../zod';
import { OperationSchema } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';

export const OperationResponse = OperationSchema.openapi('Operation');

openApiRegistry.registerPath({
  method: 'get',
  path: '/operations/{id}',
  summary: 'Read an authorized asynchronous outcome',
  tags: ['Operations'],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Operation state',
      content: { 'application/json': { schema: OperationResponse } },
    },
    404: {
      description: 'Not found or not visible',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const HealthResponse = z
  .object({ status: z.literal('ok'), version: z.string(), database: z.enum(['ok', 'unavailable']) })
  .openapi('Health');

openApiRegistry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Liveness and dependency status',
  tags: ['Operations'],
  security: [],
  responses: {
    200: {
      description: 'Service health',
      content: { 'application/json': { schema: HealthResponse } },
    },
  },
});
