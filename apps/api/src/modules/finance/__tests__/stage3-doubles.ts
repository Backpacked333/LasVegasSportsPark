import type { TestingModuleBuilder } from '@nestjs/testing';
import { DomainError, newId, type PolicyKind, type PolicyVersion } from '@sportspark/contracts';
import type { Db, GrantPermissionValue } from '@sportspark/db';
import {
  DATABASE,
  RELATIONSHIP_AUTHORITY_IMPL,
  currentTransaction,
  type Trx,
} from '../../../kernel';
import { POLICY_PORT, PoliciesService } from '../../catalog';
import { PERSON_DIRECTORY_PORT, PeopleService, RelationshipAuthority } from '../../identity';

/**
 * Test doubles for stage-3 port members declared on the core branch and implemented by other
 * modules' work items: ID-01 (PersonDirectoryPort.personIdsResolvingTo, IF-09), ID-09
 * (subjectsWithPermission behind customerSubjects, IF-02) and CAT-02 (the `tax_fee` policy kind of
 * POLICY_PORT, IF-48). Each double wraps the module's real provider and answers through the
 * declared contract only while the real member is still `declaredNotImplemented` (or, for
 * `tax_fee`, for the approved versions a test names), so once the owning work item is merged these
 * tests exercise the real implementation unchanged. Test infrastructure only: production code calls
 * the ports as declared.
 */

function isDeclaredNotImplemented(error: unknown): boolean {
  return (
    DomainError.is(error) &&
    error.code === 'INTERNAL_ERROR' &&
    /declared but not implemented/.test(error.message)
  );
}

async function realOr<T>(real: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await real();
  } catch (error) {
    if (isDeclaredNotImplemented(error)) return fallback();
    throw error;
  }
}

function reader(db: Db, trx?: Trx): Db | Trx {
  return trx ?? currentTransaction() ?? db;
}

/** Approved `tax_fee` versions (CAT-02 content) a test sells under, by policy key. */
const taxFeeVersions = new Map<string, PolicyVersion>();

/** Records an approved, effective `tax_fee` policy version for `key` (DEC-057 test data). */
export function approveTaxFee(
  key: string,
  content: Record<string, unknown>,
  options: { effectiveFrom?: string } = {},
): PolicyVersion {
  const now = new Date().toISOString();
  const version: PolicyVersion = {
    id: newId(),
    kind: 'tax_fee' as PolicyKind,
    key,
    version: (taxFeeVersions.get(key)?.version ?? 0) + 1,
    title: `Approved ${key}`,
    content,
    effectiveFrom: options.effectiveFrom ?? '2000-01-01T00:00:00.000Z',
    effectiveTo: null,
    approvalStatus: 'approved',
    approvedAt: now,
    retiredAt: null,
    retiredReason: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  taxFeeVersions.set(key, version);
  return version;
}

/** The overrides, for `createTestApp({ configure })`. */
export function withStage3Doubles(builder: TestingModuleBuilder): TestingModuleBuilder {
  return (
    builder
      // IF-09 (ID-01): the ids merged into a person.
      .overrideProvider(PERSON_DIRECTORY_PORT)
      .useFactory({
        inject: [PeopleService, DATABASE],
        factory: (people: PeopleService, db: Db) => {
          const port = Object.create(people) as PeopleService;
          port.personIdsResolvingTo = (organizationId, personId, trx) =>
            realOr(
              () => people.personIdsResolvingTo(organizationId, personId, trx),
              async () => {
                if (!(await people.findPerson(organizationId, personId, trx))) return [];
                const canonical = await people.resolveCanonicalPersonId(
                  organizationId,
                  personId,
                  trx,
                );
                const merged = await reader(db, trx)
                  .selectFrom('persons')
                  .select('id')
                  .where('organization_id', '=', organizationId)
                  .where('merged_into_person_id', 'is not', null)
                  .execute();
                const ids = [canonical];
                for (const row of merged) {
                  if (
                    (await people.resolveCanonicalPersonId(organizationId, row.id, trx)) ===
                    canonical
                  ) {
                    ids.push(row.id);
                  }
                }
                return [canonical, ...ids.slice(1).sort()];
              },
            );
          return port;
        },
      })
      // IF-02 (ID-09): the subjects the actor holds a permission over (the core default is []).
      .overrideProvider(RELATIONSHIP_AUTHORITY_IMPL)
      .useFactory({
        inject: [RelationshipAuthority],
        factory: (authority: RelationshipAuthority) => {
          const port = Object.create(authority) as RelationshipAuthority;
          port.subjectsWithPermission = async (
            organizationId: string,
            actorPersonId: string,
            permission: GrantPermissionValue,
          ) => {
            const real = await authority.subjectsWithPermission(
              organizationId,
              actorPersonId,
              permission,
            );
            const held = (await authority.authoritiesOf(organizationId, actorPersonId))
              .filter((a) => a.permissions.includes(permission))
              .map((a) => a.subjectPersonId);
            return [...new Set([...real, ...held])].sort();
          };
          return port;
        },
      })
      // IF-48 (CAT-02): approved `tax_fee` versions named by the test.
      .overrideProvider(POLICY_PORT)
      .useFactory({
        inject: [PoliciesService],
        factory: (policies: PoliciesService) => {
          const port = Object.create(policies) as PoliciesService;
          port.currentPolicyVersion = async (organizationId, kind, key, at, trx) => {
            if ((kind as string) === 'tax_fee') {
              const version = taxFeeVersions.get(key);
              if (version && new Date(version.effectiveFrom) <= at) return version;
              return realOr(
                () => policies.currentPolicyVersion(organizationId, kind, key, at, trx),
                async () => null,
              ).catch(() => null);
            }
            return policies.currentPolicyVersion(organizationId, kind, key, at, trx);
          };
          port.getPolicyVersion = async (organizationId, policyVersionId, trx) => {
            for (const version of taxFeeVersions.values()) {
              if (version.id === policyVersionId) return version;
            }
            return policies.getPolicyVersion(organizationId, policyVersionId, trx);
          };
          return port;
        },
      })
  );
}
