import { Inject, Injectable } from '@nestjs/common';
import {
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
} from '@sportspark/contracts';
import { CapabilityService, CLOCK, type Clock, type Trx } from '../../../kernel';
import {
  PRICING_PORT,
  type OfferingExtras,
  type OfferingSnapshot,
  type PricingPort,
} from '../../catalog';
import type { Reader } from '../enrollment.shared';
import { CapacityService } from './capacity.service';
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
  namesTierOrAddons(input: AddBasketLineInput): boolean {
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
   */
  async resolve(
    trx: Trx,
    organizationId: string,
    input: AddBasketLineInput,
    sessions: readonly OfferingSession[],
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
    const tier = tiersOn ? this.resolveTier(rule, input, now) : null;
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
      } else if (active?.requirement === 'required') {
        throw errors.validation(
          `This offering requires the uniform "${active.name}": choose a size.`,
          {
            code: 'UNIFORM_REQUIRED',
            path: 'uniform',
            offeringUniformId: active.id,
            sizes: active.sizes,
          },
        );
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
    input: AddBasketLineInput,
    now: Date,
  ): PriceRuleTier | null {
    const tiers = rule?.tiers ?? [];
    if (input.priceTierId === undefined) {
      if (tiers.length === 0) return null;
      throw errors.validation('This offering is priced by tier: choose one.', {
        code: 'TIER_REQUIRED',
        path: 'priceTierId',
        tiers: tiers.map((tier) => ({ id: tier.id, code: tier.code, name: tier.name })),
      });
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
   * capacity pools of the selection, created where missing:
   *
   * - `sessionPools`: when the rule lets some customers choose days, every line counts on the
   *   session pool of each session it attends, so a full-week place and a single day share that
   *   day's seats, and a participant counts only on the sessions selected;
   * - `replacesOfferingPools`: a line of chosen days takes no place in the offering-wide pool;
   * - `addonPools`: one place in the add-on's own pool, per session for an add-on limited per
   *   session.
   *
   * A line without tier and add-ons returns nothing and reads nothing, as before.
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
    if (!line.price_tier_id && addonRows.length === 0) {
      return { extraPoolIds: [], replacesOfferingPools: false };
    }
    await this.capabilities.require(organizationId, 'price_tiers_addons', trx);
    const now = this.clock.now();
    const extraPoolIds: string[] = [];
    let replacesOfferingPools = false;
    if (line.price_tier_id) {
      const rule = snapshot.priceRule;
      const tier = rule?.tiers.find((t) => t.id === line.price_tier_id);
      if (!rule || !tier) {
        throw errors.resourceConflict(
          'The price of this offering changed since the line was added; remove the line and add it again.',
          { code: 'TIER_NOT_AVAILABLE', lineId: line.id, priceTierId: line.price_tier_id },
        );
      }
      this.assertTierAvailable(tier, now);
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const gone = (line.selected_session_ids ?? []).filter((id) => {
        const session = byId.get(id);
        return !session || !selectable(session, now);
      });
      if (gone.length > 0) {
        throw errors.resourceConflict(
          'A chosen day has started or is no longer scheduled; remove the line and add it again.',
          { code: 'SESSION_NOT_SELECTABLE', lineId: line.id, sessionIds: gone },
        );
      }
      if (rule.tiers.some((t) => t.attendance === 'chosen_sessions')) {
        const attended = [
          ...(line.selected_session_ids ??
            sessions.filter((s) => selectable(s, now)).map((s) => s.id)),
        ].sort();
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
        replacesOfferingPools = line.selected_session_ids !== null;
      }
    }
    if (addonRows.length > 0) {
      const extras = await this.pricing.offeringExtras(organizationId, line.offering_id, trx);
      for (const row of addonRows) {
        const addon = extras.addons.find((a) => a.id === row.addon_id);
        if (!addon || addon.status !== 'active') {
          throw errors.resourceConflict(
            'An add-on of this line is no longer offered; remove the line and add it again.',
            { code: 'ADDON_NOT_OFFERED', lineId: line.id, addonId: row.addon_id },
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

  /** The uniform chosen for a line, with what it is and costs now; null when it chose none. */
  async uniformOfLine(
    trx: Trx,
    organizationId: string,
    line: { id: string; offering_id: string },
  ): Promise<{ uniform: OfferingUniform; size: string } | null> {
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
    return { uniform, size: row.size };
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
