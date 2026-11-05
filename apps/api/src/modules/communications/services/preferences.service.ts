import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CommunicationPreference,
  type CommunicationPreferences,
  type DeliveryChannelValue,
  type ImportProvenance,
  type NotificationCategoryValue,
  type Principal,
  type UpdatePreferencesInput,
} from '@sportspark/contracts';
import { json, type CommunicationPreferencesTable, type Db } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  UnitOfWork,
  assertImportPrincipal,
  importContentMismatch,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { MergedPersons } from './merged-persons';
import { CommunicationsActions } from '../communications.actions';
import {
  ALL_CATEGORIES,
  ALL_CHANNELS,
  COMMUNICATIONS_POLICY,
  isLockedPreference,
  type CommunicationsPolicy,
} from '../communications.policy';
import { iso, organizationOf, personOf } from '../communications.shared';
import { stableStringify } from '../providers/fake-messaging.provider';

type PreferenceRow = Pick<
  Selectable<CommunicationPreferencesTable>,
  'person_id' | 'channel' | 'category' | 'enabled' | 'source' | 'revision' | 'updated_at'
>;

/** One preference as an import states it (§5.3 "communication preferences"). */
export interface ImportedPreference {
  channel: DeliveryChannelValue;
  category: NotificationCategoryValue;
  enabled: boolean;
}

export interface ImportPreferencesInput {
  importProvenance: ImportProvenance;
  personId: string;
  preferences: readonly ImportedPreference[];
}

/** What an import did, per preference (stored with the import record and returned on replay). */
export interface ImportPreferencesResult {
  recordId: string;
  personId: string;
  /** False when this record id was imported before with the same content (nothing written). */
  created: boolean;
  /** Written with source 'import'. */
  applied: ImportedPreference[];
  /** Left as they are: the person chose these themself (a person's own choice wins). */
  keptPersonChoice: ImportedPreference[];
  /** Ignored: the operational in-app notice is mandatory whatever is imported (SPK-COMMS-007). */
  mandatory: ImportedPreference[];
}

const key = (p: { channel: string; category: string }): string => `${p.category}.${p.channel}`;

/**
 * SPK-COMMS-007: essential operational communications and promotional preferences are represented
 * separately (one row per person, channel and category). A person chooses external channels per
 * category; the operational in-app notice is locked on (service check here, database check in
 * migration 1000). Values with no stored row fall back to the policy defaults (DEC-062 pending).
 *
 * Import (COM-04, IF-40, §5.4, SPK-AT-024): `importPreferences` writes a migrated person's choices
 * with source 'import', create-if-absent by the import's record id, and only where the person has
 * not chosen themself; the person's own later change (source 'person') always wins.
 *
 * Merges (COM-05, SPK-IAM-007): nothing is rewritten. A person's effective preferences include the
 * stored rows of every person merged into them; where those explicit choices disagree the most
 * protective one applies (opted out; the mandatory in-app notice stays on) until the survivor
 * chooses again after the merge was followed (`communication_merge_follow_ups`).
 */
@Injectable()
export class PreferencesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(COMMUNICATIONS_POLICY) private readonly policy: CommunicationsPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly merges: MergedPersons,
  ) {}

  async getMine(principal: Principal): Promise<CommunicationPreferences> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    await this.authorize(principal, organizationId, personId);
    return this.effective(this.uow.reader(), organizationId, personId);
  }

  async updateMine(
    principal: Principal,
    input: UpdatePreferencesInput,
    correlationId: string | null,
  ): Promise<CommunicationPreferences> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    for (const pref of input.preferences) {
      if (isLockedPreference(pref.category, pref.channel) && !pref.enabled) {
        throw errors.validation(
          'Essential operational notices are always shown in the app; only external channels can be switched off (SPK-COMMS-007).',
          { path: 'preferences', channel: pref.channel, category: pref.category },
        );
      }
    }
    return this.uow.run(async ({ trx }) => {
      await this.authorize(principal, organizationId, personId);
      for (const pref of input.preferences) {
        await trx
          .insertInto('communication_preferences')
          .values({
            id: newId(),
            organization_id: organizationId,
            person_id: personId,
            channel: pref.channel,
            category: pref.category,
            enabled: pref.enabled,
            updated_by: json(snapshotActor(principal)),
            source: 'person',
          })
          .onConflict((oc) =>
            oc
              .columns(['organization_id', 'person_id', 'channel', 'category'])
              .doUpdateSet((eb) => ({
                enabled: pref.enabled,
                updated_by: json(snapshotActor(principal)),
                // The person's own choice: an import never overrides it (COM-04).
                source: 'person',
                revision: eb('communication_preferences.revision', '+', 1),
              })),
          )
          .execute();
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.managePreferences.id,
        targetType: 'communication_preferences',
        targetId: personId,
        reason: input.reason ?? null,
        correlationId,
        details: { preferences: input.preferences },
      });
      return this.effective(trx, organizationId, personId);
    });
  }

  /**
   * COM-04, IF-40 (§5.3, §5.4, SPK-AT-024): imports a migrated person's preferences. Only the
   * migration import principal of the batch may call it; it joins the caller's unit of work. The
   * same record id with the same content returns the first outcome and writes nothing; different
   * content is IMPORT_CONTENT_MISMATCH. Each preference is written with source 'import' unless the
   * person chose it themself; the mandatory operational in-app notice is never imported off.
   */
  async importPreferences(
    principal: Principal,
    input: ImportPreferencesInput,
  ): Promise<ImportPreferencesResult> {
    assertImportPrincipal(principal, input.importProvenance);
    const organizationId = organizationOf(principal);
    const { recordId, batchId, externalKey } = input.importProvenance;
    const preferences = canonicalPreferences(input.preferences);
    const content = { personId: input.personId, preferences };
    return this.uow.run(async ({ trx }) => {
      const existing = await trx
        .selectFrom('communication_preference_imports')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', recordId)
        .executeTakeFirst();
      if (existing) {
        if (stableStringify(existing.content) !== stableStringify(content)) {
          throw importContentMismatch({ recordType: 'communication_preferences', recordId });
        }
        return { ...(existing.outcome as unknown as ImportPreferencesResult), created: false };
      }
      const person = await this.persons.findPerson(organizationId, input.personId, trx);
      if (!person) throw errors.notFound('person', input.personId);
      const result: ImportPreferencesResult = {
        recordId,
        personId: input.personId,
        created: true,
        applied: [],
        keptPersonChoice: [],
        mandatory: [],
      };
      // Decide first, then claim the record id, then write: a concurrent import of the same record
      // finds the claim (ON CONFLICT waits for it) and writes nothing.
      const writes: Array<{ pref: ImportedPreference; storedId: string | null }> = [];
      for (const pref of preferences) {
        if (isLockedPreference(pref.category, pref.channel)) {
          result.mandatory.push(pref);
          continue;
        }
        const stored = await trx
          .selectFrom('communication_preferences')
          .select(['id', 'source'])
          .where('organization_id', '=', organizationId)
          .where('person_id', '=', input.personId)
          .where('channel', '=', pref.channel)
          .where('category', '=', pref.category)
          .forUpdate()
          .executeTakeFirst();
        if (stored?.source === 'person') {
          result.keptPersonChoice.push(pref);
          continue;
        }
        writes.push({ pref, storedId: stored?.id ?? null });
        result.applied.push(pref);
      }
      const claimed = await trx
        .insertInto('communication_preference_imports')
        .values({
          id: recordId,
          organization_id: organizationId,
          person_id: input.personId,
          batch_id: batchId,
          external_key: externalKey,
          content: json(content),
          outcome: json(result as unknown as Record<string, unknown>),
          imported_at: this.clock.now(),
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!claimed) {
        const first = await trx
          .selectFrom('communication_preference_imports')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', recordId)
          .executeTakeFirst();
        if (!first || stableStringify(first.content) !== stableStringify(content)) {
          throw importContentMismatch({ recordType: 'communication_preferences', recordId });
        }
        return { ...(first.outcome as unknown as ImportPreferencesResult), created: false };
      }
      const actor = json(snapshotActor(principal));
      for (const { pref, storedId } of writes) {
        if (storedId) {
          await trx
            .updateTable('communication_preferences')
            .set((eb) => ({
              enabled: pref.enabled,
              updated_by: actor,
              source: 'import',
              revision: eb('revision', '+', 1),
            }))
            .where('id', '=', storedId)
            .where('source', '=', 'import')
            .execute();
        } else {
          await trx
            .insertInto('communication_preferences')
            .values({
              id: newId(),
              organization_id: organizationId,
              person_id: input.personId,
              channel: pref.channel,
              category: pref.category,
              enabled: pref.enabled,
              updated_by: actor,
              source: 'import',
            })
            .execute();
        }
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'communications.import_preferences',
        targetType: 'communication_preferences',
        targetId: input.personId,
        correlationId: null,
        details: {
          recordId,
          batchId,
          externalKey,
          applied: result.applied.length,
          keptPersonChoice: result.keptPersonChoice.length,
          mandatory: result.mandatory.length,
        },
      });
      return result;
    });
  }

  /** The effective matrix (4 channels × 2 categories) for one person (merges resolved, COM-05). */
  async effective(
    db: Db | Trx,
    organizationId: string,
    personId: string,
  ): Promise<CommunicationPreferences> {
    // [canonical, ...merged into it]; a person no merge touches has only their own rows.
    const ids = await this.merges.resolving(db, organizationId, personId);
    const canonical = ids[0] as string;
    const rows: PreferenceRow[] = await db
      .selectFrom('communication_preferences')
      .select(['person_id', 'channel', 'category', 'enabled', 'source', 'revision', 'updated_at'])
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', ids)
      .execute();
    const merged = rows.some((r) => r.person_id !== canonical);
    const followUp = merged ? await this.latestFollowUp(db, organizationId, canonical) : null;
    const preferences: CommunicationPreference[] = [];
    for (const category of ALL_CATEGORIES) {
      for (const channel of ALL_CHANNELS) {
        const locked = isLockedPreference(category, channel);
        const forKey = rows.filter((r) => r.category === category && r.channel === channel);
        const chosen = locked ? [] : this.winning(forKey, canonical, followUp);
        const latest = [...forKey].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        )[0];
        preferences.push({
          channel,
          category,
          enabled: locked
            ? true
            : chosen.length > 0
              ? chosen.every((r) => r.enabled)
              : this.policy.defaultChannels[category][channel],
          stored: forKey.length > 0,
          locked,
          updatedAt: latest ? iso(latest.updated_at) : null,
        });
      }
    }
    return { personId, preferences };
  }

  /**
   * The stored rows that decide one preference: the canonical person's own row alone when no
   * merged person stored one, or when the canonical person chose it themself after the merge was
   * followed; otherwise every explicit row, of which the most protective applies (an opt-out).
   */
  private winning(
    rows: readonly PreferenceRow[],
    canonical: string,
    followUp: FollowUpSnapshot | null,
  ): PreferenceRow[] {
    const own = rows.find((r) => r.person_id === canonical);
    const others = rows.filter((r) => r.person_id !== canonical);
    if (others.length === 0) return own ? [own] : [];
    if (own && own.source === 'person' && followUp) {
      const before = followUp.get(key(own));
      if (before === undefined || own.revision > before) return [own];
    }
    return [...rows];
  }

  /** The survivor's stored preference revisions when the latest merge into them was followed. */
  private async latestFollowUp(
    db: Db | Trx,
    organizationId: string,
    survivorPersonId: string,
  ): Promise<FollowUpSnapshot | null> {
    const row = await db
      .selectFrom('communication_merge_follow_ups')
      .select('survivor_preferences')
      .where('organization_id', '=', organizationId)
      .where('survivor_person_id', '=', survivorPersonId)
      .orderBy('followed_at', 'desc')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    const snapshot: FollowUpSnapshot = new Map();
    for (const p of row.survivor_preferences) snapshot.set(key(p), p.revision);
    return snapshot;
  }

  /** Channels a notice of this category is delivered on for the person (in-app always for operational). */
  async enabledChannels(
    db: Db | Trx,
    organizationId: string,
    personId: string,
    category: NotificationCategoryValue,
  ): Promise<DeliveryChannelValue[]> {
    const effective = await this.effective(db, organizationId, personId);
    return effective.preferences
      .filter((p) => p.category === category && p.enabled)
      .map((p) => p.channel);
  }

  private async authorize(
    principal: Principal,
    organizationId: string,
    personId: string,
  ): Promise<void> {
    await this.authorization.require(principal, CommunicationsActions.managePreferences, {
      type: 'communication_preferences',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
  }
}

/** `category.channel` → the survivor's row revision when the merge was followed. */
type FollowUpSnapshot = Map<string, number>;

/** One entry per channel and category (the last one stated wins), in a stable order. */
function canonicalPreferences(preferences: readonly ImportedPreference[]): ImportedPreference[] {
  const byKey = new Map<string, ImportedPreference>();
  for (const p of preferences) {
    byKey.set(key(p), { channel: p.channel, category: p.category, enabled: p.enabled });
  }
  return [...byKey.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
