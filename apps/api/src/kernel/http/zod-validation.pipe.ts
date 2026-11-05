import { Body, Param, Query, type PipeTransform } from '@nestjs/common';
import { errors } from '@sportspark/contracts';
import type { ZodType } from 'zod';

const NUL_MESSAGE = 'Must not contain the NUL character (U+0000).';

/**
 * R2-TENANCY-INPUT-04b (§4.10): PostgreSQL `text` and `jsonb` cannot hold U+0000, so a request
 * string carrying one used to reach an insert and answer 500 INTERNAL_ERROR. Every validated body,
 * query and path value is walked (iteratively, so a deeply nested JSON document cannot exhaust
 * the stack) and any string value or object key that holds U+0000 answers 400 VALIDATION_FAILED
 * naming the field path. Other control characters stay each module's contract to refuse.
 */
export function nulCharacterPaths(value: unknown): string[] {
  const found: string[] = [];
  const stack: Array<{ value: unknown; path: Array<string | number> }> = [{ value, path: [] }];
  while (stack.length > 0) {
    const { value: current, path } = stack.pop()!;
    if (typeof current === 'string') {
      if (current.includes('\u0000')) found.push(path.join('.'));
      continue;
    }
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push({ value: current[i], path: [...path, i] });
      }
      continue;
    }
    if (current !== null && typeof current === 'object') {
      const proto = Object.getPrototypeOf(current) as unknown;
      if (proto !== Object.prototype && proto !== null) continue;
      const entries = Object.entries(current as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, child] = entries[i]!;
        if (key.includes('\u0000')) found.push([...path, key].join('.'));
        stack.push({ value: child, path: [...path, key] });
      }
    }
  }
  return found;
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw errors.validation(
        'Request validation failed.',
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      );
    }
    const nulPaths = nulCharacterPaths(result.data);
    if (nulPaths.length > 0) {
      throw errors.validation(
        'Request validation failed.',
        nulPaths.map((path) => ({ path, message: NUL_MESSAGE, code: 'custom' })),
      );
    }
    return result.data;
  }
}

/** `@ZodBody(Schema) body: z.infer<typeof Schema>` */
export const ZodBody = <T>(schema: ZodType<T>): ParameterDecorator =>
  Body(new ZodValidationPipe(schema));
export const ZodQuery = <T>(schema: ZodType<T>): ParameterDecorator =>
  Query(new ZodValidationPipe(schema));
export const ZodParams = <T>(schema: ZodType<T>): ParameterDecorator =>
  Param(new ZodValidationPipe(schema));
