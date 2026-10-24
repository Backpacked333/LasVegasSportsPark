import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';

/**
 * A port whose implementation is registered by another module under `token` (an `*_IMPL` token).
 * The implementation is looked up on first use, never during instantiation: Nest (and the Promise
 * machinery) probe provider values for `then`, and a provider registered with useClass/useFactory/
 * useExisting is still `null` while the container is being built. Until an implementation exists
 * the `fallback` answers, with a single warning.
 */
export function lazyPort<T extends object>(
  moduleRef: ModuleRef,
  token: symbol | string,
  fallback: T,
  warning: string,
): T {
  const logger = new Logger('Kernel');
  let resolved: T | null = null;
  let warned = false;
  const resolve = (): T => {
    if (resolved) return resolved;
    let impl: T | null | undefined;
    try {
      impl = moduleRef.get<T>(token, { strict: false });
    } catch {
      impl = null;
    }
    if (impl) {
      resolved = impl;
      return impl;
    }
    if (!warned) {
      warned = true;
      logger.warn(warning);
    }
    return fallback;
  };
  return new Proxy(fallback, {
    get(target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') {
        return (target as Record<PropertyKey, unknown>)[prop];
      }
      const impl = resolve();
      const value = (impl as Record<PropertyKey, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(impl)
        : value;
    },
  });
}
