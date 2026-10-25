import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import type { Clock } from '../clock';
import { CLOCK, DATABASE } from '../tokens';

/**
 * Deletes idempotency records past their `expires_at` (IDEMPOTENCY_TTL_HOURS), in bounded batches
 * over `idempotency_keys_expiry_idx`. An expired key is already treated as absent (a claim deletes
 * it and starts over), so the sweep removes nothing that is still live; it keeps stored responses,
 * including any customer-private body, from staying at rest after their replay window (§4.9,
 * §4.14). Run by the worker (`worker.ts`); safe to run from several workers at once.
 */
@Injectable()
export class IdempotencySweeper {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Deletes up to `limit` expired records; returns how many were deleted. */
  async runOnce(limit = 500): Promise<number> {
    const now = this.clock.now();
    const deleted = await sql<{ n: number }>`
      with expired as (
        select organization_id, scope_key, idempotency_key from idempotency_keys
        where expires_at < ${now}
        order by expires_at
        limit ${limit}
        for update skip locked
      )
      delete from idempotency_keys k
      using expired e
      where k.organization_id = e.organization_id
        and k.scope_key = e.scope_key
        and k.idempotency_key = e.idempotency_key
        and k.expires_at < ${now}
    `.execute(this.db);
    return Number(deleted.numAffectedRows ?? 0);
  }

  /** Sweeps until no expired record is left (bounded by `maxBatches`). */
  async sweep(limit = 500, maxBatches = 20): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const n = await this.runOnce(limit);
      total += n;
      if (n < limit) break;
    }
    return total;
  }
}
