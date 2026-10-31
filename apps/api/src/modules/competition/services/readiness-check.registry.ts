import { Injectable } from '@nestjs/common';
import type { ReadinessCheck, ReadinessCheckRegistry } from '../ports';

/**
 * READINESS_CHECK_REGISTRY: process-wide registry of named readiness checks (SPK-READY-001).
 * Modules register in their onModuleInit; the evaluator (part 2) runs every check for a fixture
 * and classifies the issues (blocking, warning, info, unknown — SPK-READY-002). Registering the
 * same name twice is a programming error, like duplicate outbox handlers.
 */
@Injectable()
export class InMemoryReadinessCheckRegistry implements ReadinessCheckRegistry {
  private readonly byName = new Map<string, ReadinessCheck>();

  registerCheck(name: string, check: ReadinessCheck): void {
    if (this.byName.has(name)) throw new Error(`readiness check ${name} is already registered`);
    this.byName.set(name, check);
  }

  checks(): Array<{ name: string; check: ReadinessCheck }> {
    return [...this.byName.entries()].map(([name, check]) => ({ name, check }));
  }
}
