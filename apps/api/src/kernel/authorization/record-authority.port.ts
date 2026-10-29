import type { ImportEntityTypeValue, RecordAuthorityScope } from '@sportspark/contracts';
import type { Trx } from '../database/unit-of-work';

/**
 * In-process record authority (K-11, IF-42; §5.6 "a synchronized copy never becomes an
 * independent writer", §4.7 invariant 11). HTTP write routes are classified with
 * `@RecordAuthority` / `@NoRecordAuthority` and guarded by the migration module. A command that
 * creates or changes records of a §5.3 category without passing such a route (a call into another
 * module's records, an outbox handler or a periodic job creating records) asserts this port with
 * the most specific scope it knows, inside its unit of work. Follow-ups that only transition
 * records an already-guarded command created, and migration's own import commands, do not.
 *
 * Refuses with ACCESS_DENIED (`nextAction: write_in_authoritative_system`, `details { code:
 * 'LEGACY_AUTHORITY', recordCategory }`) while the most specific assignment in effect names the
 * legacy system; without a scope, while any assignment of the category does.
 */
export interface RecordAuthorityPort {
  assertNoLegacyAuthority(
    organizationId: string,
    category: ImportEntityTypeValue,
    scope?: RecordAuthorityScope,
    trx?: Trx,
  ): Promise<void>;
}

export const RECORD_AUTHORITY_PORT = Symbol('RECORD_AUTHORITY_PORT');
/** Registered by the migration module (MIG-00); resolved lazily, so there is no import cycle. */
export const RECORD_AUTHORITY_IMPL = Symbol('RECORD_AUTHORITY_IMPL');

/** Without the migration module no assignment exists: SportsPark is authoritative for everything. */
export const sportsparkAuthoritative: RecordAuthorityPort = {
  assertNoLegacyAuthority: async () => undefined,
};
