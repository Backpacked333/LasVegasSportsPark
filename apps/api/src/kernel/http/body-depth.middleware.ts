import { errors } from '@sportspark/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * The nesting depth of a parsed body: the longest chain of objects and arrays, 0 for a scalar.
 * Iterative, so it never overflows the stack itself, and it stops as soon as `limit` is exceeded.
 */
export function nestingDepthExceeds(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (depth > limit) return true;
    const children = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}

/**
 * Refuses a body nested deeper than `maxDepth` (HTTP_BODY_MAX_DEPTH) right after the body parsers
 * (§4.10, completing R3-SECURITY-03). A route whose contract has an open field
 * (`z.record(z.string(), z.unknown())`) validates such a body as it is and then serializes it with
 * recursive code (`json(value)` -> `JSON.stringify`, the drivers), which overflows the stack at a
 * few thousand levels: the client got 500 INTERNAL_ERROR / retry_or_contact_support for input it
 * must correct, logged as an unhandled fault. Now it gets 400 VALIDATION_FAILED, correct_input,
 * `details.code = 'body_too_deep'` and the limit, on every route, before authentication.
 */
export function bodyDepthMiddleware(maxDepth: number): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!nestingDepthExceeds((req as { body?: unknown }).body, maxDepth)) {
      next();
      return;
    }
    next(
      errors.validation('The request body is nested deeper than this service accepts.', {
        code: 'body_too_deep',
        limitDepth: maxDepth,
      }),
    );
  };
}
