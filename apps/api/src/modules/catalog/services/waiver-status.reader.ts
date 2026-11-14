import { Inject, Injectable } from '@nestjs/common';
import type {
  WaiverAcceptance,
  WaiverActivityRef,
  WaiverOverride,
  WaiverStatus,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import { CapabilityService, DATABASE, executorFor, type Trx } from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import type { WaiverFinding, WaiverFindingsRequest } from '../catalog.ports';
import { iso, isoOrNull } from '../catalog.shared';
import {
  acceptedInstant,
  judgeWaiver,
  parseWaiverContent,
  type WaiverVersionInForce,
} from '../waivers/waiver-rule';

interface AcceptanceRow {
  id: string;
  subject_person_id: string;
  policy_version_id: string;
  version: number;
  key: string;
  signed_by_person_id: string;
  basis: 'self' | 'guardian';
  method: 'digital' | 'paper';
  signed_at: Date | string;
  paper_dated_on: string | null;
  recorded_by_kind: 'customer' | 'staff' | 'system';
  recorded_by_person_id: string | null;
  status: 'active' | 'withdrawn';
  withdrawn_at: Date | string | null;
  withdrawn_reason: string | null;
}

export function toWaiverAcceptance(row: AcceptanceRow): WaiverAcceptance {
  const signedAt = iso(row.signed_at);
  return {
    acknowledgmentId: row.id,
    policyVersionId: row.policy_version_id,
    version: row.version,
    subjectPersonId: row.subject_person_id,
    signedByPersonId: row.signed_by_person_id,
    basis: row.basis,
    method: row.method,
    signedAt,
    paperDatedOn: row.paper_dated_on,
    recordedByKind: row.recorded_by_kind,
    // The staff member is named whenever staff made the entry (always so for paper, SPK-REG-009).
    recordedByPersonId: row.recorded_by_kind === 'staff' ? row.recorded_by_person_id : null,
    acceptedAt: acceptedInstant({
      method: row.method,
      signedAt,
      paperDatedOn: row.paper_dated_on,
    }).toISOString(),
    status: row.status,
    withdrawnAt: isoOrNull(row.withdrawn_at),
    withdrawnReason: row.withdrawn_reason,
  };
}

export interface KeyedAcceptance {
  policyKey: string;
  acceptance: WaiverAcceptance;
}

export interface WaiverFamily {
  policyKey: string;
  /** The title of the version in force, else of the newest approved version. */
  title: string;
  inForce: WaiverVersionInForce | null;
}

/**
 * Reads behind the waiver evaluation (SPK-REG-011, proposed amendment PA-01, ADR-004): the version
 * of a waiver family in force at an instant, a person's acceptances of the family (following
 * person merges, so an acceptance recorded under a merged record still counts), and the recorded
 * overrides. The judgement itself is `judgeWaiver`. Every read goes through the caller's
 * transaction when there is one.
 */
@Injectable()
export class WaiverStatusReader {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly capabilities: CapabilityService,
  ) {}

  /** The waiver families among `keys` (every family when omitted) with the version in force. */
  async families(
    organizationId: string,
    at: Date,
    keys?: readonly string[],
    trx?: Trx,
  ): Promise<Map<string, WaiverFamily>> {
    const out = new Map<string, WaiverFamily>();
    if (keys && keys.length === 0) return out;
    let query = (trx ?? executorFor(this.db))
      .selectFrom('policy_versions')
      .select([
        'id',
        'key',
        'version',
        'title',
        'content',
        'effective_from',
        'effective_to',
        'approval_status',
      ])
      .where('organization_id', '=', organizationId)
      .where('kind', '=', 'waiver')
      .where('approval_status', '<>', 'draft')
      .orderBy('key')
      .orderBy('version', 'desc');
    if (keys) query = query.where('key', 'in', [...new Set(keys)]);
    for (const row of await query.execute()) {
      const family = out.get(row.key) ?? { policyKey: row.key, title: row.title, inForce: null };
      out.set(row.key, family);
      if (family.inForce) continue;
      const from = new Date(row.effective_from).getTime();
      const to = row.effective_to === null ? Infinity : new Date(row.effective_to).getTime();
      if (row.approval_status !== 'approved' || from > at.getTime() || to <= at.getTime()) continue;
      const content = parseWaiverContent(row.content);
      // A version in force whose content states no complete rule cannot be judged against.
      if (!content) continue;
      family.title = row.title;
      family.inForce = {
        ref: {
          policyVersionId: row.id,
          version: row.version,
          title: row.title,
          effectiveFrom: iso(row.effective_from),
        },
        content,
      };
    }
    return out;
  }

  /**
   * Every acceptance of the given families (every family when omitted) recorded for the people,
   * keyed by the person id asked about (records of people merged into them are included), newest
   * first, each with the key of its family.
   */
  async acceptances(
    organizationId: string,
    personIds: readonly string[],
    keys: readonly string[] | undefined,
    trx?: Trx,
  ): Promise<Map<string, KeyedAcceptance[]>> {
    const out = new Map<string, KeyedAcceptance[]>(personIds.map((id) => [id, []]));
    if (personIds.length === 0 || (keys && keys.length === 0)) return out;
    const resolving = await this.persons.personIdsResolvingToMany(
      organizationId,
      [...new Set(personIds)],
      trx,
    );
    const askedBy = new Map<string, string[]>();
    for (const personId of new Set(personIds)) {
      const ids = resolving.get(personId) ?? [];
      for (const id of ids.length > 0 ? ids : [personId]) {
        askedBy.set(id, [...(askedBy.get(id) ?? []), personId]);
      }
    }
    let query = (trx ?? executorFor(this.db))
      .selectFrom('acknowledgments as a')
      .innerJoin('policy_versions as v', (join) =>
        join
          .onRef('v.organization_id', '=', 'a.organization_id')
          .onRef('v.id', '=', 'a.policy_version_id'),
      )
      .select([
        'a.id',
        'a.subject_person_id',
        'a.policy_version_id',
        'v.version',
        'v.key',
        'a.signed_by_person_id',
        'a.basis',
        'a.method',
        'a.signed_at',
        sql<string | null>`a.paper_dated_on::text`.as('paper_dated_on'),
        'a.recorded_by_kind',
        'a.recorded_by_person_id',
        'a.status',
        'a.withdrawn_at',
        'a.withdrawn_reason',
      ])
      .where('a.organization_id', '=', organizationId)
      .where('v.kind', '=', 'waiver')
      .where('a.subject_person_id', 'in', [...askedBy.keys()])
      .orderBy('a.signed_at', 'desc')
      .orderBy('a.id', 'desc');
    if (keys) query = query.where('v.key', 'in', [...new Set(keys)]);
    for (const row of await query.execute()) {
      const acceptance = toWaiverAcceptance(row);
      for (const asked of askedBy.get(row.subject_person_id) ?? []) {
        out.get(asked)?.push({ policyKey: row.key, acceptance });
      }
    }
    return out;
  }

  async statuses(
    organizationId: string,
    personIds: readonly string[],
    policyKey: string,
    at: Date,
    trx?: Trx,
  ): Promise<Map<string, WaiverStatus>> {
    const inForce =
      (await this.families(organizationId, at, [policyKey], trx)).get(policyKey)?.inForce ?? null;
    const acceptances = await this.acceptances(organizationId, personIds, [policyKey], trx);
    const out = new Map<string, WaiverStatus>();
    for (const personId of new Set(personIds)) {
      out.set(
        personId,
        judgeWaiver({
          policyKey,
          at,
          inForce,
          acceptances: (acceptances.get(personId) ?? []).map((a) => a.acceptance),
        }),
      );
    }
    return out;
  }

  async status(
    organizationId: string,
    personId: string,
    policyKey: string,
    at: Date,
    trx?: Trx,
  ): Promise<WaiverStatus> {
    const judged = (await this.statuses(organizationId, [personId], policyKey, at, trx)).get(
      personId,
    );
    if (!judged) throw new Error('waiver status was not evaluated for the person asked about');
    return judged;
  }

  /** The newest override recorded for the person, the family and any of the activities. */
  async override(
    organizationId: string,
    personId: string,
    policyKey: string,
    activities: readonly WaiverActivityRef[],
    trx?: Trx,
  ): Promise<WaiverOverride | null> {
    if (activities.length === 0) return null;
    const resolving = await this.persons.personIdsResolvingTo(organizationId, personId, trx);
    const row = await (trx ?? executorFor(this.db))
      .selectFrom('waiver_overrides')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', resolving.length > 0 ? resolving : [personId])
      .where('policy_key', '=', policyKey)
      .where((eb) =>
        eb.or(
          activities.map((activity) =>
            eb.and([eb('activity_type', '=', activity.type), eb('activity_id', '=', activity.id)]),
          ),
        ),
      )
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return row ? toWaiverOverride(row) : null;
  }

  /**
   * What the required waivers make of the people for one activity (SPK-REG-011): one finding per
   * person and family whose waiver is missing or lapsed. Nothing is evaluated, and nothing is
   * returned, while the organization has not turned liability waivers on.
   */
  async findings(
    organizationId: string,
    request: WaiverFindingsRequest,
    trx?: Trx,
  ): Promise<WaiverFinding[]> {
    const keys = [...new Set(request.policyKeys)];
    const personIds = [...new Set(request.personIds)];
    if (keys.length === 0 || personIds.length === 0) return [];
    if (!(await this.capabilities.isEnabled(organizationId, 'liability_waivers', trx))) return [];
    const families = await this.families(organizationId, request.at, keys, trx);
    const acceptances = await this.acceptances(organizationId, personIds, keys, trx);
    const findings: WaiverFinding[] = [];
    for (const policyKey of keys) {
      const family = families.get(policyKey);
      for (const personId of personIds) {
        const waiver = judgeWaiver({
          policyKey,
          at: request.at,
          inForce: family?.inForce ?? null,
          acceptances: (acceptances.get(personId) ?? [])
            .filter((a) => a.policyKey === policyKey)
            .map((a) => a.acceptance),
        });
        if (waiver.status === 'current') continue;
        const blocks = waiver.rule?.enforcement === 'block';
        const override = blocks
          ? await this.override(organizationId, personId, policyKey, request.activities, trx)
          : null;
        findings.push({
          personId,
          policyKey,
          title: family?.title ?? policyKey,
          status: waiver.status,
          severity: blocks && !override ? 'blocking' : 'warning',
          override,
          waiver,
        });
      }
    }
    return findings;
  }
}

export function toWaiverOverride(row: {
  id: string;
  person_id: string;
  policy_key: string;
  policy_version_id: string | null;
  waiver_status: 'missing' | 'lapsed';
  activity_type: WaiverActivityRef['type'];
  activity_id: string;
  reason: string;
  actor_person_id: string;
  occurred_at: Date | string;
}): WaiverOverride {
  return {
    id: row.id,
    personId: row.person_id,
    policyKey: row.policy_key,
    policyVersionId: row.policy_version_id,
    waiverStatus: row.waiver_status,
    activity: { type: row.activity_type, id: row.activity_id },
    reason: row.reason,
    actorPersonId: row.actor_person_id,
    occurredAt: iso(row.occurred_at),
  };
}
