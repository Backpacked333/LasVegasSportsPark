import type { Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RECOVERY_SCOPE_KEY } from '../../../kernel';
import { applicationRouteFacts, emitOpenApiDocument } from '../../../openapi-document';
import { SupportModule } from '../support.module';

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
 * R3-OPERATIONS-02 (§5.8, SPK-AT-028): the support command that moves money — a refund requested
 * from a case — is refused by RecoveryGuard while the organization recovers from a restore, exactly
 * like finance's own refund route, and its contract publishes that 503. Every other support
 * command moves no money and stays available.
 */
describe('support commands during recovery (§5.8, SPK-AT-028)', () => {
  const controllers = new Map(
    (Reflect.getMetadata('controllers', SupportModule) as Array<Type<unknown>>).map((c) => [
      c.name,
      c,
    ]),
  );
  const commands = applicationRouteFacts().filter(
    (fact) => controllers.has(fact.controller) && fact.method !== 'GET',
  );
  const refused = commands.filter(
    (fact) => recoveryScope(controllers.get(fact.controller)!, fact.handler) === 'refused',
  );

  it('SPK-AT-028 (R3-OPERATIONS-02): POST /cases/{id}/request-refund is refused during recovery, and only it', () => {
    expect(commands.length).toBeGreaterThan(5);
    expect(refused.map((f) => `${f.method} ${f.path}`)).toEqual([
      'POST /cases/{id}/request-refund',
    ]);
  });

  it('SPK-AT-028 (R2-API-CONTRACT-03 for support): the refused command documents 503 INTEGRATION_UNAVAILABLE; the others do not', () => {
    for (const fact of commands) {
      const operation = document.paths[fact.path]?.[fact.method.toLowerCase()] as Json | undefined;
      expect(operation, `${fact.method} ${fact.path}`).toBeDefined();
      const documents503 = '503' in (operation!['responses'] as Json);
      expect(documents503, `${fact.method} ${fact.path}`).toBe(refused.includes(fact));
    }
  });
});
