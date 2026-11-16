import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type AddBasketLineInput,
  type BasketLineAddon,
  type BasketLineUniform,
  type OfferingAddon,
  type OfferingSession,
  type OfferingUniform,
  type PriceRule,
  type PriceRuleTier,
  type PriceSnapshot,
  type Principal,
  type RegistrationIntent,
} from '@sportspark/contracts';
import type { WaitlistRequestedExtras } from '@sportspark/db';
import { CapabilityService, CLOCK, type Clock, type Trx } from '../../../kernel';
import {
  PRICING_PORT,
  type OfferingExtras,
  type OfferingSnapshot,
  type PricingPort,
} from '../../catalog';
import { BOOKING_INTENTS } from '../enrollment.policy';
import type { Reader } from '../enrollment.shared';
import { CapacityService, type PoolRow } from './capacity.service';
import { CatalogSessions } from './catalog-sessions';
import { MembershipPricing } from './membership-pricing';

/** What a basket line chose beyond its place, validated against the catalog. */
export interface ResolvedSelection {
  tier: PriceRuleTier | null;
  /** The day selection of a tier of chosen sessions; null means every session. */
  selectedSessionIds: string[] | null;
  addons: Array<{ addon: OfferingAddon; sessionIds: string[] }>;
  uniform: { uniform: OfferingUniform; size: string } | null;
}

/** The stored selection of a line, as the pricing and capacity steps read it. */
export interface LineSelection {
  id: string;
  offering_id: string;
  participant_person_id: string;
  session_id: string | null;
  price_tier_id: string | null;
  selected_session_ids: string[] | null;
}

/**
 * The choices a command names for a registration: the fields of a basket line, which a waitlist
 * entry, a trial conversion and a transfer name in the same way.
 */
export type ChoiceInput = Pick<
  AddBasketLineInput,
  'offeringId' | 'priceTierId' | 'selectedSessionIds' | 'addons' | 'uniform' | 'quantity'
>;

/** A stored selection and the add-ons chosen with it, as the pools it needs are worked out. */
export interface SelectionForPools {
  /** The basket line, when there is one (named in refusals). */
  id: string | null;
  offering_id: string;
  price_tier_id: string | null;
  selected_session_ids: string[] | null;
  addons: ReadonlyArray<{ addon_id: string; session_id: string | null }>;
}

/** What a waitlist entry waits for (migration 0524), as offer generation reads it. */
export interface WaitingRequest {
  offering_id: string;
  intent: RegistrationIntent;
  price_tier_id: string | null;
  selected_session_ids: string[] | null;
  requested_extras: WaitlistRequestedExtras | null;
}

/**
 * Why a waiting request cannot be offered a place now: its capability is off (the entry waits
 * until it is on again), the offering is sold by tier and the entry names none, or what it asked
 * for can no longer be bought (the tier's deadline passed or the price changed, a chosen day
 * started or was canceled, an add-on was retired).
 */
export type RequestRefusal = 'capability_off' | 'tier_required' | 'selection_not_available';

/** Whether a waitlist entry asked for more than a place of the offering. */
export function hasRequest(entry: {
  price_tier_id: string | null;
  requested_extras: WaitlistRequestedExtras | null;
}): boolean {
  return entry.price_tier_id !== null || entry.requested_extras !== null;
}

export const EMPTY_SELECTION: ResolvedSelection = {
  tier: null,
  selectedSessionIds: null,
  addons: [],
  uniform: null,
};

const selectable = (session: OfferingSession, now: Date): boolean =>
  session.status === 'scheduled' && new Date(session.scheduledStart).getTime() > now.getTime();

/**
 * The tier, day, add-on and uniform choices of a registration (proposed amendments PA-03,
 * SPK-PAY-014, capability `price_tiers_addons`, DEC-097 pending; and PA-07, SPK-REG-012,
 * capability `uniforms`, DEC-101 pending). Enrollment owns what a line chose; what can be chosen
 * and what it costs is catalog's, read through PRICING_PORT (never its tables, §4.2).
 *
 * - Exactly one tier applies to a line: while the effective price rule has tiers and the
 *   capability is on, a line names one, that can still be bought at the instant of purchase and
 *   whose session bounds its day selection meets.
 * - An add-on selected per session names sessions the participant attends.
 * - Capacity counts a participant only on the sessions selected, and add-on capacity is its own
 *   pool (`CapacityService.ensureAddonPool`).
 * - With a capability off, a request that names any of its fields is refused
 *   (CAPABILITY_DISABLED), nothing of it is evaluated, and a line without them behaves as before.
 *
 * It also produces the price estimate of a line from the same facts a quote uses (the tier, the
 * participant's membership, the sessions still to attend), so a basket never shows the price of
 * one session or of another tier as the price of the line (SPK-PAY-013, SPK-PAY-014, SPK-PAY-015).
 */
@Injectable()
export class RegistrationExtras {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
    private readonly capabilities: CapabilityService,
    private readonly sessions: CatalogSessions,
    private readonly capacity: CapacityService,
    private readonly memberships: MembershipPricing,
  ) {}

  /** Whether a request names any tier, day or add-on field (SPK-PAY-014). */
  namesTierOrAddons(input: ChoiceInput): boolean {
    return (
      input.priceTierId !== undefined ||
      input.selectedSessionIds !== undefined ||
      (input.addons?.length ?? 0) > 0
    );
  }

  /**
   * The offering's sessions, read before the command's transaction (catalog's service reads
   * through its own executor). They are needed whenever tiers or add-ons may be in play, which is
   * only while `price_tiers_addons` is on: with it off nothing is read, as before.
   */
  async sessionsBefore(organizationId: string, offeringId: string): Promise<OfferingSession[]> {
    if (!(await this.capabilities.isEnabled(organizationId, 'price_tiers_addons'))) return [];
    return this.sessions.list(organizationId, offeringId);
  }

  /**
   * Validates what a new line chose (inside the command's unit of work). Throws ACCESS_DENIED
   * (CAPABILITY_DISABLED) for a field whose capability is off, VALIDATION_FAILED with a
   * `details.code` for a choice the catalog does not offer.
   *
   * Every command that opens a registration with choices validates them here, with the rules of
   * a basket line: POST /baskets/{id}/lines, joining a waitlist and accepting its offer, a trial
   * conversion and a transfer (quality review M-2, M-4). `requireUniform: false` and
   * `forTransfer` are for a transfer only: it orders no uniform (`assertComplete` decides
   * there), and its answer to a missing tier says what to do on a screen that cannot name one.
   */
  async resolve(
    trx: Trx,
    organizationId: string,
    input: ChoiceInput,
    sessions: readonly OfferingSession[],
    options: { requireUniform?: boolean; forTransfer?: boolean } = {},
  ): Promise<ResolvedSelection> {
    const now = this.clock.now();
    // DEC-016: a field of an amendment is a commitment of its capability, checked in the unit of
    // work, so turning the switch off stops new selections before anything is written.
    if (this.namesTierOrAddons(input)) {
      await this.capabilities.require(organizationId, 'price_tiers_addons', trx);
    }
    if (input.uniform !== undefined) {
      await this.capabilities.require(organizationId, 'uniforms', trx);
    }
    const tiersOn = await this.capabilities.isEnabled(organizationId, 'price_tiers_addons', trx);
    const uniformsOn = await this.capabilities.isEnabled(organizationId, 'uniforms', trx);
    if (!tiersOn && !uniformsOn) return EMPTY_SELECTION;

    const rule = await this.pricing.effectivePriceRule(organizationId, input.offeringId, now, trx);
    const extras: OfferingExtras = await this.pricing.offeringExtras(
      organizationId,
      input.offeringId,
      trx,
    );
    const tier = tiersOn
      ? this.resolveTier(rule, input, now, options.forTransfer ? 'name_tier' : 'choose_price_tier')
      : null;
    const selectedSessionIds =
      tier?.attendance === 'chosen_sessions'
        ? this.resolveDays(tier, input.selectedSessionIds ?? [], sessions, now)
        : null;
    if (!tier && input.selectedSessionIds !== undefined) {
      throw errors.validation('Days are chosen under a price tier that lets the customer choose.', {
        code: 'TIER_REQUIRED',
        path: 'priceTierId',
      });
    }
    if (tier?.attendance === 'all_sessions' && input.selectedSessionIds !== undefined) {
      throw errors.validation(
        `The tier "${tier.name}" attends every session; no days are chosen.`,
        {
          code: 'TIER_ATTENDS_ALL_SESSIONS',
          path: 'selectedSessionIds',
        },
      );
    }

    const attended = new Set(
      selectedSessionIds ?? sessions.filter((s) => selectable(s, now)).map((s) => s.id),
    );
    const addons: ResolvedSelection['addons'] = [];
    for (const [index, chosen] of (tiersOn ? (input.addons ?? []) : []).entries()) {
      const addon = extras.addons.find((a) => a.id === chosen.addonId && a.status === 'active');
      if (!addon) {
        // An unknown id, another offering's and a retired add-on read the same (§4.10).
        throw errors.validation('This add-on is not offered with this offering.', {
          code: 'ADDON_NOT_OFFERED',
          path: `addons.${index}.addonId`,
        });
      }
      if (rule && addon.currency !== rule.currency) {
        throw errors.validation(`A basket holds one currency (${rule.currency}).`, {
          path: `addons.${index}.addonId`,
        });
      }
      const sessionIds = [...new Set(chosen.sessionIds ?? [])];
      if ((addon.selection === 'per_session') !== sessionIds.length > 0) {
        throw errors.validation(
          addon.selection === 'per_session'
            ? `"${addon.name}" is chosen for each day it is wanted.`
            : `"${addon.name}" is chosen once for the registration, not per day.`,
          { code: 'ADDON_SELECTION_SHAPE', path: `addons.${index}.sessionIds` },
        );
      }
      const outside = sessionIds.filter((id) => !attended.has(id));
      if (outside.length > 0) {
        throw errors.validation(
          `"${addon.name}" can only be chosen for days the participant attends.`,
          {
            code: 'ADDON_SESSION_NOT_SELECTED',
            path: `addons.${index}.sessionIds`,
            sessionIds: outside,
          },
        );
      }
      addons.push({ addon, sessionIds });
    }

    let uniform: ResolvedSelection['uniform'] = null;
    if (uniformsOn) {
      const active = extras.uniforms.find((u) => u.status === 'active') ?? null;
      if (input.uniform) {
        if (!active || active.id !== input.uniform.offeringUniformId) {
          throw errors.validation('This uniform is not offered with this offering.', {
            code: 'UNIFORM_NOT_OFFERED',
            path: 'uniform.offeringUniformId',
          });
        }
        if (!active.sizes.includes(input.uniform.size)) {
          throw errors.validation(`"${active.name}" does not come in that size.`, {
            code: 'UNIFORM_SIZE_NOT_OFFERED',
            path: 'uniform.size',
            sizes: active.sizes,
          });
        }
        if (active.currency && rule && active.currency !== rule.currency) {
          throw errors.validation(`A basket holds one currency (${rule.currency}).`, {
            path: 'uniform.offeringUniformId',
          });
        }
        uniform = { uniform: active, size: input.uniform.size };
      } else if (active?.requirement === 'required' && options.requireUniform !== false) {
        throw uniformRequired(active, 'choose_uniform_size');
      }
    }

    if ((tier || addons.length > 0 || uniform) && input.quantity !== 1) {
      throw errors.validation('A line with a tier, add-ons or a uniform is for one participant.', {
        code: 'QUANTITY_ONE',
        path: 'quantity',
      });
    }
    return { tier, selectedSessionIds, addons, uniform };
  }

  /** SPK-PAY-014: exactly one tier applies; it is the one named, if it can still be bought. */
  private resolveTier(
    rule: PriceRule | null,
    input: ChoiceInput,
    now: Date,
    nextAction: TierNextAction,
  ): PriceRuleTier | null {
    const tiers = rule?.tiers ?? [];
    if (input.priceTierId === undefined) {
      if (tiers.length === 0) return null;
      throw tierRequired(tiers, nextAction);
    }
    const tier = tiers.find((t) => t.id === input.priceTierId);
    if (!tier) {
      throw errors.validation('This price tier is not a tier of the price in effect.', {
        code: 'TIER_NOT_OFFERED',
        path: 'priceTierId',
      });
    }
    this.assertTierAvailable(tier, now);
    return tier;
  }

  private assertTierAvailable(tier: PriceRuleTier, now: Date): void {
    if (tier.availableUntil && new Date(tier.availableUntil).getTime() <= now.getTime()) {
      throw errors.resourceConflict(
        `The tier "${tier.name}" could be bought until ${tier.availableUntil}.`,
        { code: 'TIER_NOT_AVAILABLE', priceTierId: tier.id, availableUntil: tier.availableUntil },
      );
    }
  }

  private resolveDays(
    tier: PriceRuleTier,
    requested: readonly string[],
    sessions: readonly OfferingSession[],
    now: Date,
  ): string[] {
    const ids = [...new Set(requested)];
    const min = tier.minSessions ?? 1;
    if (ids.length < min || (tier.maxSessions !== null && ids.length > tier.maxSessions)) {
      throw errors.validation(
        tier.maxSessions === null
          ? `The tier "${tier.name}" is for at least ${min} day(s).`
          : min === tier.maxSessions
            ? `The tier "${tier.name}" is for exactly ${min} day(s).`
            : `The tier "${tier.name}" is for ${min} to ${tier.maxSessions} days.`,
        {
          code: 'TIER_SESSION_COUNT',
          path: 'selectedSessionIds',
          minSessions: min,
          maxSessions: tier.maxSessions,
          selected: ids.length,
        },
      );
    }
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const refused = ids.filter((id) => {
      const session = byId.get(id);
      return !session || !selectable(session, now);
    });
    if (refused.length > 0) {
      throw errors.validation(
        'A chosen day is not a session of this offering that can still be attended.',
        { code: 'SESSION_NOT_SELECTABLE', path: 'selectedSessionIds', sessionIds: refused },
      );
    }
    // Stored in session order, so the selection reads the same however it was sent.
    return ids.sort((a, b) => {
      const x = byId.get(a) as OfferingSession;
      const y = byId.get(b) as OfferingSession;
      return x.scheduledStart === y.scheduledStart
        ? a < b
          ? -1
          : 1
        : x.scheduledStart < y.scheduledStart
          ? -1
          : 1;
    });
  }

  // -------------------------------------------------------------------------------------------
  // The one check every path into an enrollment passes (quality review M-2, M-4)
  // -------------------------------------------------------------------------------------------

  /**
   * SPK-PAY-014 (PA-03), SPK-REG-012 (PA-07): what a registration must have chosen before an
   * enrollment exists for it, whatever command creates it. Called by
   * `EnrollmentsService.createPending`, the one place an enrollment row is written, so a basket
   * hold, a waitlist acceptance, a trial conversion's line and a transfer all pass it, at the
   * instant the place is taken (an open basket never expires, and an offering may gain tiers or
   * a required uniform after a line was added):
   *
   * - while `price_tiers_addons` is on and the price rule in effect has tiers, the registration
   *   names one (VALIDATION_FAILED `TIER_REQUIRED`, with the tiers): no enrollment exists whose
   *   quote would answer `TIER_REQUIRED`, and none attends days nobody chose;
   * - while `uniforms` is on and the offering requires a uniform, one was chosen with a size
   *   (VALIDATION_FAILED `UNIFORM_REQUIRED`, with the uniform and its sizes). A transfer orders
   *   nothing (it has no basket line a quote could charge the uniform on), so a transfer into
   *   such an offering is refused and the answer says to register through a basket.
   *
   * `details.nextAction` says exactly what to do on the path that was refused. A rental or party
   * booking is not a participant's registration (`BOOKING_INTENTS`) and is not checked. With
   * both capabilities off nothing is read and nothing is refused, as before.
   */
  async assertComplete(
    trx: Trx,
    organizationId: string,
    facts: {
      offeringId: string;
      intent: RegistrationIntent;
      priceTierId: string | null;
      /** The basket line the enrollment is created for; null for a transfer. */
      basketLineId: string | null;
    },
  ): Promise<void> {
    if (BOOKING_INTENTS.includes(facts.intent)) return;
    const tiersOn = await this.capabilities.isEnabled(organizationId, 'price_tiers_addons', trx);
    const uniformsOn = await this.capabilities.isEnabled(organizationId, 'uniforms', trx);
    if (!tiersOn && !uniformsOn) return;
    const viaBasket = facts.basketLineId !== null;
    if (tiersOn && !facts.priceTierId) {
      const rule = await this.pricing.effectivePriceRule(
        organizationId,
        facts.offeringId,
        this.clock.now(),
        trx,
      );
      if (rule && rule.tiers.length > 0) {
        throw tierRequired(rule.tiers, viaBasket ? 'remove_line_and_choose_tier' : 'name_tier');
      }
    }
    if (!uniformsOn) return;
    const extras = await this.pricing.offeringExtras(organizationId, facts.offeringId, trx);
    const required = extras.uniforms.find(
      (u) => u.status === 'active' && u.requirement === 'required',
    );
    if (!required) return;
    // A transfer has no basket line a uniform could be chosen and charged on.
    if (!viaBasket) throw uniformRequired(required, 'register_in_basket');
    const chosen = await trx
      .selectFrom('basket_line_uniforms')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('basket_line_id', '=', facts.basketLineId as string)
      .executeTakeFirst();
    if (!chosen) throw uniformRequired(required, 'remove_line_and_choose_uniform_size');
  }

  /** Writes the add-ons and the uniform of a line just inserted (the database guards them too). */
  async write(
    trx: Trx,
    organizationId: string,
    lineId: string,
    offeringId: string,
    selection: ResolvedSelection,
  ): Promise<void> {
    const rows = selection.addons.flatMap(({ addon, sessionIds }) =>
      (sessionIds.length > 0 ? sessionIds : [null]).map((sessionId) => ({
        id: newId(),
        organization_id: organizationId,
        basket_line_id: lineId,
        offering_id: offeringId,
        addon_id: addon.id,
        session_id: sessionId,
      })),
    );
    if (rows.length > 0) await trx.insertInto('basket_line_addons').values(rows).execute();
    if (selection.uniform) {
      await trx
        .insertInto('basket_line_uniforms')
        .values({
          id: newId(),
          organization_id: organizationId,
          basket_line_id: lineId,
          offering_id: offeringId,
          offering_uniform_id: selection.uniform.uniform.id,
          size: selection.uniform.size,
        })
        .execute();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  /** The add-ons and uniform of each line, named and priced as catalog states them now. */
  async decorations(
    db: Reader,
    organizationId: string,
    lines: ReadonlyArray<{ id: string; offering_id: string; participant_person_id: string }>,
  ): Promise<Map<string, { addons: BasketLineAddon[]; uniform: BasketLineUniform | null }>> {
    const out = new Map<string, { addons: BasketLineAddon[]; uniform: BasketLineUniform | null }>();
    if (lines.length === 0) return out;
    const ids = lines.map((line) => line.id);
    const addonRows = await db
      .selectFrom('basket_line_addons')
      .select(['basket_line_id', 'addon_id', 'session_id'])
      .where('organization_id', '=', organizationId)
      .where('basket_line_id', 'in', ids)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const uniformRows = await db
      .selectFrom('basket_line_uniforms')
      .select(['basket_line_id', 'offering_uniform_id', 'size'])
      .where('organization_id', '=', organizationId)
      .where('basket_line_id', 'in', ids)
      .execute();
    if (addonRows.length === 0 && uniformRows.length === 0) return out;
    const extrasByOffering = new Map<string, OfferingExtras>();
    for (const line of lines) {
      const lineAddons = addonRows.filter((row) => row.basket_line_id === line.id);
      const lineUniform = uniformRows.find((row) => row.basket_line_id === line.id);
      if (lineAddons.length === 0 && !lineUniform) continue;
      let extras = extrasByOffering.get(line.offering_id);
      if (!extras) {
        extras = await this.pricing.offeringExtras(organizationId, line.offering_id, db as Trx);
        extrasByOffering.set(line.offering_id, extras);
      }
      const addons: BasketLineAddon[] = [];
      // In the catalog's own order of the add-ons, so a line reads the same every time.
      const chosenAddonIds = new Set(lineAddons.map((row) => row.addon_id));
      for (const addon of extras.addons.filter((a) => chosenAddonIds.has(a.id))) {
        const addonId = addon.id;
        // In id order, so the selection reads the same wherever it is shown or stored.
        const sessionIds = lineAddons
          .filter((row) => row.addon_id === addonId && row.session_id !== null)
          .map((row) => row.session_id as string)
          .sort();
        addons.push({
          addonId,
          code: addon.code,
          name: addon.name,
          selection: addon.selection,
          sessionIds,
          priceMinor: addon.priceMinor,
          currency: addon.currency,
          quantity: Math.max(1, sessionIds.length),
        });
      }
      let uniform: BasketLineUniform | null = null;
      const chosen = lineUniform
        ? extras.uniforms.find((u) => u.id === lineUniform.offering_uniform_id)
        : undefined;
      if (lineUniform && chosen) {
        uniform = {
          offeringUniformId: chosen.id,
          itemKey: chosen.itemKey,
          name: chosen.name,
          size: lineUniform.size,
          priceMinor: chosen.priceMinor,
          currency: chosen.currency,
          returningHolderFree: chosen.returningHolderFree,
          heldUniformOrderId: await this.heldUniform(
            db,
            organizationId,
            line.participant_person_id,
            chosen.itemKey,
          ),
        };
      }
      out.set(line.id, { addons, uniform });
    }
    return out;
  }

  /**
   * SPK-REG-012: the handed-over uniform with this item key the participant already holds (the
   * fact the offering's returning-participant rule reads); null when they hold none.
   */
  async heldUniform(
    db: Reader,
    organizationId: string,
    participantPersonId: string,
    itemKey: string,
  ): Promise<string | null> {
    const row = await db
      .selectFrom('uniform_orders')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', '=', participantPersonId)
      .where('item_key', '=', itemKey)
      .where('status', '=', 'handed_over')
      .orderBy('handed_over_at', 'desc')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // The price estimate of a line (the same facts a quote uses)
  // -------------------------------------------------------------------------------------------

  /**
   * The price basis of a basket line at `at` (SPK-PAY-001: from the catalog price rule, never a
   * client). For a plain term price this is the rule's base price, exactly as before. Where the
   * line is priced per session, under a tier or at a member price, it carries an `estimate`
   * worked out in the quote's own order (tier, then member price, then per-session
   * multiplication) from the same facts: the tier named on the line, the participant's
   * membership through enrollment's ledger, and the sessions still to attend through catalog's
   * port. A line the quote would refuse (its capability turned off) carries no estimate.
   */
  async priceSnapshot(
    trx: Trx | undefined,
    organizationId: string,
    line: Omit<LineSelection, 'id'>,
    at: Date = this.clock.now(),
  ): Promise<PriceSnapshot | null> {
    const rule = await this.pricing.effectivePriceRule(organizationId, line.offering_id, at, trx);
    if (!rule) return null;
    const base: PriceSnapshot = {
      priceRuleId: rule.id,
      basePriceMinor: rule.basePriceMinor,
      currency: rule.currency,
      chargeLines: rule.chargeLines,
    };
    const tier = line.price_tier_id
      ? (rule.tiers.find((t) => t.id === line.price_tier_id) ?? null)
      : null;
    const memberPriceMinor = tier ? tier.memberPriceMinor : rule.memberPriceMinor;
    const perSession = rule.pricingBasis === 'per_session';
    if (!perSession && !tier && memberPriceMinor === null) return base;
    if (
      perSession &&
      !(await this.capabilities.isEnabled(organizationId, 'per_session_pricing', trx))
    )
      return base;
    if (
      line.price_tier_id &&
      (!tier || !(await this.capabilities.isEnabled(organizationId, 'price_tiers_addons', trx)))
    )
      return base;

    const standardPriceMinor = tier ? tier.priceMinor : rule.basePriceMinor;
    let appliedPriceMinor = standardPriceMinor;
    let appliedPrice: 'standard' | 'member' = 'standard';
    if (
      memberPriceMinor !== null &&
      rule.memberEntitlementDefinitionId !== null &&
      (await this.capabilities.isEnabled(organizationId, 'member_pricing', trx))
    ) {
      const standing = await this.memberships.memberStanding(
        organizationId,
        line.participant_person_id,
        rule.memberEntitlementDefinitionId,
        at,
        trx,
      );
      if (standing.holds) {
        appliedPriceMinor = memberPriceMinor;
        appliedPrice = 'member';
      }
    }
    let unitPriceMinor = appliedPriceMinor;
    let sessionCount: number | null = null;
    if (perSession) {
      const remaining = await this.pricing.remainingSessions(
        organizationId,
        line.offering_id,
        at,
        trx,
      );
      sessionCount = countedSessions(
        remaining.map((session) => session.id),
        line,
      ).length;
      unitPriceMinor = appliedPriceMinor * sessionCount;
    }
    if (!perSession && !tier && appliedPrice === 'standard') return base;
    return {
      ...base,
      estimate: {
        pricingBasis: rule.pricingBasis,
        tier: tier ? { id: tier.id, code: tier.code, name: tier.name } : null,
        appliedPrice,
        appliedPriceMinor,
        sessionCount,
        unitPriceMinor,
        estimatedAt: at.toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Holding a line: capability, the tier and days again, and the pools of its selection
  // -------------------------------------------------------------------------------------------

  /**
   * What holding a line with a tier, a day selection or add-ons needs beyond its place
   * (SPK-PAY-014): the checks again at the hold instant (an open basket never expires), and the
   * capacity pools of the selection (`selectionPools`). A line without tier and add-ons returns
   * nothing and reads nothing, as before.
   */
  async poolsForHold(
    trx: Trx,
    organizationId: string,
    line: LineSelection,
    snapshot: OfferingSnapshot,
    sessions: readonly OfferingSession[],
    actor: Principal,
  ): Promise<{ extraPoolIds: string[]; replacesOfferingPools: boolean }> {
    const addonRows = await trx
      .selectFrom('basket_line_addons')
      .select(['addon_id', 'session_id'])
      .where('organization_id', '=', organizationId)
      .where('basket_line_id', '=', line.id)
      // One order for every line, so two holds that create the same pools never wait on each
      // other in opposite orders.
      .orderBy('addon_id')
      .orderBy('session_id')
      .execute();
    const hasUniform = await trx
      .selectFrom('basket_line_uniforms')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('basket_line_id', '=', line.id)
      .executeTakeFirst();
    if (hasUniform) await this.capabilities.require(organizationId, 'uniforms', trx);
    return this.selectionPools(
      trx,
      organizationId,
      {
        id: line.id,
        offering_id: line.offering_id,
        price_tier_id: line.price_tier_id,
        selected_session_ids: line.selected_session_ids,
        addons: addonRows,
      },
      snapshot,
      sessions,
      actor,
    );
  }

  /**
   * The capacity pools a selection takes a place in beyond the offering-wide ones, created where
   * missing (SPK-PAY-014). One function for every path that takes a place: a basket hold, a
   * waitlist entry and its offer's acceptance, a transfer (quality review M-2, M-3).
   *
   * - `extraPoolIds`, session pools: when the rule lets some customers choose days, every
   *   registration counts on the seat pool of each session it attends, so a full-week place and
   *   a single day share that day's seats, and a participant counts only on the sessions
   *   selected. Before any of those seats is reserved, every live registration of the offering
   *   that attends the session and is not yet on its pool is committed to it
   *   (`CapacityService.seatRegistrations`): a place bought before the offering had such a tier
   *   counts on each day like every other;
   * - `replacesOfferingPools`: a selection of chosen days takes no place in the offering-wide pool;
   * - `extraPoolIds`, add-on pools: one place in the add-on's own pool, per session for an add-on
   *   limited per session.
   *
   * The offering's pools are locked first, in id order, and the add-on pools are reserved after
   * them (also in id order, by `acquireHolds`): every transaction that takes several of them
   * takes them in that order. A selection without tier and add-ons returns nothing and reads
   * nothing.
   */
  async selectionPools(
    trx: Trx,
    organizationId: string,
    selection: SelectionForPools,
    snapshot: OfferingSnapshot,
    sessions: readonly OfferingSession[],
    actor: Principal,
  ): Promise<{ extraPoolIds: string[]; replacesOfferingPools: boolean }> {
    if (!selection.price_tier_id && selection.addons.length === 0) {
      return { extraPoolIds: [], replacesOfferingPools: false };
    }
    await this.capabilities.require(organizationId, 'price_tiers_addons', trx);
    await this.capacity.lockOfferingPools(trx, organizationId, selection.offering_id);
    const now = this.clock.now();
    const lineId = selection.id;
    const extraPoolIds: string[] = [];
    let replacesOfferingPools = false;
    if (selection.price_tier_id) {
      const rule = snapshot.priceRule;
      const tier = rule?.tiers.find((t) => t.id === selection.price_tier_id);
      if (!rule || !tier) {
        throw errors.resourceConflict(
          'The price of this offering changed since the line was added; remove the line and add it again.',
          { code: 'TIER_NOT_AVAILABLE', lineId, priceTierId: selection.price_tier_id },
        );
      }
      this.assertTierAvailable(tier, now);
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const gone = (selection.selected_session_ids ?? []).filter((id) => {
        const session = byId.get(id);
        return !session || !selectable(session, now);
      });
      if (gone.length > 0) {
        throw errors.resourceConflict(
          'A chosen day has started or is no longer scheduled; remove the line and add it again.',
          { code: 'SESSION_NOT_SELECTABLE', lineId, sessionIds: gone },
        );
      }
      if (countsPerSession(rule)) {
        const open = sessions.filter((s) => selectable(s, now)).map((s) => s.id);
        const attended = [...(selection.selected_session_ids ?? open)].sort();
        for (const sessionId of attended) {
          const pools = await this.capacity.ensureSessionPool(
            trx,
            organizationId,
            snapshot,
            byId.get(sessionId) as OfferingSession,
            actor,
          );
          extraPoolIds.push(...pools.filter((p) => p.status === 'active').map((p) => p.id));
        }
        // M-3: everyone who attends these sessions is on their pools before a seat is reserved.
        await this.capacity.seatRegistrations(trx, organizationId, selection.offering_id, open);
        replacesOfferingPools = selection.selected_session_ids !== null;
      }
    }
    if (selection.addons.length > 0) {
      const extras = await this.pricing.offeringExtras(organizationId, selection.offering_id, trx);
      for (const row of selection.addons) {
        const addon = extras.addons.find((a) => a.id === row.addon_id);
        if (!addon || addon.status !== 'active') {
          throw errors.resourceConflict(
            'An add-on of this line is no longer offered; remove the line and add it again.',
            { code: 'ADDON_NOT_OFFERED', lineId, addonId: row.addon_id },
          );
        }
        if (addon.capacity === null) continue;
        extraPoolIds.push(
          await this.capacity.ensureAddonPool(
            trx,
            organizationId,
            { id: addon.id, capacity: addon.capacity },
            row.session_id,
            actor,
          ),
        );
      }
    }
    return { extraPoolIds, replacesOfferingPools };
  }

  /**
   * Quality review M-3 (SPK-PAY-014): for a command that takes a session's seat outside a
   * selection (a pickup, trial or makeup booking, a session queue's offer). Where the offering's
   * price rule lets customers choose days and `price_tiers_addons` is on, every live
   * registration is first committed to the seat pools of the sessions it still attends, under
   * the offering's pool locks. Does nothing, and reads only the switch, otherwise.
   */
  async reconcileSessionSeats(
    trx: Trx,
    organizationId: string,
    snapshot: OfferingSnapshot,
    correlationId: string | null = null,
  ): Promise<void> {
    if (!countsPerSession(snapshot.priceRule)) return;
    if (!(await this.capabilities.isEnabled(organizationId, 'price_tiers_addons', trx))) return;
    await this.capacity.lockOfferingPools(trx, organizationId, snapshot.offering.id);
    const open = await this.pricing.remainingSessions(
      organizationId,
      snapshot.offering.id,
      this.clock.now(),
      trx,
    );
    await this.capacity.seatRegistrations(
      trx,
      organizationId,
      snapshot.offering.id,
      open.map((session) => session.id),
      correlationId,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Waiting for a selection (quality review M-2)
  // -------------------------------------------------------------------------------------------

  /**
   * The pools a waitlist entry needs a free place in, read as they are now (nothing is created:
   * joining created them), and whether the entry can still be offered a place at all.
   *
   * An entry that asked for nothing beyond a place needs the offering-wide pools of its intent,
   * as before. One that names a tier needs what a basket line with the same choices holds: the
   * seat pool of each session it attends where days can be chosen, the offering-wide pools
   * unless it chose days, and the pool of each limited add-on.
   */
  async poolsOfRequest(
    db: Reader,
    organizationId: string,
    snapshot: OfferingSnapshot,
    entry: WaitingRequest,
  ): Promise<{ pools: PoolRow[]; refusal: RequestRefusal | null }> {
    const trx = db as Trx;
    const offeringPools = this.capacity.poolsForIntent(
      await this.capacity.poolRowsForOffering(db, organizationId, entry.offering_id),
      entry.intent,
    );
    const rule = snapshot.priceRule;
    const requestedAddons = entry.requested_extras?.addons ?? [];
    const namesTierOrAddons = entry.price_tier_id !== null || requestedAddons.length > 0;
    const tiersOn = await this.capabilities.isEnabled(organizationId, 'price_tiers_addons', trx);
    if (!tiersOn) {
      // With the switch off nothing of the amendment is evaluated; an entry that asked for a
      // tier or an add-on while it was on waits until it is on again.
      return namesTierOrAddons
        ? { pools: [], refusal: 'capability_off' }
        : { pools: offeringPools, refusal: null };
    }
    if (
      entry.requested_extras?.uniform &&
      !(await this.capabilities.isEnabled(organizationId, 'uniforms', trx))
    ) {
      return { pools: [], refusal: 'capability_off' };
    }
    const tiers = rule?.tiers ?? [];
    if (!entry.price_tier_id && tiers.length > 0) {
      return { pools: offeringPools, refusal: 'tier_required' };
    }
    if (!namesTierOrAddons) return { pools: offeringPools, refusal: null };
    const now = this.clock.now();
    const tier = entry.price_tier_id ? tiers.find((t) => t.id === entry.price_tier_id) : null;
    if (entry.price_tier_id) {
      if (!tier) return { pools: [], refusal: 'selection_not_available' };
      if (tier.availableUntil && new Date(tier.availableUntil).getTime() <= now.getTime()) {
        return { pools: [], refusal: 'selection_not_available' };
      }
    }
    const open = (
      await this.pricing.remainingSessions(organizationId, entry.offering_id, now, trx)
    ).map((session) => session.id);
    const openIds = new Set(open);
    if ((entry.selected_session_ids ?? []).some((id) => !openIds.has(id))) {
      return { pools: [], refusal: 'selection_not_available' };
    }
    const attended = entry.selected_session_ids ?? open;
    const pools: PoolRow[] =
      entry.selected_session_ids && countsPerSession(rule) ? [] : [...offeringPools];
    if (tier && countsPerSession(rule) && attended.length > 0) {
      pools.push(
        ...(await db
          .selectFrom('capacity_pools')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('scope_type', '=', 'session')
          .where('scope_id', 'in', attended)
          .where('status', '=', 'active')
          .orderBy('id')
          .execute()),
      );
    }
    if (requestedAddons.length > 0) {
      const extras = await this.pricing.offeringExtras(organizationId, entry.offering_id, trx);
      const attendedIds = new Set(attended);
      for (const requested of requestedAddons) {
        const addon = extras.addons.find((a) => a.id === requested.addonId);
        if (
          !addon ||
          addon.status !== 'active' ||
          requested.sessionIds.some((id) => !attendedIds.has(id))
        ) {
          return { pools: [], refusal: 'selection_not_available' };
        }
        if (addon.capacity === null) continue;
        let q = db
          .selectFrom('capacity_pools')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('scope_type', '=', 'addon')
          .where('scope_id', '=', addon.id)
          .where('status', '=', 'active');
        q =
          requested.sessionIds.length > 0
            ? q.where('scope_session_id', 'in', requested.sessionIds)
            : q.where('scope_session_id', 'is', null);
        pools.push(...(await q.orderBy('id').execute()));
      }
    }
    return { pools: pools.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), refusal: null };
  }

  /**
   * DEC-006 (proposed `waitlistFirst`): how many other participants wait for a place this
   * registration would take. While nobody in the offering's queue asked for a tier, days or
   * add-ons this is everyone waiting for the offering, as before. Once somebody did, an entry
   * counts when the pools it waits on include one of `poolIds`: a family that waits for Monday
   * does not stop another from buying Tuesday, and still gets Monday's next free seat first.
   */
  async waitingAhead(
    db: Reader,
    organizationId: string,
    snapshot: OfferingSnapshot,
    participantPersonId: string,
    poolIds: readonly string[],
  ): Promise<number> {
    const entries = await db
      .selectFrom('waitlist_entries')
      .select([
        'offering_id',
        'intent',
        'price_tier_id',
        'selected_session_ids',
        'requested_extras',
      ])
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', snapshot.offering.id)
      .where('status', '=', 'waiting')
      .where('session_id', 'is', null)
      .where('participant_person_id', '<>', participantPersonId)
      .orderBy('id')
      .execute();
    if (entries.length === 0) return 0;
    // As before while the offering has one price and nobody asked for more than a place. Once
    // it is sold by tier, an entry that names no tier can never be offered a place (it leaves
    // the queue at the next offer), so it is ahead of nobody.
    const soldByTier = (snapshot.priceRule?.tiers.length ?? 0) > 0;
    if (!soldByTier && entries.every((entry) => !hasRequest(entry))) return entries.length;
    const wanted = new Set(poolIds);
    let ahead = 0;
    for (const entry of entries) {
      const { pools, refusal } = await this.poolsOfRequest(db, organizationId, snapshot, entry);
      if (refusal) continue;
      if (pools.some((pool) => wanted.has(pool.id))) ahead += 1;
    }
    return ahead;
  }

  /**
   * The uniform chosen for a line, with what it is and costs now; null when it chose none.
   * `charged` is false for a uniform without a price, and for a participant who already holds
   * the current uniform where the offering does not charge it again (the same facts the quote
   * reads, SPK-REG-012).
   */
  async uniformOfLine(
    trx: Trx,
    organizationId: string,
    line: { id: string; offering_id: string; participant_person_id: string },
  ): Promise<{ uniform: OfferingUniform; size: string; charged: boolean } | null> {
    const row = await trx
      .selectFrom('basket_line_uniforms')
      .select(['offering_uniform_id', 'size'])
      .where('organization_id', '=', organizationId)
      .where('basket_line_id', '=', line.id)
      .executeTakeFirst();
    if (!row) return null;
    const extras = await this.pricing.offeringExtras(organizationId, line.offering_id, trx);
    const uniform = extras.uniforms.find((u) => u.id === row.offering_uniform_id);
    if (!uniform || uniform.status !== 'active') {
      throw errors.resourceConflict(
        'The uniform of this line is no longer offered; remove the line and add it again.',
        { code: 'UNIFORM_NOT_OFFERED', lineId: line.id },
      );
    }
    const held = uniform.returningHolderFree
      ? await this.heldUniform(trx, organizationId, line.participant_person_id, uniform.itemKey)
      : null;
    return { uniform, size: row.size, charged: uniform.priceMinor !== null && held === null };
  }
}

/**
 * The sessions a per-session price counts for a line (SPK-PAY-013, SPK-PAY-014): the remaining
 * sessions, narrowed to the one session a session line buys, or to the line's day selection.
 */
export function countedSessions(
  remainingSessionIds: readonly string[],
  line: { session_id: string | null; selected_session_ids: string[] | null },
): string[] {
  if (line.session_id) return remainingSessionIds.filter((id) => id === line.session_id);
  if (line.selected_session_ids) {
    const selected = new Set(line.selected_session_ids);
    return remainingSessionIds.filter((id) => selected.has(id));
  }
  return [...remainingSessionIds];
}

/**
 * Whether a session's seats are shared by everyone who attends it (SPK-PAY-014): the price rule
 * in effect has a tier that lets the customer choose days. The capability is checked by the
 * caller.
 */
export function countsPerSession(rule: PriceRule | null): boolean {
  return !!rule && rule.tiers.some((tier) => tier.attendance === 'chosen_sessions');
}

/** What to do about a missing tier, on the path that was refused (`details.nextAction`). */
type TierNextAction = 'choose_price_tier' | 'remove_line_and_choose_tier' | 'name_tier';

function tierRequired(tiers: readonly PriceRuleTier[], nextAction: TierNextAction): DomainError {
  const message: Record<TierNextAction, string> = {
    choose_price_tier: 'This offering is priced by tier: choose one.',
    remove_line_and_choose_tier:
      'This offering is priced by tier: remove the line and add it again, choosing a tier.',
    name_tier:
      'This offering is sold by price option. To move into it, choose the option, and the days where days are chosen. Where that cannot be chosen here, register for it in a basket and then cancel the current registration.',
  };
  return errors.validation(message[nextAction], {
    code: 'TIER_REQUIRED',
    path: 'priceTierId',
    nextAction,
    tiers: tiers.map((tier) => ({ id: tier.id, code: tier.code, name: tier.name })),
  });
}

/** What to do about a missing uniform, on the path that was refused (`details.nextAction`). */
type UniformNextAction =
  'choose_uniform_size' | 'remove_line_and_choose_uniform_size' | 'register_in_basket';

function uniformRequired(uniform: OfferingUniform, nextAction: UniformNextAction): DomainError {
  const sizes = uniform.sizes.join(', ');
  const message: Record<UniformNextAction, string> = {
    choose_uniform_size: `This offering requires the uniform "${uniform.name}": choose a size.`,
    remove_line_and_choose_uniform_size: `This offering requires the uniform "${uniform.name}": remove the line and add it again, choosing a size (${sizes}).`,
    register_in_basket: `This offering requires the uniform "${uniform.name}", which is chosen and charged in a basket. A transfer cannot order it: register for this offering in a basket, choosing a size (${sizes}), then cancel the current registration.`,
  };
  return errors.validation(message[nextAction], {
    code: 'UNIFORM_REQUIRED',
    path: 'uniform',
    nextAction,
    offeringUniformId: uniform.id,
    name: uniform.name,
    sizes: uniform.sizes,
  });
}
