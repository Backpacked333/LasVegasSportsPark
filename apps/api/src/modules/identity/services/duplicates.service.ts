import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type DuplicateCandidate,
  type DuplicateCandidateDetail,
  type DuplicateCandidateView,
  type FlagDuplicateInput,
  type ListDuplicateCandidatesQueryInput,
  type MergeDuplicateInput,
  type Page,
  type PersonMerge,
  type Principal,
} from '@sportspark/contracts';
import { json, type AccessGrantsTable, type Db, type RelationshipsTable } from '@sportspark/db';
import { sql, type Selectable, type SqlBool } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  ensureUpdated,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import { DuplicateCandidateMachine } from '../identity.machines';
import {
  displayNameOf,
  iso,
  personColumns,
  toDuplicateCandidate,
  toPersonMerge,
  type PersonRow,
} from '../identity.shared';

const ListCursor = z.object({ c: z.iso.datetime(), id: z.uuid() });

export interface MergeSummary {
  contactPointsMoved: number;
  accountsMoved: number;
  accountsDisabled: number;
  relationshipsMoved: number;
  relationshipsConsolidated: number;
  relationshipsEnded: number;
  grantsMoved: number;
  grantsRevokedAsDuplicate: number;
  unverifiedRelationshipsSkipped: number;
  unverifiedGrantsSkipped: number;
  /** Self-service relationships over the survivor, ended because nobody verified them. */
  survivorUnverifiedRelationshipsEnded: number;
  /** The survivor's self-service creator privilege was cleared (it would reach merged history). */
  survivorCreatorPrivilegeCleared: boolean;
  householdMembershipsMoved: number;
  staffMembershipsMoved: number;
  pendingInvitationsRevoked: number;
  pendingClaimsRevoked: number;
  accessReviewsMoved: number;
  otherCandidatesDismissed: number;
}

/**
 * Authority nobody verified: a customer's own assertion (self-service guardianship of a child they
 * created; guardian verification policy pending §6.6) or legacy data carried in by a migration.
 * A merge never carries it across the pair (SPK-IAM-002, SPK-IAM-007).
 */
const UNVERIFIED_AUTHORITY_SOURCES: ReadonlySet<string> = new Set(['self_service', 'import']);

/**
 * Duplicate review and merge (SPK-IAM-007). Detection (PeopleService) and staff flagging only
 * produce candidates. A merge is a system-administrator command that keeps the merged person's
 * row (status 'merged', pointer to the survivor) so participation, financial ownership and source
 * identifiers held by other modules stay resolvable, re-points verified authority to the survivor,
 * and never imports unverified permissions: self-service and imported relationships and grants on
 * the merged person are ended, not transferred; self-service relationships over the survivor end
 * and the survivor's self-service creator privilege is cleared (a legitimate self-service parent
 * re-establishes access through a claim or a staff grant, and the merge summary shows staff who
 * needs one); pending invitations or claims addressed to the merged person are revoked. A child
 * record never survives an adult (kind cannot change later, and a child cannot hold an account's
 * authority or a staff role).
 */
@Injectable()
export class DuplicatesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
  ) {}

  async flag(
    principal: Principal,
    input: FlagDuplicateInput,
    correlationId: string | null,
  ): Promise<DuplicateCandidate> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.flagDuplicate, {
      type: 'duplicate_candidate',
      organizationId,
    });
    const [a, b] =
      input.personAId < input.personBId
        ? [input.personAId, input.personBId]
        : [input.personBId, input.personAId];
    return runInTransaction(this.uow, async ({ trx }) => {
      const persons = await trx
        .selectFrom('persons')
        .select(['id', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', 'in', [a, b])
        .execute();
      if (persons.length !== 2) throw errors.notFound('person');
      if (persons.some((p) => p.status !== 'active')) {
        throw errors.invalidTransition('Person', 'inactive', 'flag_duplicate');
      }
      const id = newId();
      const inserted = await trx
        .insertInto('duplicate_candidates')
        .values({
          id,
          organization_id: organizationId,
          person_a_id: a,
          person_b_id: b,
          reasons: input.reasons,
          score: input.score,
          flagged_by: json(snapshotActor(principal)),
          decision: null,
          decided_by: null,
          decided_at: null,
        })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'person_a_id', 'person_b_id']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      const candidateId = inserted?.id ?? (await this.findPair(trx, organizationId, a, b)).id;
      if (inserted) {
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: IdentityActions.flagDuplicate.id,
          targetType: 'duplicate_candidate',
          targetId: id,
          afterRevision: 1,
          reason: input.reason ?? null,
          correlationId,
          details: { personAId: a, personBId: b, reasons: input.reasons },
        });
        await this.outbox.enqueue(trx, IdentityEvents.duplicateCandidateFlagged, {
          organizationId,
          aggregateType: 'duplicate_candidate',
          aggregateId: id,
          payload: { candidateId: id, personAId: a, personBId: b, score: input.score },
          correlationId,
        });
      }
      return toDuplicateCandidate(await this.load(trx, organizationId, candidateId));
    });
  }

  async dismiss(
    principal: Principal,
    id: string,
    input: { reason: string; expectedRevision?: number },
    correlationId: string | null,
  ): Promise<DuplicateCandidate> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.dismissDuplicate, {
      type: 'duplicate_candidate',
      id,
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      // §4.9: locked against a concurrent merge or dismiss of the same candidate.
      const candidate = await this.load(trx, organizationId, id, { lock: true });
      assertExpectedRevision(input.expectedRevision, candidate.revision);
      const next = DuplicateCandidateMachine.next(candidate.status, 'dismiss');
      const now = this.clock.now();
      const dismissed = await trx
        .updateTable('duplicate_candidates')
        .set({
          status: next,
          decision: json({ outcome: 'dismissed', reason: input.reason }),
          decided_by: json(snapshotActor(principal)),
          decided_at: now,
          revision: candidate.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', candidate.revision)
        .executeTakeFirst();
      ensureUpdated(dismissed.numUpdatedRows, () =>
        errors.staleRevision(candidate.revision, candidate.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.dismissDuplicate.id,
        targetType: 'duplicate_candidate',
        targetId: id,
        beforeRevision: candidate.revision,
        afterRevision: candidate.revision + 1,
        reason: input.reason,
        correlationId,
      });
      return toDuplicateCandidate(await this.load(trx, organizationId, id));
    });
  }

  async merge(
    principal: Principal,
    candidateId: string,
    input: MergeDuplicateInput,
    correlationId: string | null,
  ): Promise<PersonMerge> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.mergePersons, {
      type: 'duplicate_candidate',
      id: candidateId,
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      // §4.9: the candidate, then both persons, are locked for the whole merge.
      const candidate = await this.load(trx, organizationId, candidateId, { lock: true });
      assertExpectedRevision(input.expectedRevision, candidate.revision);
      const next = DuplicateCandidateMachine.next(candidate.status, 'merge');
      if (![candidate.person_a_id, candidate.person_b_id].includes(input.survivorPersonId)) {
        throw errors.validation('survivorPersonId must be one of the candidate pair.');
      }
      const survivorId = input.survivorPersonId;
      const mergedId =
        survivorId === candidate.person_a_id ? candidate.person_b_id : candidate.person_a_id;
      const persons = await trx
        .selectFrom('persons')
        .select(['id', 'status', 'revision', 'kind'])
        .where('organization_id', '=', organizationId)
        .where('id', 'in', [survivorId, mergedId])
        .orderBy('id')
        .forUpdate()
        .execute();
      const survivor = persons.find((p) => p.id === survivorId);
      const merged = persons.find((p) => p.id === mergedId);
      if (!survivor || !merged) throw errors.notFound('person');
      if (survivor.status !== 'active' || merged.status !== 'active') {
        throw errors.invalidTransition('Person', 'inactive', 'merge');
      }
      // SPK-IAM-007 / SPK-IAM-001: a merge must not move what a child cannot hold (an adult's
      // account, authority over other people, staff memberships) onto a child. The direct paths
      // refuse the same thing (relationships.service, staff-memberships.service), and kind cannot
      // be changed later, so the adult record must be the survivor.
      if (survivor.kind === 'child' && merged.kind === 'adult') {
        throw errors.validation(
          "The survivor must be the adult record: a child cannot take over an adult's account, authority or staff memberships.",
          { survivorPersonId: survivorId, survivorKind: survivor.kind, mergedKind: merged.kind },
        );
      }
      const now = this.clock.now();
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'identity.merge_persons',
        requestedBy: principal,
        correlationId,
        input: { candidateId, survivorPersonId: survivorId, mergedPersonId: mergedId },
        status: 'running',
        // §4.14: the merge summary is read by those who may merge, not by every staff role.
        readScope: { action: IdentityActions.mergePersons },
      });
      const summary: MergeSummary = {
        contactPointsMoved: 0,
        accountsMoved: 0,
        accountsDisabled: 0,
        relationshipsMoved: 0,
        relationshipsConsolidated: 0,
        relationshipsEnded: 0,
        grantsMoved: 0,
        grantsRevokedAsDuplicate: 0,
        unverifiedRelationshipsSkipped: 0,
        unverifiedGrantsSkipped: 0,
        survivorUnverifiedRelationshipsEnded: 0,
        survivorCreatorPrivilegeCleared: false,
        householdMembershipsMoved: 0,
        staffMembershipsMoved: 0,
        pendingInvitationsRevoked: 0,
        pendingClaimsRevoked: 0,
        accessReviewsMoved: 0,
        otherCandidatesDismissed: 0,
      };
      const actor = json(snapshotActor(principal));
      const mergeId = newId();

      // 1. Contact points: move, demoting primaries the survivor already has.
      const survivorPrimaryKinds = new Set(
        (
          await trx
            .selectFrom('contact_points')
            .select('kind')
            .where('organization_id', '=', organizationId)
            .where('person_id', '=', survivorId)
            .where('is_primary', '=', true)
            .execute()
        ).map((c) => c.kind),
      );
      const contacts = await trx
        .selectFrom('contact_points')
        .select(['id', 'kind', 'is_primary'])
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', mergedId)
        .execute();
      for (const contact of contacts) {
        await trx
          .updateTable('contact_points')
          .set({
            person_id: survivorId,
            is_primary: contact.is_primary && !survivorPrimaryKinds.has(contact.kind),
          })
          .where('id', '=', contact.id)
          .execute();
        if (contact.is_primary && !survivorPrimaryKinds.has(contact.kind)) {
          survivorPrimaryKinds.add(contact.kind);
        }
        summary.contactPointsMoved += 1;
      }

      // 2. Accounts: at most one active account per person; the survivor's wins.
      const survivorActive = await trx
        .selectFrom('accounts')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', survivorId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      const mergedAccounts = await trx
        .selectFrom('accounts')
        .select(['id', 'revision'])
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', mergedId)
        .where('status', '=', 'active')
        .execute();
      for (const account of mergedAccounts) {
        if (survivorActive) {
          await trx
            .updateTable('accounts')
            .set({
              status: 'disabled',
              disabled_at: now,
              disabled_reason: `merged into person ${survivorId}`,
              revision: account.revision + 1,
            })
            .where('id', '=', account.id)
            .execute();
          summary.accountsDisabled += 1;
        } else {
          await trx
            .updateTable('accounts')
            .set({ person_id: survivorId, revision: account.revision + 1 })
            .where('id', '=', account.id)
            .execute();
          summary.accountsMoved += 1;
          await this.outbox.enqueue(trx, IdentityEvents.accountLinked, {
            organizationId,
            aggregateType: 'account',
            aggregateId: account.id,
            payload: { accountId: account.id, personId: survivorId, via: 'merge' },
            correlationId,
          });
        }
      }

      // 3. Live relationships and their grants.
      const liveRelationships = await trx
        .selectFrom('relationships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('status', 'in', ['active', 'suspended'])
        .where((eb) =>
          eb.or([eb('actor_person_id', '=', mergedId), eb('subject_person_id', '=', mergedId)]),
        )
        .orderBy('created_at')
        .execute();
      for (const relationship of liveRelationships) {
        const grants = await trx
          .selectFrom('access_grants')
          .selectAll()
          .where('relationship_id', '=', relationship.id)
          .where('revoked_at', 'is', null)
          .execute();
        if (UNVERIFIED_AUTHORITY_SOURCES.has(relationship.source)) {
          await this.endRelationship(
            trx,
            relationship,
            grants,
            actor,
            now,
            `merge: unverified ${relationship.source} authority is not transferred`,
          );
          summary.unverifiedRelationshipsSkipped += 1;
          summary.unverifiedGrantsSkipped += grants.length;
          continue;
        }
        const newActor =
          relationship.actor_person_id === mergedId ? survivorId : relationship.actor_person_id;
        const newSubject =
          relationship.subject_person_id === mergedId ? survivorId : relationship.subject_person_id;
        if (newActor === newSubject && relationship.kind !== 'self_managed') {
          await this.endRelationship(
            trx,
            relationship,
            grants,
            actor,
            now,
            'merge: relationship between the merged pair',
          );
          summary.relationshipsEnded += 1;
          continue;
        }
        const target = await trx
          .selectFrom('relationships')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('actor_person_id', '=', newActor)
          .where('subject_person_id', '=', newSubject)
          .where('kind', '=', relationship.kind)
          .where('status', 'in', ['active', 'suspended'])
          .where('id', '<>', relationship.id)
          .executeTakeFirst();
        for (const grant of grants) {
          if (UNVERIFIED_AUTHORITY_SOURCES.has(grant.source)) {
            await this.revokeGrant(
              trx,
              grant,
              actor,
              now,
              `merge: unverified ${grant.source} grant is not transferred`,
            );
            summary.unverifiedGrantsSkipped += 1;
            continue;
          }
          const overlap = await trx
            .selectFrom('access_grants')
            .select('id')
            .where('organization_id', '=', organizationId)
            .where('actor_person_id', '=', newActor)
            .where('subject_person_id', '=', newSubject)
            .where('permission', '=', grant.permission)
            .where('revoked_at', 'is', null)
            .where('id', '<>', grant.id)
            .where((eb) =>
              eb.or([
                eb('effective_to', 'is', null),
                eb('effective_to', '>', grant.effective_from),
              ]),
            )
            .where((eb) =>
              grant.effective_to === null
                ? eb.lit(true)
                : eb('effective_from', '<', grant.effective_to as Date),
            )
            .executeTakeFirst();
          if (overlap) {
            await this.revokeGrant(
              trx,
              grant,
              actor,
              now,
              'merge: equivalent grant already held by the survivor',
            );
            summary.grantsRevokedAsDuplicate += 1;
          } else {
            await trx
              .updateTable('access_grants')
              .set({
                relationship_id: target ? target.id : relationship.id,
                actor_person_id: newActor,
                subject_person_id: newSubject,
                revision: grant.revision + 1,
              })
              .where('id', '=', grant.id)
              .execute();
            summary.grantsMoved += 1;
          }
        }
        if (target) {
          await this.endRelationship(
            trx,
            relationship,
            [],
            actor,
            now,
            `merge: consolidated into relationship ${target.id}`,
          );
          summary.relationshipsConsolidated += 1;
        } else {
          await trx
            .updateTable('relationships')
            .set({
              actor_person_id: newActor,
              subject_person_id: newSubject,
              revision: relationship.revision + 1,
            })
            .where('id', '=', relationship.id)
            .execute();
          summary.relationshipsMoved += 1;
        }
      }

      // 3b. The survivor now carries the merged person's history and verified relationships, so
      // customer-asserted authority over the survivor would reach records nobody verified it for,
      // and so would the self-service creator privilege (relationships.service).
      const survivorSelfService = await trx
        .selectFrom('relationships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('subject_person_id', '=', survivorId)
        .where('source', '=', 'self_service')
        .where('status', 'in', ['active', 'suspended'])
        .execute();
      for (const relationship of survivorSelfService) {
        const grants = await trx
          .selectFrom('access_grants')
          .selectAll()
          .where('relationship_id', '=', relationship.id)
          .where('revoked_at', 'is', null)
          .execute();
        await this.endRelationship(
          trx,
          relationship,
          grants,
          actor,
          now,
          'merge: unverified self_service authority over the survivor ends',
        );
        summary.survivorUnverifiedRelationshipsEnded += 1;
        summary.unverifiedGrantsSkipped += grants.length;
      }
      const survivorCleared = await trx
        .updateTable('persons')
        .set({ created_by_person_id: null, revision: survivor.revision + 1 })
        .where('id', '=', survivorId)
        .where('revision', '=', survivor.revision)
        .where('created_by_person_id', 'is not', null)
        .executeTakeFirst();
      summary.survivorCreatorPrivilegeCleared = Number(survivorCleared.numUpdatedRows) > 0;

      // 4. Household memberships.
      const memberships = await trx
        .selectFrom('household_memberships')
        .select(['id', 'household_id'])
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', mergedId)
        .execute();
      for (const membership of memberships) {
        const already = await trx
          .selectFrom('household_memberships')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('household_id', '=', membership.household_id)
          .where('person_id', '=', survivorId)
          .executeTakeFirst();
        if (already) {
          await trx.deleteFrom('household_memberships').where('id', '=', membership.id).execute();
        } else {
          await trx
            .updateTable('household_memberships')
            .set({ person_id: survivorId })
            .where('id', '=', membership.id)
            .execute();
          summary.householdMembershipsMoved += 1;
        }
      }

      // 5. Staff memberships (verified by a system administrator) follow the survivor.
      const staff = await trx
        .updateTable('staff_memberships')
        .set({ person_id: survivorId })
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', mergedId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      summary.staffMembershipsMoved = Number(staff.numUpdatedRows);

      // 6. Pending invitations and claims addressed to the merged person are unverified: revoke.
      const invitations = await trx
        .updateTable('invitations')
        .set({
          status: 'revoked',
          revoked_at: now,
          revoked_by: actor,
          revocation_reason: 'merge: pending invitation not transferred',
        })
        .where('organization_id', '=', organizationId)
        .where('status', '=', 'pending')
        .where((eb) =>
          eb.or([
            eb('recipient_person_id', '=', mergedId),
            eb('scope_person_id', '=', mergedId),
            eb(
              'id',
              'in',
              eb
                .selectFrom('invitation_subjects')
                .select('invitation_subjects.invitation_id')
                .where('invitation_subjects.organization_id', '=', organizationId)
                .where('invitation_subjects.person_id', '=', mergedId),
            ),
          ]),
        )
        .executeTakeFirst();
      summary.pendingInvitationsRevoked = Number(invitations.numUpdatedRows);
      const claims = await trx
        .updateTable('claims')
        .set({
          status: 'revoked',
          revoked_at: now,
          revoked_by: actor,
          revocation_reason: 'merge: pending claim not transferred',
        })
        .where('organization_id', '=', organizationId)
        .where('status', '=', 'pending')
        .where('subject_person_id', '=', mergedId)
        .executeTakeFirst();
      summary.pendingClaimsRevoked = Number(claims.numUpdatedRows);

      // 7. Open access reviews about the merged person continue about the survivor.
      const reviews = await trx
        .updateTable('access_reviews')
        .set({ subject_person_id: survivorId })
        .where('organization_id', '=', organizationId)
        .where('subject_person_id', '=', mergedId)
        .where('status', '<>', 'closed')
        .executeTakeFirst();
      summary.accessReviewsMoved = Number(reviews.numUpdatedRows);

      // 8. Other open candidates involving the merged person are moot.
      const others = await trx
        .updateTable('duplicate_candidates')
        .set({
          status: 'dismissed',
          decision: json({ outcome: 'dismissed', reason: 'person_merged', mergeId }),
          decided_by: actor,
          decided_at: now,
        })
        .where('organization_id', '=', organizationId)
        .where('status', '=', 'open')
        .where('id', '<>', candidateId)
        .where((eb) => eb.or([eb('person_a_id', '=', mergedId), eb('person_b_id', '=', mergedId)]))
        .executeTakeFirst();
      summary.otherCandidatesDismissed = Number(others.numUpdatedRows);
      const decided = await trx
        .updateTable('duplicate_candidates')
        .set({
          status: next,
          decision: json({
            outcome: 'merged',
            survivorPersonId: survivorId,
            mergeId,
            reason: input.reason,
          }),
          decided_by: actor,
          decided_at: now,
          revision: candidate.revision + 1,
        })
        .where('id', '=', candidateId)
        .where('revision', '=', candidate.revision)
        .executeTakeFirst();
      ensureUpdated(decided.numUpdatedRows, () =>
        errors.staleRevision(candidate.revision, candidate.revision + 1),
      );

      // 9. The merged person stays, marked and pointing at the survivor (history reachable).
      const mergedRow = await trx
        .updateTable('persons')
        .set({ status: 'merged', merged_into_person_id: survivorId, revision: merged.revision + 1 })
        .where('id', '=', mergedId)
        .where('revision', '=', merged.revision)
        .executeTakeFirst();
      ensureUpdated(mergedRow.numUpdatedRows, () =>
        errors.staleRevision(merged.revision, merged.revision + 1),
      );
      await trx
        .insertInto('person_merges')
        .values({
          id: mergeId,
          organization_id: organizationId,
          survivor_person_id: survivorId,
          merged_person_id: mergedId,
          candidate_id: candidateId,
          moved: json(summary),
          actor,
          reason: input.reason,
          operation_id: operationId,
        })
        .execute();
      for (const [targetId, role] of [
        [survivorId, 'survivor'],
        [mergedId, 'merged'],
      ] as const) {
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: IdentityActions.mergePersons.id,
          targetType: 'person',
          targetId,
          reason: input.reason,
          correlationId,
          operationId,
          details: {
            role,
            mergeId,
            survivorPersonId: survivorId,
            mergedPersonId: mergedId,
            moved: summary,
          },
        });
      }
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: { mergeId, ...summary },
      });
      await this.outbox.enqueue(trx, IdentityEvents.personsMerged, {
        organizationId,
        aggregateType: 'person',
        aggregateId: survivorId,
        payload: { mergeId, survivorPersonId: survivorId, mergedPersonId: mergedId, operationId },
        correlationId,
        operationId,
      });
      const row = await trx
        .selectFrom('person_merges')
        .selectAll()
        .where('id', '=', mergeId)
        .executeTakeFirstOrThrow();
      return toPersonMerge(row);
    });
  }

  private async endRelationship(
    trx: Trx,
    relationship: Selectable<RelationshipsTable>,
    grants: Selectable<AccessGrantsTable>[],
    actor: ReturnType<typeof json>,
    now: Date,
    reason: string,
  ): Promise<void> {
    for (const grant of grants) await this.revokeGrant(trx, grant, actor, now, reason);
    await trx
      .updateTable('relationships')
      .set({
        status: 'ended',
        ended_at: now,
        ended_reason: reason,
        revision: relationship.revision + 1,
      })
      .where('id', '=', relationship.id)
      .execute();
  }

  private async revokeGrant(
    trx: Trx,
    grant: Selectable<AccessGrantsTable>,
    actor: ReturnType<typeof json>,
    now: Date,
    reason: string,
  ): Promise<void> {
    await trx
      .updateTable('access_grants')
      .set({
        revoked_at: now,
        revoked_by: actor,
        revocation_reason: reason,
        revision: grant.revision + 1,
      })
      .where('id', '=', grant.id)
      .execute();
    await this.outbox.enqueue(trx, IdentityEvents.accessGrantRevoked, {
      organizationId: grant.organization_id,
      aggregateType: 'access_grant',
      aggregateId: grant.id,
      payload: {
        grantId: grant.id,
        actorPersonId: grant.actor_person_id,
        subjectPersonId: grant.subject_person_id,
        permission: grant.permission,
        reason,
      },
    });
  }

  /**
   * GET /v1/duplicate-candidates (ID-05, SPK-IAM-007, SCR-S-23): candidates by status (default
   * open), newest first (keyset created_at desc, id desc), with both people's names and the
   * detection signals (reasons, score); never dates of birth in list rows.
   */
  async list(
    principal: Principal,
    query: ListDuplicateCandidatesQueryInput,
  ): Promise<Page<DuplicateCandidateView>> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.readDuplicates, {
      type: 'duplicate_candidate',
      organizationId,
    });
    let rows = this.db
      .selectFrom('duplicate_candidates')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', '=', query.status ?? 'open');
    const cursor = decodeCursor(query.cursor, ListCursor);
    if (cursor) {
      rows = rows.where(
        sql<SqlBool>`(created_at, id) < (${new Date(cursor.c)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const found = await rows
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = found.slice(0, query.limit);
    const persons = await this.persons(
      this.db,
      organizationId,
      page.flatMap((c) => [c.person_a_id, c.person_b_id]),
    );
    const side = (id: string) => {
      const p = persons.get(id) as PersonRow;
      return {
        personId: p.id,
        givenName: p.given_name,
        familyName: p.family_name,
        displayName: displayNameOf(p.given_name, p.family_name),
        kind: p.kind,
        status: p.status,
      };
    };
    const last = page[page.length - 1];
    return {
      items: page.map((c) => ({
        ...toDuplicateCandidate(c),
        personA: side(c.person_a_id),
        personB: side(c.person_b_id),
      })),
      nextCursor:
        found.length > query.limit && last
          ? encodeCursor({ c: iso(last.created_at), id: last.id })
          : null,
    };
  }

  /**
   * GET /v1/duplicate-candidates/{id} (ID-05): one candidate with what a reviewer compares (names,
   * dates of birth, whether an account is linked, which contact point kinds each holds).
   */
  async get(principal: Principal, id: string): Promise<DuplicateCandidateDetail> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.readDuplicates, {
      type: 'duplicate_candidate',
      id,
      organizationId,
    });
    const candidate = await this.load(this.db, organizationId, id);
    const ids = [candidate.person_a_id, candidate.person_b_id];
    const persons = await this.persons(this.db, organizationId, ids);
    const accounts = await this.db
      .selectFrom('accounts')
      .select('person_id')
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', ids)
      .where('status', '=', 'active')
      .execute();
    const contacts = await this.db
      .selectFrom('contact_points')
      .select(['person_id', 'kind'])
      .distinct()
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', ids)
      .execute();
    const side = (personId: string) => {
      const p = persons.get(personId) as PersonRow;
      return {
        personId: p.id,
        givenName: p.given_name,
        familyName: p.family_name,
        displayName: displayNameOf(p.given_name, p.family_name),
        kind: p.kind,
        status: p.status,
        dateOfBirth: p.date_of_birth,
        accountLinked: accounts.some((a) => a.person_id === personId),
        contactPointKinds: contacts
          .filter((c) => c.person_id === personId)
          .map((c) => c.kind)
          .sort(),
      };
    };
    return {
      ...toDuplicateCandidate(candidate),
      personA: side(candidate.person_a_id),
      personB: side(candidate.person_b_id),
    };
  }

  private async persons(
    db: Db | Trx,
    organizationId: string,
    ids: string[],
  ): Promise<Map<string, PersonRow>> {
    if (ids.length === 0) return new Map();
    const rows = (await db
      .selectFrom('persons')
      .select(personColumns)
      .where('persons.organization_id', '=', organizationId)
      .where('persons.id', 'in', [...new Set(ids)])
      .execute()) as PersonRow[];
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async findPair(trx: Trx, organizationId: string, a: string, b: string) {
    return trx
      .selectFrom('duplicate_candidates')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_a_id', '=', a)
      .where('person_b_id', '=', b)
      .executeTakeFirstOrThrow();
  }

  private async load(
    trx: Trx | Db,
    organizationId: string,
    id: string,
    options: { lock?: boolean } = {},
  ) {
    let query = trx
      .selectFrom('duplicate_candidates')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (options.lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw errors.notFound('duplicate_candidate', id);
    return row;
  }
}
