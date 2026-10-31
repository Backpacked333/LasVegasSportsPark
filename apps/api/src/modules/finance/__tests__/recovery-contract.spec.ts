import type { Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RECOVERY_SCOPE_KEY } from '../../../kernel';
import { applicationRouteFacts, emitOpenApiDocument } from '../../../openapi-document';
import { FinanceModule } from '../finance.module';

type Json = Record<string, unknown>;

const document = emitOpenApiDocument('0.1.0') as unknown as { paths: Record<string, Json> };

/** The recovery scope a handler declares (handler first, then its controller, as RecoveryGuard). */
function recoveryScope(controller: Type<unknown>, handler: string): unknown {
  const method = (controller.prototype as Record<string, unknown>)[handler] as object;
  return (
    Reflect.getMetadata(RECOVERY_SCOPE_KEY, method) ??
    Reflect.getMetadata(RECOVERY_SCOPE_KEY, controller)
  );
}

/**
 * §4.10, §5.8, SPK-AT-028 (R2-API-CONTRACT-03): every finance command that RecoveryGuard refuses
 * during a restore publishes that 503 in its contract, so a generated client can present it.
 */
describe('finance recovery refusal in the published contract (§5.8, SPK-AT-028)', () => {
  const controllers = new Map(
    (Reflect.getMetadata('controllers', FinanceModule) as Array<Type<unknown>>).map((c) => [
      c.name,
      c,
    ]),
  );
  const refused = applicationRouteFacts().filter((fact) => {
    const controller = controllers.get(fact.controller);
    return (
      controller !== undefined &&
      fact.method !== 'GET' &&
      recoveryScope(controller, fact.handler) === 'refused'
    );
  });

  it('SPK-AT-028 (R2-API-CONTRACT-03): every finance command refused during recovery documents 503 INTEGRATION_UNAVAILABLE', () => {
    // The point-of-sale and accounting commands are among them (18 of the routes).
    const keys = refused.map((f) => `${f.method} ${f.path}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'POST /pos-sales',
        'POST /pos-sales/{id}/returns',
        'PATCH /pos-products/{id}',
        'POST /pos-register-sessions/{id}/close',
        'POST /accounting-export-batches',
        'POST /accounting-mappings/{id}/approve',
        'POST /registration-checkouts',
      ]),
    );
    const undocumented = refused.filter((fact) => {
      const operation = document.paths[fact.path]?.[fact.method.toLowerCase()] as Json | undefined;
      return !operation || !('503' in (operation['responses'] as Json));
    });
    expect(undocumented.map((f) => `${f.method} ${f.path}`)).toEqual([]);
  });

  it('SPK-AT-028: reads stay available during recovery and do not document the refusal', () => {
    for (const path of ['/pos-products', '/pos-sales/{id}', '/accounting-export-batches']) {
      const responses = (document.paths[path]?.['get'] as Json)['responses'] as Json;
      expect('503' in responses, path).toBe(false);
    }
  });
});
