import { Inject, Injectable } from '@nestjs/common';
import type { Audience, RecipientBasisValue, StaffRole } from '@sportspark/contracts';
import type { Trx } from '../../../kernel';
import {
  AUTHORITY_LOOKUP_PORT,
  PERSON_DIRECTORY_PORT,
  STAFF_DIRECTORY_PORT,
  type AuthorityLookupPort,
  type PersonDirectoryPort,
  type StaffDirectoryPort,
} from '../../identity';
import { TEAM_MEMBERSHIP_PORT, type TeamMembershipPort } from '../ports';

export interface ResolvedRecipient {
  personId: string;
  basis: RecipientBasisValue;
  basisDetail: string | null;
  /** Participants whose `receive_messages` grants (or own adulthood) justified inclusion. */
  subjectPersonIds: string[];
}

export interface RecipientAuthorityCheck {
  personId: string;
  basis: RecipientBasisValue;
  basisDetail: string | null;
  subjectPersonIds: readonly string[];
}

/**
 * SPK-COMMS-003: recipients are resolved from CURRENT permissions, never from a stored list.
 *  - subject persons: the subject themself when an active adult, plus every active person who
 *    currently holds `receive_messages` over them (identity's relationship authority);
 *  - team entries: current roster members treated as subject persons (competition's port);
 *  - staff roles: persons holding the role right now, optionally within one facility;
 *  - explicit person ids: named by the composer (must exist and be active).
 * `isStillAuthorized` re-evaluates one recipient against the same sources at dispatch time and
 * immediately before an external hand-off (invariant 10, SPK-IAM-006, SPK-AT-017).
 */
@Injectable()
export class AudienceResolver {
  constructor(
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    @Inject(AUTHORITY_LOOKUP_PORT) private readonly authority: AuthorityLookupPort,
    @Inject(STAFF_DIRECTORY_PORT) private readonly staff: StaffDirectoryPort,
    @Inject(TEAM_MEMBERSHIP_PORT) private readonly teams: TeamMembershipPort,
  ) {}

  async resolve(
    organizationId: string,
    audience: Audience,
    trx?: Trx,
  ): Promise<ResolvedRecipient[]> {
    const out = new Map<string, ResolvedRecipient>();
    const add = (recipient: ResolvedRecipient): void => {
      const existing = out.get(recipient.personId);
      if (!existing) {
        out.set(recipient.personId, recipient);
        return;
      }
      for (const subject of recipient.subjectPersonIds) {
        if (!existing.subjectPersonIds.includes(subject)) existing.subjectPersonIds.push(subject);
      }
    };

    const subjects: Array<{ personId: string; teamEntryId: string | null }> =
      audience.subjectPersonIds.map((personId) => ({ personId, teamEntryId: null }));
    for (const teamEntryId of audience.teamEntryIds) {
      for (const member of await this.teams.membersOf(organizationId, teamEntryId, trx)) {
        subjects.push({ personId: member, teamEntryId });
      }
    }
    for (const subject of subjects) {
      const person = await this.persons.findPerson(organizationId, subject.personId, trx);
      if (!person || person.status !== 'active') continue;
      if (person.kind === 'adult') {
        add({
          personId: subject.personId,
          basis: subject.teamEntryId ? 'team_member' : 'self',
          basisDetail: subject.teamEntryId,
          subjectPersonIds: [subject.personId],
        });
      }
      const holders = await this.authority.actorsWithPermission(
        organizationId,
        subject.personId,
        'receive_messages',
        trx,
      );
      for (const holder of holders) {
        if (holder === subject.personId) continue;
        const actor = await this.persons.findPerson(organizationId, holder, trx);
        if (!actor || actor.status !== 'active') continue;
        add({
          personId: holder,
          basis: 'receive_messages',
          basisDetail: subject.teamEntryId,
          subjectPersonIds: [subject.personId],
        });
      }
    }
    for (const role of audience.staffRoles) {
      const members = await this.staff.staffWithRole(
        organizationId,
        role,
        audience.facilityId,
        trx,
      );
      for (const personId of members) {
        add({ personId, basis: 'staff_role', basisDetail: role, subjectPersonIds: [] });
      }
    }
    for (const personId of audience.personIds) {
      const person = await this.persons.findPerson(organizationId, personId, trx);
      if (!person || person.status !== 'active') continue;
      add({ personId, basis: 'explicit', basisDetail: null, subjectPersonIds: [] });
    }
    return [...out.values()]
      .map((r) => ({ ...r, subjectPersonIds: [...r.subjectPersonIds].sort() }))
      .sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));
  }

  /** Does the recipient still hold, right now, the authority that justified their inclusion? */
  async isStillAuthorized(
    organizationId: string,
    recipient: RecipientAuthorityCheck,
    facilityId: string | null,
    trx?: Trx,
  ): Promise<boolean> {
    const person = await this.persons.findPerson(organizationId, recipient.personId, trx);
    if (!person || person.status !== 'active') return false;
    switch (recipient.basis) {
      case 'self':
      case 'explicit':
        return true;
      case 'receive_messages': {
        const subjects = recipient.subjectPersonIds.filter((s) => s !== recipient.personId);
        if (subjects.length === 0) return false;
        for (const subject of subjects) {
          const ok = await this.authority.hasPermission(
            organizationId,
            recipient.personId,
            subject,
            'receive_messages',
            trx,
          );
          if (!ok) return false;
        }
        return true;
      }
      case 'staff_role': {
        if (!recipient.basisDetail) return false;
        const members = await this.staff.staffWithRole(
          organizationId,
          recipient.basisDetail as StaffRole,
          facilityId,
          trx,
        );
        return members.includes(recipient.personId);
      }
      case 'team_member': {
        if (!recipient.basisDetail) return false;
        return this.teams.isMember(organizationId, recipient.basisDetail, recipient.personId, trx);
      }
    }
  }
}
