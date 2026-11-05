import type {
  AuthorityResolution,
  ExternalMapping,
  ImportEntityTypeValue,
} from '@sportspark/contracts';
import type { MappedEntityType } from '@sportspark/db';
import type { Trx } from '../../kernel';

/**
 * Ports other modules consume (README "Ports").
 *
 * AUTHORITY_GUARD_PORT (§5.6 "a synchronized copy does not become an independent writer", §4.7
 * invariant 11): before a module writes a record of a category, it asks which system is
 * authoritative for that category and scope. While the legacy system is authoritative the write
 * is refused, so SportsPark never becomes a second writer of a record the legacy system still
 * owns. Without any assignment SportsPark is authoritative (a facility that never migrates is
 * not affected). The migration module also enforces the guard on the HTTP write routes of every
 * category (AuthorityWriteInterceptor, deny-by-default over every served write route: a handler's
 * K-11 decorator first, then the static lists), so modules built before this port are covered on
 * their routes. In-process, the same AuthorityService implements the kernel's
 * RECORD_AUTHORITY_PORT (RECORD_AUTHORITY_IMPL, IF-42; scheduling's port writes, SCH-02) and
 * finance's (its refund command); other service-to-service writes are guarded only at their
 * routes (README "Known gaps").
 */
export const AUTHORITY_GUARD_PORT = Symbol('AUTHORITY_GUARD_PORT');

export interface AuthorityScopeRef {
  facilityId?: string | null;
  programId?: string | null;
  competitionId?: string | null;
}

export interface AuthorityGuardPort {
  /** The authoritative system at the instant (default: now) for the most specific scope. */
  resolve(
    organizationId: string,
    category: ImportEntityTypeValue,
    scope?: AuthorityScopeRef,
    at?: Date,
    trx?: Trx,
  ): Promise<AuthorityResolution>;
  /**
   * Throws ACCESS_DENIED (nextAction `write_in_authoritative_system`) unless SportsPark is the
   * authoritative system now. Reads through the active transaction when there is one.
   */
  assertSportsparkAuthority(
    organizationId: string,
    category: ImportEntityTypeValue,
    scope?: AuthorityScopeRef,
    trx?: Trx,
  ): Promise<AuthorityResolution>;
  /**
   * For a caller that cannot name the record's scope: throws the same ACCESS_DENIED while any
   * assignment of the category in effect, at any scope, names the legacy system.
   */
  assertNoLegacyAuthorityInEffect(
    organizationId: string,
    category: ImportEntityTypeValue,
    trx?: Trx,
  ): Promise<void>;
}

/** EXTERNAL_MAPPING_PORT: stable identity of migrated records (§5.3, SPK-AT-024). */
export const EXTERNAL_MAPPING_PORT = Symbol('EXTERNAL_MAPPING_PORT');

export interface ExternalMappingPort {
  /** The internal record a source system's external id was imported as, or null. */
  findInternalId(
    organizationId: string,
    sourceSystem: string,
    entityType: MappedEntityType,
    externalId: string,
    trx?: Trx,
  ): Promise<string | null>;
  /** Every external identifier an internal record was imported from (provenance). */
  mappingsFor(
    organizationId: string,
    entityType: MappedEntityType,
    internalId: string,
    trx?: Trx,
  ): Promise<ExternalMapping[]>;
}
