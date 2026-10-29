import {
  CommunicationPreferenceImportPayloadSchema,
  CreditImportPayloadSchema,
  FutureScheduleImportPayloadSchema,
  HouseholdImportPayloadSchema,
  IMPORT_PAYLOAD_SCHEMAS,
  OpenObligationImportPayloadSchema,
  PersonImportPayloadSchema,
  ProgramImportPayloadSchema,
  RefundImportPayloadSchema,
  RelationshipEvidenceImportPayloadSchema,
  RosterImportPayloadSchema,
  SeasonImportPayloadSchema,
  TeamImportPayloadSchema,
  z,
  type AuthorityResolution,
  type GrantPermissionValue,
  type ImportEntityTypeValue,
  type ImportExceptionKindValue,
  type ImportExceptionResolution,
  type ImportReason,
  type ImportRowOutcomeValue,
} from '@sportspark/contracts';
import { ADULT_AGE_YEARS, ageInYears } from '../../identity';
import type { MigrationPolicy } from '../migration.policy';
import { reason, type ExceptionRow, type MappingRow, type RowRow } from '../migration.shared';
import { CATEGORY_RULES } from '../staging/categories';
import type { PersonValues, ProgramValues } from './import-targets';

export type PersonPayload = z.infer<typeof PersonImportPayloadSchema>;
export type HouseholdPayload = z.infer<typeof HouseholdImportPayloadSchema>;
export type RelationshipPayload = z.infer<typeof RelationshipEvidenceImportPayloadSchema>;
export type ProgramPayload = z.infer<typeof ProgramImportPayloadSchema>;
export type ObligationPayload = z.infer<typeof OpenObligationImportPayloadSchema>;
export type CreditPayload = z.infer<typeof CreditImportPayloadSchema>;
export type SeasonPayload = z.infer<typeof SeasonImportPayloadSchema>;
export type TeamPayload = z.infer<typeof TeamImportPayloadSchema>;
export type RosterPayload = z.infer<typeof RosterImportPayloadSchema>;
export type SchedulePayload = z.infer<typeof FutureScheduleImportPayloadSchema>;
export type PreferencePayload = z.infer<typeof CommunicationPreferenceImportPayloadSchema>;

/** What a staged season or team row stands for: a season, a team or a team's season entry. */
export type RecordKind = 'season' | 'team' | 'entry';

/**
 * A reference to a season, team or team entry (MIG-02), staged in this batch or mapped by an
 * earlier one, keyed by `${entityType}:${externalId}`.
 */
export interface RecordRef {
  internalId: string | null;
  kind: RecordKind;
  resolvable: boolean;
}

/** The record kind a staged `team` row stands for (`record: 'entry'`, or a team by default). */
export function teamRecordKind(payload: unknown): 'team' | 'entry' {
  return (payload as { record?: unknown } | null)?.record === 'entry' ? 'entry' : 'team';
}

/** A person reference as the batch sees it: staged in this batch or mapped by an earlier one. */
export interface PersonRef {
  /** Known once created or mapped; null for a person this batch will create (dry run). */
  internalId: string | null;
  kind: 'adult' | 'child' | null;
  status: 'active' | 'inactive' | 'merged' | null;
  /** Whether the reference will exist after this batch (its row is not skipped or an exception). */
  resolvable: boolean;
}

/** What the planner needs to know; built by the batch services (reads happen outside any transaction). */
export interface PlanningContext {
  now: Date;
  policy: MigrationPolicy;
  /** Rows of the batch by `${entityType}:${externalId}`. */
  rows: Map<string, RowRow>;
  /** Mappings of the batch's source by `${entityType}:${externalId}`. */
  mappings: Map<string, MappingRow>;
  /** Organization-wide authority of each category in the batch, at the clock. */
  authority: Map<ImportEntityTypeValue, AuthorityResolution>;
  /** Record-specific authority by row id (e.g. a program-scoped assignment), when one applies. */
  rowAuthority?: Map<string, AuthorityResolution>;
  /** Decided exceptions by row id. */
  decisions: Map<string, ExceptionRow[]>;
  /** Person references by external id. */
  persons: Map<string, PersonRef>;
  /** Existing SportsPark program names (lower case) → program id. */
  programNames: Map<string, string>;
  /** Season, team and team-entry references by `${entityType}:${externalId}` (MIG-02). */
  records: Map<string, RecordRef>;
}

export type PlannedAction =
  | { type: 'create'; values: CreateValues }
  | { type: 'update'; values: CreateValues }
  | { type: 'match' }
  | { type: 'none' };

export type CreateValues =
  | { entityType: 'person'; person: PersonValues }
  | { entityType: 'household'; name: string; memberExternalIds: string[] }
  | {
      entityType: 'relationship_evidence';
      actorExternalId: string;
      subjectExternalId: string;
      kind: 'guardian' | 'delegate' | 'caregiver';
      permissions: GrantPermissionValue[];
      effectiveFrom?: string;
      effectiveTo?: string;
    }
  | { entityType: 'program'; program: ProgramValues }
  | {
      entityType: 'open_obligation';
      debtorExternalId: string;
      amountMinor: number;
      currency: string;
      dueAt: string;
      description: string;
    }
  | {
      entityType: 'credit';
      ownerExternalId: string;
      amountMinor: number;
      currency: string;
      expiresAt?: string;
      permittedUses: ('registration' | 'obligation')[];
    }
  // MIG-02: created through the owning modules' import commands (IF-40).
  | {
      entityType: 'season';
      season: {
        competitionId: string;
        ruleSetId: string;
        name: string;
        startsOn: string;
        endsOn: string;
        status: SeasonPayload['status'];
        registrationOpensAt: string | null;
        registrationClosesAt: string | null;
      };
    }
  | {
      entityType: 'team';
      record: 'team';
      team: {
        name: string;
        colors: { primary?: string; secondary?: string };
        status: 'active' | 'inactive' | 'archived';
      };
    }
  | {
      entityType: 'team';
      record: 'entry';
      entry: {
        teamExternalId: string;
        seasonExternalId: string;
        divisionId: string | null;
        status: 'applied' | 'approved';
        appliedAt: string;
        approvedAt: string | null;
        captainExternalId: string | null;
      };
    }
  | {
      entityType: 'roster';
      roster: {
        entryExternalId: string;
        personExternalId: string;
        status: RosterPayload['status'];
        effectiveFrom: string;
        effectiveTo: string | null;
        jerseyNumber: number | null;
      };
    }
  | {
      entityType: 'future_schedule';
      event: {
        facilityId: string;
        resourceIds: string[];
        kind: SchedulePayload['kind'];
        title: string;
        format: string | null;
        scheduledStart: string;
        scheduledEnd: string;
        setupMinutes?: number;
        cleanupMinutes?: number;
      };
    }
  | {
      entityType: 'communication_preference';
      personExternalId: string;
      preferences: PreferencePayload['preferences'];
    };

/** Entity types whose records are created only through an owning module's import command. */
export const IMPORT_COMMAND_TYPES: ReadonlySet<ImportEntityTypeValue> = new Set([
  'person',
  'program',
  'season',
  'team',
  'roster',
  'future_schedule',
  'communication_preference',
]);
/** Of those, the ones whose import command creates only: a changed source row is a conflict. */
const CREATE_ONLY_TYPES: ReadonlySet<ImportEntityTypeValue> = new Set([
  'season',
  'team',
  'roster',
  'future_schedule',
  'communication_preference',
]);

export interface RowPlan {
  outcome: ImportRowOutcomeValue;
  reasons: ImportReason[];
  action: PlannedAction;
  /** A new review item for this row (none when the row's earlier exception was deferred). */
  exception?: { kind: ImportExceptionKindValue; reasons: ImportReason[] };
}

const key = (entityType: string, externalId: string) => `${entityType}:${externalId}`;
export { key as rowKey };

function exception(kind: ImportExceptionKindValue, reasons: ImportReason[]): RowPlan {
  return { outcome: 'exception', reasons, action: { type: 'none' }, exception: { kind, reasons } };
}

function skipped(reasons: ImportReason[]): RowPlan {
  return { outcome: 'skipped', reasons, action: { type: 'none' } };
}

function issuesOf(error: z.ZodError): ImportReason[] {
  return error.issues.map((issue) =>
    reason('invalid_payload', `${issue.path.join('.') || 'payload'}: ${issue.message}`, {
      path: issue.path.join('.'),
    }),
  );
}

const IN_FLIGHT_REFUND = new Set(['pending', 'processing', 'unknown']);

/**
 * Decides each staged row's outcome (§5.4) without side effects. Validation stores the plan as
 * the planned outcome and opens review exceptions; the apply re-plans every row against the state
 * at that moment and executes it, so a dry run and an apply follow exactly the same rules:
 *
 *   - a decided `reject` skips the row; a `defer` leaves it an exception; an `accept` lets the
 *     ambiguity through with the reviewer's resolution (narrowed permissions, approved amount);
 *   - payload validation failures are `validation` exceptions (reject or defer only);
 *   - history categories are skipped (retained as staged history); in-flight refunds are
 *     ambiguous balances for finance;
 *   - a row already mapped is `matched` when its payload is unchanged (SPK-AT-024), otherwise
 *     `updated` through the owning module — unless SportsPark is now authoritative for the
 *     category, in which case the legacy change is a `conflict` (a synchronized copy never
 *     overwrites the authoritative system, §5.6);
 *   - a new row in a category SportsPark is authoritative for is a `conflict`;
 *   - ambiguous relationships (undocumented basis, pickup permission, guardianship of an adult,
 *     conflicting evidence for the same pair) and ambiguous balances (negative, disputed,
 *     components that disagree, expired credits, changed opening balances) enter review queues.
 */
export class ImportPlanner {
  constructor(private readonly ctx: PlanningContext) {}

  plan(row: RowRow): RowPlan {
    const ctx = this.ctx;
    const rule = CATEGORY_RULES[row.entity_type];
    const decided = ctx.decisions.get(row.id) ?? [];
    if (decided.some((d) => d.decision === 'reject')) {
      return skipped([reason('review_rejected', 'Rejected in review; not imported.')]);
    }
    if (decided.some((d) => d.decision === 'defer')) {
      return {
        outcome: 'exception',
        reasons: [reason('review_deferred', 'Deferred in review; left for a later batch.')],
        action: { type: 'none' },
      };
    }
    const accepted = decided.filter((d) => d.decision === 'accept');
    const acceptedKinds = new Set(accepted.map((d) => d.kind));
    const resolution: ImportExceptionResolution = Object.assign(
      {},
      ...accepted.map((d) => (d.resolution ?? {}) as ImportExceptionResolution),
    );

    const parsed = IMPORT_PAYLOAD_SCHEMAS[row.entity_type].safeParse(row.payload);
    if (!parsed.success) return exception('validation', issuesOf(parsed.error));

    if (rule.class === 'history') {
      if (row.entity_type === 'refund') {
        const refund = RefundImportPayloadSchema.parse(row.payload);
        if (IN_FLIGHT_REFUND.has(refund.status)) {
          if (!acceptedKinds.has('ambiguous_balance')) {
            return exception('ambiguous_balance', [
              reason(
                'refund_in_flight',
                'The refund was still in flight at the snapshot; finance resolves it in the authoritative system (imports never execute refunds).',
                { status: refund.status },
              ),
            ]);
          }
          return skipped([
            reason(
              'refund_in_flight_acknowledged',
              'Finance acknowledged the in-flight refund; it is never executed by the import.',
            ),
          ]);
        }
      }
      return skipped([reason(rule.skip?.code ?? 'retained_as_history', rule.skip?.message ?? '')]);
    }
    if (rule.class === 'not_supported') {
      return skipped([reason(rule.skip?.code ?? 'no_import_command', rule.skip?.message ?? '')]);
    }

    const mapping = ctx.mappings.get(key(row.entity_type, row.external_id));
    // A record-specific resolution (a program-scoped assignment for a mapped program) wins over
    // the organization-wide one.
    const authority = ctx.rowAuthority?.get(row.id) ?? ctx.authority.get(row.entity_type);
    if (authority?.basis === 'conflict') {
      return exception('conflict', [
        reason(
          'authority_ambiguous',
          'The authority matrix names both systems for this scope; nothing is imported until it is corrected (§4.7 invariant 11).',
        ),
      ]);
    }
    const sportsparkAuthoritative = authority?.authoritativeSystem !== 'legacy';

    if (mapping?.status === 'linked') {
      if (mapping.applied_payload_hash === row.payload_hash) {
        return {
          outcome: 'matched',
          reasons: [reason('unchanged', 'Already imported with the same content.')],
          action: { type: 'match' },
        };
      }
      if (sportsparkAuthoritative) {
        return exception('conflict', [
          reason(
            'sportspark_authoritative_changed',
            'SportsPark is authoritative for this category; the legacy change is not applied (§5.6).',
            { assignmentId: authority?.assignmentId ?? null },
          ),
        ]);
      }
      return this.planChange(row, parsed.data, acceptedKinds, resolution);
    }
    if (sportsparkAuthoritative) {
      return exception('conflict', [
        reason(
          'sportspark_authoritative',
          'SportsPark is authoritative for this category (no legacy authority assignment in effect); importing would create a second writer (§5.6).',
          { assignmentId: authority?.assignmentId ?? null, basis: authority?.basis ?? 'default' },
        ),
      ]);
    }
    return this.planCreate(row, parsed.data, acceptedKinds, resolution);
  }

  // -------------------------------------------------------------------------------------------

  private planCreate(
    row: RowRow,
    data: unknown,
    acceptedKinds: Set<ImportExceptionKindValue>,
    resolution: ImportExceptionResolution,
  ): RowPlan {
    switch (row.entity_type) {
      case 'person':
        return this.planPerson(data as PersonPayload, 'create');
      case 'household':
        return this.planHousehold(data as HouseholdPayload, 'create');
      case 'relationship_evidence':
        return this.planRelationship(row, data as RelationshipPayload, acceptedKinds, resolution);
      case 'program':
        return this.planProgram(row, data as ProgramPayload, 'create');
      case 'open_obligation':
        return this.planObligation(data as ObligationPayload, acceptedKinds, resolution);
      case 'credit':
        return this.planCredit(data as CreditPayload, acceptedKinds, resolution);
      case 'season':
        return this.planSeason(data as SeasonPayload);
      case 'team':
        return this.planTeam(data as TeamPayload);
      case 'roster':
        return this.planRoster(data as RosterPayload);
      case 'future_schedule':
        return this.planSchedule(data as SchedulePayload);
      case 'communication_preference':
        return this.planPreferences(data as PreferencePayload);
      default:
        return skipped([reason('no_import_command', 'Not applied by this module.')]);
    }
  }

  private planChange(
    row: RowRow,
    data: unknown,
    acceptedKinds: Set<ImportExceptionKindValue>,
    resolution: ImportExceptionResolution,
  ): RowPlan {
    if (CREATE_ONLY_TYPES.has(row.entity_type)) {
      // The owning module's import command creates only (IMPORT_CONTENT_MISMATCH on different
      // content): a change the legacy system made after the import is reviewed, never forced.
      return exception('conflict', [
        reason(
          'imported_record_changed',
          'The source changed a record already imported; import commands only create, so the change is made in SportsPark after review or the row is rejected.',
        ),
      ]);
    }
    switch (row.entity_type) {
      case 'person':
        return this.planPerson(data as PersonPayload, 'update');
      case 'household':
        return this.planHousehold(data as HouseholdPayload, 'update');
      case 'program':
        return this.planProgram(row, data as ProgramPayload, 'update');
      case 'relationship_evidence': {
        if (!acceptedKinds.has('ambiguous_relationship')) {
          return exception('ambiguous_relationship', [
            reason(
              'evidence_changed',
              'The relationship evidence changed since it was imported; authority changes need review (revocations go through identity).',
            ),
          ]);
        }
        const plan = this.planRelationship(
          row,
          data as RelationshipPayload,
          acceptedKinds,
          resolution,
        );
        if (plan.action.type !== 'create') return plan;
        return {
          outcome: 'updated',
          reasons: [
            reason(
              'evidence_changed_accepted',
              'Accepted in review; missing grants are added, none revoked.',
            ),
          ],
          action: { type: 'update', values: plan.action.values },
        };
      }
      case 'open_obligation':
      case 'credit': {
        if (!acceptedKinds.has('ambiguous_balance')) {
          return exception('ambiguous_balance', [
            reason(
              'opening_balance_changed',
              'The opening balance changed since it was imported; finance corrects it with an adjustment, never by rewriting it.',
            ),
          ]);
        }
        return {
          outcome: 'matched',
          reasons: [
            reason(
              'balance_change_acknowledged',
              'Finance acknowledged the changed source balance; the imported balance is kept.',
            ),
          ],
          action: { type: 'match' },
        };
      }
      default:
        return skipped([reason('no_import_command', 'Not applied by this module.')]);
    }
  }

  private planPerson(data: PersonPayload, mode: 'create' | 'update'): RowPlan {
    let kind = data.kind;
    if (data.dateOfBirth) {
      const age = ageInYears(data.dateOfBirth, this.ctx.now);
      if (age < 0) {
        return exception('validation', [
          reason('date_of_birth_in_future', 'dateOfBirth is in the future.'),
        ]);
      }
      const derived = age < ADULT_AGE_YEARS ? 'child' : 'adult';
      if (kind && kind !== derived) {
        return exception('validation', [
          reason(
            'kind_contradicts_date_of_birth',
            `kind must be '${derived}' for this date of birth (eligibility is evaluated from dates, §4.5).`,
          ),
        ]);
      }
      kind = derived;
    }
    if (!kind) {
      return exception('validation', [
        reason('kind_or_date_of_birth_required', 'A person needs a kind or a date of birth.'),
      ]);
    }
    const person: PersonValues = {
      kind,
      givenName: data.givenName,
      familyName: data.familyName,
      dateOfBirth: data.dateOfBirth,
      email: data.email,
      phone: data.phone,
      status: data.status,
    };
    return mode === 'create'
      ? {
          outcome: 'created',
          reasons: [],
          action: { type: 'create', values: { entityType: 'person', person } },
        }
      : {
          outcome: 'updated',
          reasons: [
            reason(
              'source_changed',
              'The source record changed; the person is brought up to date.',
            ),
          ],
          action: { type: 'update', values: { entityType: 'person', person } },
        };
  }

  private requirePerson(externalId: string, role: string): ImportReason | null {
    const ref = this.ctx.persons.get(externalId);
    if (!ref) {
      return reason(
        'reference_not_found',
        `${role} ${externalId} is neither staged nor imported.`,
        {
          externalId,
        },
      );
    }
    if (!ref.resolvable) {
      return reason(
        'dependency_unresolved',
        `${role} ${externalId} is not imported (its own row is skipped or awaits review).`,
        { externalId },
      );
    }
    if (ref.status && ref.status !== 'active') {
      return reason('reference_inactive', `${role} ${externalId} is not an active person.`, {
        externalId,
        status: ref.status,
      });
    }
    return null;
  }

  private requireRecord(
    entityType: 'season' | 'team',
    externalId: string,
    kind: RecordKind,
    role: string,
  ): ImportReason | null {
    const ref = this.ctx.records.get(key(entityType, externalId));
    if (!ref) {
      return reason(
        'reference_not_found',
        `${role} ${externalId} is neither staged nor imported.`,
        { externalId },
      );
    }
    if (ref.kind !== kind) {
      return reason('reference_wrong_kind', `${role} ${externalId} is not a ${kind}.`, {
        externalId,
        kind: ref.kind,
      });
    }
    if (!ref.resolvable) {
      return reason(
        'dependency_unresolved',
        `${role} ${externalId} is not imported (its own row is skipped or awaits review).`,
        { externalId },
      );
    }
    return null;
  }

  private created(values: CreateValues): RowPlan {
    return { outcome: 'created', reasons: [], action: { type: 'create', values } };
  }

  private planSeason(data: SeasonPayload): RowPlan {
    if (data.startsOn > data.endsOn) {
      return exception('validation', [
        reason('invalid_period', 'startsOn must not be after endsOn.'),
      ]);
    }
    return this.created({
      entityType: 'season',
      season: {
        competitionId: data.competitionId,
        ruleSetId: data.ruleSetId,
        name: data.name,
        startsOn: data.startsOn,
        endsOn: data.endsOn,
        status: data.status,
        registrationOpensAt: data.registrationOpensAt ?? null,
        registrationClosesAt: data.registrationClosesAt ?? null,
      },
    });
  }

  private planTeam(data: TeamPayload): RowPlan {
    if (data.record === 'team') {
      const colors: { primary?: string; secondary?: string } = {};
      if (data.primaryColor) colors.primary = data.primaryColor;
      if (data.secondaryColor) colors.secondary = data.secondaryColor;
      return this.created({
        entityType: 'team',
        record: 'team',
        team: { name: data.name, colors, status: data.status ?? 'active' },
      });
    }
    const problems = [
      this.requireRecord('team', data.teamExternalId, 'team', 'Team'),
      this.requireRecord('season', data.seasonExternalId, 'season', 'Season'),
      data.captainExternalId ? this.requirePerson(data.captainExternalId, 'Captain') : null,
    ].filter((p): p is ImportReason => p !== null);
    if ((data.status === 'approved') !== (data.approvedAt !== undefined)) {
      problems.push(
        reason(
          'approval_date',
          'An approved entry states its approval date (approvedAt), and only an approved one.',
        ),
      );
    }
    if (problems.length > 0) return exception('validation', problems);
    return this.created({
      entityType: 'team',
      record: 'entry',
      entry: {
        teamExternalId: data.teamExternalId,
        seasonExternalId: data.seasonExternalId,
        divisionId: data.divisionId ?? null,
        status: data.status,
        appliedAt: data.appliedAt,
        approvedAt: data.approvedAt ?? null,
        captainExternalId: data.captainExternalId ?? null,
      },
    });
  }

  private planRoster(data: RosterPayload): RowPlan {
    const problems = [
      this.requireRecord('team', data.entryExternalId, 'entry', 'Team entry'),
      this.requirePerson(data.personExternalId, 'Player'),
    ].filter((p): p is ImportReason => p !== null);
    if (data.effectiveTo && new Date(data.effectiveTo) < new Date(data.effectiveFrom)) {
      problems.push(reason('invalid_period', 'effectiveTo must not be before effectiveFrom.'));
    }
    if (problems.length > 0) return exception('validation', problems);
    return this.created({
      entityType: 'roster',
      roster: {
        entryExternalId: data.entryExternalId,
        personExternalId: data.personExternalId,
        status: data.status,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
        jerseyNumber: data.jerseyNumber ?? null,
      },
    });
  }

  private planSchedule(data: SchedulePayload): RowPlan {
    if (new Date(data.scheduledStart) >= new Date(data.scheduledEnd)) {
      return exception('validation', [
        reason('invalid_period', 'scheduledStart must be before scheduledEnd.'),
      ]);
    }
    if (new Date(data.scheduledEnd) <= this.ctx.now) {
      // §5.3 "future schedules": a past event is attendance or result history, not a schedule.
      return skipped([
        reason(
          'not_a_future_event',
          'The event ended before the import; it is retained as staged history, not scheduled.',
        ),
      ]);
    }
    return this.created({
      entityType: 'future_schedule',
      event: {
        facilityId: data.facilityId,
        resourceIds: [...new Set(data.resourceIds)],
        kind: data.kind,
        title: data.title,
        format: data.format ?? null,
        scheduledStart: data.scheduledStart,
        scheduledEnd: data.scheduledEnd,
        ...(data.setupMinutes !== undefined ? { setupMinutes: data.setupMinutes } : {}),
        ...(data.cleanupMinutes !== undefined ? { cleanupMinutes: data.cleanupMinutes } : {}),
      },
    });
  }

  private planPreferences(data: PreferencePayload): RowPlan {
    const problem = this.requirePerson(data.personExternalId, 'Person');
    if (problem) return exception('validation', [problem]);
    const seen = new Set<string>();
    for (const pref of data.preferences) {
      const k = `${pref.category}.${pref.channel}`;
      if (seen.has(k)) {
        return exception('validation', [
          reason('duplicate_preference', `The preference ${k} is stated twice.`),
        ]);
      }
      seen.add(k);
    }
    return this.created({
      entityType: 'communication_preference',
      personExternalId: data.personExternalId,
      preferences: data.preferences,
    });
  }

  private planHousehold(data: HouseholdPayload, mode: 'create' | 'update'): RowPlan {
    const problems = data.memberExternalIds
      .map((id) => this.requirePerson(id, 'Member'))
      .filter((p): p is ImportReason => p !== null);
    if (problems.length > 0) return exception('validation', problems);
    const values: CreateValues = {
      entityType: 'household',
      name: data.name,
      memberExternalIds: [...new Set(data.memberExternalIds)],
    };
    return mode === 'create'
      ? { outcome: 'created', reasons: [], action: { type: 'create', values } }
      : {
          outcome: 'updated',
          reasons: [
            reason('source_changed', 'Members the source added are added; none are removed.'),
          ],
          action: { type: 'update', values },
        };
  }

  private planRelationship(
    row: RowRow,
    data: RelationshipPayload,
    acceptedKinds: Set<ImportExceptionKindValue>,
    resolution: ImportExceptionResolution,
  ): RowPlan {
    const ctx = this.ctx;
    const problems = [
      this.requirePerson(data.actorExternalId, 'Actor'),
      this.requirePerson(data.subjectExternalId, 'Subject'),
    ].filter((p): p is ImportReason => p !== null);
    if (data.actorExternalId === data.subjectExternalId) {
      problems.push(
        reason('self_relationship', 'A person cannot hold this relationship over themselves.'),
      );
    }
    const actor = ctx.persons.get(data.actorExternalId);
    const subject = ctx.persons.get(data.subjectExternalId);
    if (actor?.kind === 'child') {
      problems.push(reason('actor_is_child', 'A child cannot hold authority over another person.'));
    }
    if (data.effectiveFrom && data.effectiveTo && data.effectiveTo <= data.effectiveFrom) {
      problems.push(reason('invalid_period', 'effectiveTo must be after effectiveFrom.'));
    }
    if (problems.length > 0) return exception('validation', problems);

    if (!acceptedKinds.has('ambiguous_relationship')) {
      const ambiguity: ImportReason[] = [];
      if (!ctx.policy.relationshipBasesWithoutReview.includes(data.basis)) {
        ambiguity.push(
          reason(
            'basis_requires_review',
            `Evidence basis "${data.basis}" is not authority: households, addresses and shared contacts never grant permissions (§4.5).`,
          ),
        );
      }
      const sensitive = data.permissions.filter((p) =>
        ctx.policy.permissionsRequiringReview.includes(p),
      );
      if (sensitive.length > 0) {
        ambiguity.push(
          reason(
            'permission_requires_review',
            `Permissions ${sensitive.join(', ')} are never imported without review.`,
            {
              permissions: sensitive,
            },
          ),
        );
      }
      if (data.kind === 'guardian' && subject?.kind === 'adult') {
        ambiguity.push(reason('guardian_of_adult', 'Guardianship over an adult needs review.'));
      }
      const conflicting = this.conflictingEvidence(row, data);
      if (conflicting.length > 0) {
        ambiguity.push(
          reason(
            'conflicting_evidence',
            'The source holds conflicting evidence for the same two people.',
            {
              externalIds: conflicting,
            },
          ),
        );
      }
      if (ambiguity.length > 0) return exception('ambiguous_relationship', ambiguity);
    }
    const permissions = resolution.permissions
      ? data.permissions.filter((p) => resolution.permissions?.includes(p))
      : data.permissions;
    if (permissions.length === 0) {
      return exception('validation', [
        reason('no_permissions', 'The approved permissions do not include any staged permission.'),
      ]);
    }
    return {
      outcome: 'created',
      reasons: acceptedKinds.has('ambiguous_relationship')
        ? [reason('accepted_in_review', 'Accepted in review.', { permissions })]
        : [],
      action: {
        type: 'create',
        values: {
          entityType: 'relationship_evidence',
          actorExternalId: data.actorExternalId,
          subjectExternalId: data.subjectExternalId,
          kind: data.kind,
          permissions: [...permissions],
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo,
        },
      },
    };
  }

  private conflictingEvidence(row: RowRow, data: RelationshipPayload): string[] {
    const out: string[] = [];
    const mine = [...data.permissions].sort().join(',');
    for (const other of this.ctx.rows.values()) {
      if (other.id === row.id || other.entity_type !== 'relationship_evidence') continue;
      const parsed = RelationshipEvidenceImportPayloadSchema.safeParse(other.payload);
      if (!parsed.success) continue;
      const o = parsed.data;
      if (
        o.actorExternalId !== data.actorExternalId ||
        o.subjectExternalId !== data.subjectExternalId
      ) {
        continue;
      }
      if (o.kind !== data.kind || [...o.permissions].sort().join(',') !== mine) {
        out.push(other.external_id);
      }
    }
    return out;
  }

  private planProgram(row: RowRow, data: ProgramPayload, mode: 'create' | 'update'): RowPlan {
    const values: ProgramValues = {
      name: data.name,
      description: data.description,
      activityType: data.activityType,
      format: data.format,
      status: data.status,
    };
    if (mode === 'update') {
      return {
        outcome: 'updated',
        reasons: [
          reason('source_changed', 'The source program changed; it is brought up to date.'),
        ],
        action: { type: 'update', values: { entityType: 'program', program: values } },
      };
    }
    const name = data.name.trim().toLowerCase();
    // A reserved (pending) mapping means an interrupted apply reserved this program's id; the
    // resumed apply creates exactly that record, and catalog refuses a genuine duplicate name.
    const pending = this.ctx.mappings.get(key('program', row.external_id))?.status === 'pending';
    if (!pending && this.ctx.programNames.has(name)) {
      return exception('conflict', [
        reason(
          'program_name_exists',
          'A SportsPark program already has this name; names are not keys, so rename it in the source or reject this row.',
          { programId: this.ctx.programNames.get(name) },
        ),
      ]);
    }
    for (const other of this.ctx.rows.values()) {
      if (other.id === row.id || other.entity_type !== 'program') continue;
      const otherName = (other.payload as { name?: unknown }).name;
      if (typeof otherName === 'string' && otherName.trim().toLowerCase() === name) {
        return exception('conflict', [
          reason('duplicate_program_name_in_batch', 'Two staged programs share this name.', {
            externalId: other.external_id,
          }),
        ]);
      }
    }
    return {
      outcome: 'created',
      reasons: [],
      action: { type: 'create', values: { entityType: 'program', program: values } },
    };
  }

  private planObligation(
    data: ObligationPayload,
    acceptedKinds: Set<ImportExceptionKindValue>,
    resolution: ImportExceptionResolution,
  ): RowPlan {
    const problem = this.requirePerson(data.debtorExternalId, 'Debtor');
    if (problem) return exception('validation', [problem]);
    const accepted = acceptedKinds.has('ambiguous_balance');
    if (!accepted) {
      if (data.amountMinor === 0) {
        return skipped([
          reason('nothing_owed', 'The remaining balance is zero; no obligation is opened.'),
        ]);
      }
      const ambiguity: ImportReason[] = [];
      if (data.amountMinor < 0) {
        ambiguity.push(
          reason(
            'negative_balance',
            'A negative balance is money owed to the customer; finance decides.',
          ),
        );
      }
      if (
        data.originalAmountMinor !== undefined &&
        data.paidMinor !== undefined &&
        data.originalAmountMinor - data.paidMinor !== data.amountMinor
      ) {
        ambiguity.push(
          reason(
            'balance_components_disagree',
            'original - paid does not equal the remaining amount.',
            {
              originalAmountMinor: data.originalAmountMinor,
              paidMinor: data.paidMinor,
              amountMinor: data.amountMinor,
            },
          ),
        );
      }
      if (data.disputed)
        ambiguity.push(reason('disputed_balance', 'The balance is disputed in the source.'));
      if (ambiguity.length > 0) return exception('ambiguous_balance', ambiguity);
    }
    const amountMinor = resolution.amountMinor ?? data.amountMinor;
    if (amountMinor <= 0) {
      return exception('validation', [
        reason('invalid_amount', 'An opening obligation needs a positive amount.'),
      ]);
    }
    return {
      outcome: 'created',
      reasons: accepted
        ? [reason('accepted_in_review', 'Opening balance approved by finance.', { amountMinor })]
        : [],
      action: {
        type: 'create',
        values: {
          entityType: 'open_obligation',
          debtorExternalId: data.debtorExternalId,
          amountMinor,
          currency: data.currency,
          dueAt: data.dueAt,
          description: data.description,
        },
      },
    };
  }

  private planCredit(
    data: CreditPayload,
    acceptedKinds: Set<ImportExceptionKindValue>,
    resolution: ImportExceptionResolution,
  ): RowPlan {
    const problem = this.requirePerson(data.ownerExternalId, 'Owner');
    if (problem) return exception('validation', [problem]);
    const accepted = acceptedKinds.has('ambiguous_balance');
    const expired = data.expiresAt !== undefined && new Date(data.expiresAt) <= this.ctx.now;
    if (!accepted) {
      if (data.amountMinor === 0) {
        return skipped([reason('no_balance', 'The credit has no remaining balance.')]);
      }
      const ambiguity: ImportReason[] = [];
      if (data.amountMinor < 0) {
        ambiguity.push(
          reason(
            'negative_balance',
            'A negative credit is money the customer owes; finance decides.',
          ),
        );
      }
      if (expired)
        ambiguity.push(reason('credit_expired', 'The credit expired before the import.'));
      if (ambiguity.length > 0) return exception('ambiguous_balance', ambiguity);
    }
    const amountMinor = resolution.amountMinor ?? data.amountMinor;
    if (amountMinor <= 0) {
      return exception('validation', [
        reason('invalid_amount', 'An opening credit needs a positive amount.'),
      ]);
    }
    return {
      outcome: 'created',
      reasons: accepted
        ? [
            reason(
              'accepted_in_review',
              expired
                ? 'Approved by finance; the expired date is waived.'
                : 'Opening credit approved by finance.',
              { amountMinor },
            ),
          ]
        : [],
      action: {
        type: 'create',
        values: {
          entityType: 'credit',
          ownerExternalId: data.ownerExternalId,
          amountMinor,
          currency: data.currency,
          expiresAt: expired ? undefined : data.expiresAt,
          permittedUses: [...(data.permittedUses ?? this.ctx.policy.defaultCreditUses)],
        },
      },
    };
  }
}
