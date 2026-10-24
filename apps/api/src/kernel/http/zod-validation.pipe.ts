import { Body, Param, Query, type PipeTransform } from '@nestjs/common';
import { errors } from '@sportspark/contracts';
import type { ZodType } from 'zod';

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
