import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@sportspark/contracts';
import {
  AuthorizationService,
  listFacilityScope,
  type ActionDefinition,
  type AuthorizationTargetInput,
  type Trx,
} from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { viewerOf, type RecordViewer } from '../enrollment.shared';

/**
 * Facility boundaries of enrollment records (§4.3 facility boundaries, §4.14 least privilege and
 * object-level authorization). Every application, enrollment, placement, waitlist entry, booking,
 * makeup, trial, basket line and offering pool hangs off an offering, and an offering belongs to
 * one facility (catalog, read through its port, never its table): staff scoped to some
 * facilities read, list and change only those facilities' records. A staff role held outside its
 * scope still leaves the person's own self and guardian authority (the kernel evaluates those
 * next, SPK-IAM-001/003). A capacity pool without an offering (a team-entry or rental pool)
 * stays organization-wide, as support and communications treat a record without a facility.
 */
@Injectable()
export class EnrollmentFacilityScope {
  constructor(
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    private readonly authorization: AuthorizationService,
  ) {}

  /** The facility of an offering, for an authorization target (undefined: organization-wide). */
  async facilityOf(
    organizationId: string,
    offeringId: string | null | undefined,
    trx?: Trx,
  ): Promise<string | undefined> {
    if (!offeringId) return undefined;
    const facilities = await this.offerings.facilitiesOfOfferings(
      organizationId,
      [offeringId],
      trx,
    );
    return facilities.get(offeringId);
  }

  /** The distinct facilities of several offerings (a command that spans them is checked at each). */
  async facilitiesOf(
    organizationId: string,
    offeringIds: ReadonlyArray<string | null | undefined>,
    trx?: Trx,
  ): Promise<string[]> {
    const ids = offeringIds.filter((id): id is string => !!id);
    const facilities = await this.offerings.facilitiesOfOfferings(organizationId, ids, trx);
    return [...new Set(facilities.values())].sort();
  }

  /**
   * Requires `action` on `target` at every one of `facilityIds` (`all`: a command that spans
   * several offerings, such as a transfer or a basket hold) or at least one of them (`any`: a
   * record usable at any of its facilities); with no facility, once organization-wide.
   */
  async requireAt(
    principal: Principal,
    action: ActionDefinition,
    target: AuthorizationTargetInput,
    facilityIds: readonly string[],
    mode: 'all' | 'any' = 'all',
  ): Promise<void> {
    if (facilityIds.length === 0) {
      await this.authorization.require(principal, action, target);
      return;
    }
    if (mode === 'all') {
      for (const facilityId of facilityIds) {
        await this.authorization.require(principal, action, { ...target, facilityId });
      }
      return;
    }
    for (const facilityId of facilityIds) {
      if ((await this.authorization.decide(principal, action, { ...target, facilityId })).allowed) {
        return;
      }
    }
    await this.authorization.require(principal, action, {
      ...target,
      facilityId: facilityIds[0],
    });
  }

  /**
   * R3-TRACE-A-02 (§2.1, §4.14, SPK-IAM-001/003, SPK-REG-008/009/010): whether `principal` holds
   * `action` through a staff role that covers every one of `facilityIds` (organization-wide when
   * none is given), or is the system. This is the kernel's own decision with no subject persons, so
   * only the staff-role basis can allow it. Every staff-only branch of a command or read (setting
   * a waitlist priority, skipping a required approval, recording attendance, naming another payer
   * or basket owner, the staff-assisted record, staff lists, unredacted payer facts) follows this,
   * never `principal.kind`: a staff member acting for their own family through self or guardian
   * authority is a customer for that command, whatever roles they hold elsewhere.
   */
  async actsAsStaff(
    principal: Principal,
    action: ActionDefinition,
    organizationId: string,
    facilityIds?: string | ReadonlyArray<string | null | undefined> | null,
  ): Promise<boolean> {
    if (principal.kind === 'system') return principal.organizationId === organizationId;
    if (principal.kind !== 'staff') return false;
    const facilities = (
      typeof facilityIds === 'string' ? [facilityIds] : (facilityIds ?? [])
    ).filter((id): id is string => !!id);
    for (const facilityId of facilities.length > 0 ? [...new Set(facilities)] : [undefined]) {
      const decision = await this.authorization.decide(principal, action, {
        type: action.id,
        organizationId,
        facilityId,
      });
      if (!decision.allowed) return false;
    }
    return true;
  }

  /** SPK-AT-004, R3-TRACE-A-02: the payer-privacy viewer of one record read through `action`. */
  async viewer(
    principal: Principal,
    action: ActionDefinition,
    organizationId: string,
    facilityId: string | null | undefined,
  ): Promise<RecordViewer> {
    return viewerOf(
      principal,
      await this.actsAsStaff(principal, action, organizationId, facilityId),
    );
  }

  /**
   * SPK-AT-004, R3-TRACE-A-02: the payer-privacy viewer of each listed record, decided at its
   * offering's facility (a list may span facilities the principal's roles cover differently).
   */
  async viewersByOffering(
    principal: Principal,
    action: ActionDefinition,
    organizationId: string,
    offeringIds: ReadonlyArray<string | null | undefined>,
    trx?: Trx,
  ): Promise<(offeringId: string | null | undefined) => RecordViewer> {
    const ids = [...new Set(offeringIds.filter((id): id is string => !!id))];
    const facilities =
      ids.length > 0
        ? await this.offerings.facilitiesOfOfferings(organizationId, ids, trx)
        : new Map<string, string>();
    const staffAt = new Map<string | undefined, boolean>();
    for (const facilityId of new Set<string | undefined>([...facilities.values(), undefined])) {
      staffAt.set(
        facilityId,
        await this.actsAsStaff(principal, action, organizationId, facilityId),
      );
    }
    return (offeringId) =>
      viewerOf(
        principal,
        staffAt.get(offeringId ? facilities.get(offeringId) : undefined) ?? false,
      );
  }

  /**
   * The offerings a list is narrowed to, matching the facility check the kernel applies to one
   * record: `null` when the list is not narrowed (a customer, whose access is decided per
   * participant; a staff role holding `action` organization-wide; or a staff member reading the
   * named participant through their own self or guardian authority, SPK-IAM-001/003), otherwise
   * the ids of the offerings at the facilities the action's roles cover (possibly none).
   */
  async listOfferings(
    principal: Principal,
    action: ActionDefinition,
    organizationId: string,
    participantPersonId?: string | null,
    trx?: Trx,
  ): Promise<string[] | null> {
    const scope = listFacilityScope(principal, action);
    if (scope === null) return null;
    if (participantPersonId && principal.personId) {
      const own = await this.authorization.decide({ ...principal, staffRoles: [] }, action, {
        type: 'participant',
        organizationId,
        subjectPersonIds: [participantPersonId],
        protected: true,
      });
      if (own.allowed) return null;
    }
    return this.offerings.offeringIdsAtFacilities(organizationId, scope, trx);
  }
}
