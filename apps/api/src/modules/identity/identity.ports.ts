import type { GrantPermissionValue, PersonKind, PersonStatus } from '@sportspark/db';
import type { StaffRole } from '@sportspark/contracts';
import type { Trx } from '../../kernel';

/**
 * Ports other modules consume. They receive minimal, non-sensitive person data; callers that
 * need to show a person to a user go through PeopleService.getPerson with their principal so
 * object-level authorization applies (§4.14).
 */
export const PERSON_DIRECTORY_PORT = Symbol('PERSON_DIRECTORY_PORT');
export const AUTHORITY_LOOKUP_PORT = Symbol('AUTHORITY_LOOKUP_PORT');
export const STAFF_DIRECTORY_PORT = Symbol('STAFF_DIRECTORY_PORT');

export interface PersonSummary {
  id: string;
  organizationId: string;
  kind: PersonKind;
  status: PersonStatus;
  /** ISO date (YYYY-MM-DD) or null; eligibility is evaluated from this, never from a stored age (§4.5). */
  dateOfBirth: string | null;
  /** When the person was merged, the survivor's id; otherwise the same id. */
  canonicalPersonId: string;
}

export interface PersonDirectoryPort {
  /** Returns the person in the organization or null (never throws for cross-organization ids). */
  findPerson(organizationId: string, personId: string, trx?: Trx): Promise<PersonSummary | null>;
  /** Follows person_merges so a module holding an old id reaches the surviving record. */
  resolveCanonicalPersonId(organizationId: string, personId: string, trx?: Trx): Promise<string>;
}

export interface AuthorityLookupPort {
  /** Current, effective permission check (same rule as the kernel relationship authority). */
  hasPermission(
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
    trx?: Trx,
  ): Promise<boolean>;
  /**
   * Whether the permission was effective at a past instant `asOf` (SPK-AT-018 "stale authority is
   * not asserted", SPK-ENTRY-007): the grant and its relationship inside their effective dates,
   * not yet revoked or ended, and under no suspension in force at that instant (from the
   * append-only suspension history). It answers "was it held then", never "is it held now": a
   * caller asserting authority at a recorded time also needs `hasPermission`.
   */
  hasPermissionAt(
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
    asOf: Date,
    trx?: Trx,
  ): Promise<boolean>;
  /** People who currently hold the permission over the subject (e.g. message recipients, SPK-COMMS-003). */
  actorsWithPermission(
    organizationId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
    trx?: Trx,
  ): Promise<string[]>;
}

export interface StaffDirectoryPort {
  /** Persons holding the role right now, optionally limited to a facility scope. */
  staffWithRole(
    organizationId: string,
    role: StaffRole,
    facilityId?: string | null,
    trx?: Trx,
  ): Promise<string[]>;
}
