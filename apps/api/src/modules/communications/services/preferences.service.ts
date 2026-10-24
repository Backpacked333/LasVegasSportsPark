import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CommunicationPreference,
  type CommunicationPreferences,
  type DeliveryChannelValue,
  type NotificationCategoryValue,
  type Principal,
  type UpdatePreferencesInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  DATABASE,
  UnitOfWork,
  snapshotActor,
  type Trx,
} from '../../../kernel';
import { CommunicationsActions } from '../communications.actions';
import {
  ALL_CATEGORIES,
  ALL_CHANNELS,
  COMMUNICATIONS_POLICY,
  isLockedPreference,
  type CommunicationsPolicy,
} from '../communications.policy';
import { iso, organizationOf, personOf } from '../communications.shared';

/**
 * SPK-COMMS-007: essential operational communications and promotional preferences are represented
 * separately (one row per person, channel and category). A person chooses external channels per
 * category; the operational in-app notice is locked on (service check here, database check in
 * migration 1000). Values with no stored row fall back to the policy defaults (DEC-062 pending).
 */
@Injectable()
export class PreferencesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(COMMUNICATIONS_POLICY) private readonly policy: CommunicationsPolicy,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
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
          })
          .onConflict((oc) =>
            oc
              .columns(['organization_id', 'person_id', 'channel', 'category'])
              .doUpdateSet((eb) => ({
                enabled: pref.enabled,
                updated_by: json(snapshotActor(principal)),
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

  /** The effective matrix (4 channels × 2 categories) for one person. */
  async effective(
    db: Db | Trx,
    organizationId: string,
    personId: string,
  ): Promise<CommunicationPreferences> {
    const rows = await db
      .selectFrom('communication_preferences')
      .select(['channel', 'category', 'enabled', 'updated_at'])
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .execute();
    const preferences: CommunicationPreference[] = [];
    for (const category of ALL_CATEGORIES) {
      for (const channel of ALL_CHANNELS) {
        const stored = rows.find((r) => r.category === category && r.channel === channel);
        const locked = isLockedPreference(category, channel);
        preferences.push({
          channel,
          category,
          enabled: locked
            ? true
            : (stored?.enabled ?? this.policy.defaultChannels[category][channel]),
          stored: stored !== undefined,
          locked,
          updatedAt: stored ? iso(stored.updated_at) : null,
        });
      }
    }
    return { personId, preferences };
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
