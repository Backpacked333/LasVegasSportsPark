import type { TestingModuleBuilder } from '@nestjs/testing';
import { DomainError, type TeamRoleValue } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { currentTransaction, DATABASE, type Trx } from '../../../kernel';
import { TEAM_ENTRY_QUERY_PORT, TeamEntriesService } from '../../competition';
import { PERSON_DIRECTORY_PORT, PeopleService, type PersonDisplayName } from '../../identity';

/** Shared helpers for the communications API tests (not a spec file). */

function isDeclaredNotImplemented(error: unknown): boolean {
  return (
    DomainError.is(error) &&
    error.code === 'INTERNAL_ERROR' &&
    /declared but not implemented/.test(error.message)
  );
}

/**
 * Stage-3 interfaces this module consumes are declared by their owners and implemented on the
 * owners' branches (IF-09 `displayNames` / `personIdsResolvingTo`: identity's ID-01; IF-15
 * `roleHolders`: competition's CMP-01). These doubles answer from the owner's implementation when
 * it is present; until then they follow the declared contract with the same rule over the
 * owner's rows. Test support only: the module itself reads through the ports.
 */
export function withDeclaredPortDoubles(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder
    .overrideProvider(PERSON_DIRECTORY_PORT)
    .useFactory({
      inject: [PeopleService, DATABASE],
      factory: (people: PeopleService, db: Db) => {
        const port = Object.create(people) as PeopleService;
        port.displayNames = async (organizationId, personIds, trx) => {
          try {
            return await people.displayNames(organizationId, personIds, trx);
          } catch (error) {
            if (!isDeclaredNotImplemented(error)) throw error;
          }
          const names = new Map<string, PersonDisplayName>();
          const ids = [...new Set(personIds)];
          if (ids.length === 0) return names;
          const rows = await (trx ?? currentTransaction() ?? db)
            .selectFrom('persons')
            .select(['id', 'given_name', 'family_name', 'kind'])
            .where('organization_id', '=', organizationId)
            .where('id', 'in', ids)
            .execute();
          for (const row of rows) {
            names.set(row.id, {
              personId: row.id,
              givenName: row.given_name,
              familyName: row.family_name,
              displayName: `${row.given_name} ${row.family_name}`,
              kind: row.kind,
            });
          }
          return names;
        };
        port.personIdsResolvingTo = async (organizationId, personId, trx) => {
          try {
            return await people.personIdsResolvingTo(organizationId, personId, trx);
          } catch (error) {
            if (!isDeclaredNotImplemented(error)) throw error;
          }
          const reader: Db | Trx = trx ?? currentTransaction() ?? db;
          if (!(await people.findPerson(organizationId, personId, trx))) return [];
          const canonical = await people.resolveCanonicalPersonId(organizationId, personId, trx);
          const merged = await reader
            .selectFrom('persons')
            .select('id')
            .where('organization_id', '=', organizationId)
            .where('merged_into_person_id', 'is not', null)
            .orderBy('id')
            .execute();
          const ids: string[] = [];
          for (const row of merged) {
            if (
              (await people.resolveCanonicalPersonId(organizationId, row.id, trx)) === canonical
            ) {
              ids.push(row.id);
            }
          }
          return [canonical, ...ids];
        };
        return port;
      },
    })
    .overrideProvider(TEAM_ENTRY_QUERY_PORT)
    .useFactory({
      inject: [TeamEntriesService, DATABASE],
      factory: (entries: TeamEntriesService, db: Db) => {
        const port = Object.create(entries) as TeamEntriesService;
        port.roleHolders = async (organizationId, teamEntryId, roles, at, trx) => {
          try {
            return await entries.roleHolders(organizationId, teamEntryId, roles, at, trx);
          } catch (error) {
            if (!isDeclaredNotImplemented(error)) throw error;
          }
          if (roles.length === 0) return [];
          const rows = await (trx ?? currentTransaction() ?? db)
            .selectFrom('team_roles')
            .select(['person_id', 'role'])
            .where('organization_id', '=', organizationId)
            .where('team_entry_id', '=', teamEntryId)
            .where('role', 'in', [...roles])
            .where('effective_from', '<=', at)
            .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
            .orderBy('role')
            .orderBy('person_id')
            .execute();
          return rows.map((r) => ({ personId: r.person_id, role: r.role as TeamRoleValue }));
        };
        return port;
      },
    });
}
