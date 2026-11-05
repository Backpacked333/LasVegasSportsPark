import { buildOpenApiDocument } from '@sportspark/contracts';
import { KERNEL_CONTROLLERS, KernelModule } from './kernel/kernel.module';
import { applyRouteFacts, collectRouteFacts, type RouteFact } from './kernel/http/route-catalog';
import { DOMAIN_MODULES } from './modules';

/** The route facts of everything `AppModule` serves: the kernel and every domain module (K-02). */
export function applicationRouteFacts(): RouteFact[] {
  return collectRouteFacts([
    { module: KernelModule, controllers: KERNEL_CONTROLLERS },
    ...DOMAIN_MODULES,
  ]);
}

/**
 * The published API document (§4.8): the contracts' schemas and routes, with the facts the
 * handlers declare (Idempotency-Key, public access, client version gate) applied. Written to
 * docs/api/openapi.json by `pnpm openapi`; `__tests__/openapi-parity.spec.ts` keeps it current.
 */
export function emitOpenApiDocument(version = process.env['APP_VERSION'] ?? '0.1.0') {
  return applyRouteFacts(buildOpenApiDocument(version), applicationRouteFacts());
}
