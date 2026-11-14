/**
 * What a registration chooses beyond the place itself, in assisted registration: the price tier
 * and the days under it, add-ons for the registration or for each day (SPK-PAY-014, proposed
 * amendment PA-03, capability `price_tiers_addons`, pending DEC-097), and the uniform size
 * (SPK-REG-012, proposed amendment PA-07, capability `uniforms`, pending DEC-101).
 *
 * The choices come from `GET /v1/offerings/{id}/purchase-options`, which lists nothing of a
 * feature whose capability is off; with both off this renders nothing and no request is made, so
 * the form is the form of before. Prices shown are the catalog's; the quote decides what is
 * charged. Nothing is validated here beyond what lets the request be formed: the API refuses a
 * choice the offering does not offer and says why.
 */
import type { Schema } from '@sportspark/api-client';
import { usePermissions } from '../../api/permissions';
import { useApiQuery } from '../../api/useApiQuery';
import { useFacilities } from './facilities';
import { CheckboxGroup, SelectField } from './fields';
import { formatInstant, formatMoney } from './format';
import { PENDING } from './pending';

type Options = Schema<'OfferingPurchaseOptions'>;
type Tier = Options['tiers'][number];

export interface PurchaseSelection {
  priceTierId: string;
  selectedSessionIds: string[];
  /** Add-on id to the sessions chosen (an add-on chosen once maps to an empty list). */
  addons: Record<string, string[]>;
  uniformSize: string;
}

export const EMPTY_SELECTION: PurchaseSelection = {
  priceTierId: '',
  selectedSessionIds: [],
  addons: {},
  uniformSize: '',
};

export type PurchaseLineFields = Pick<
  Schema<'AddBasketLineRequest'>,
  'priceTierId' | 'selectedSessionIds' | 'addons' | 'uniform'
>;

/** The request fields of a selection; nothing for a selection that chose nothing. */
export function purchaseLineFields(
  selection: PurchaseSelection,
  options: Options | undefined,
): PurchaseLineFields {
  if (!options) return {};
  const tier = options.tiers.find((t) => t.id === selection.priceTierId);
  const addons = options.addons
    .filter((addon) => selection.addons[addon.id] !== undefined)
    .filter(
      (addon) =>
        addon.selection === 'per_registration' || (selection.addons[addon.id] ?? []).length > 0,
    )
    .map((addon) =>
      addon.selection === 'per_session'
        ? { addonId: addon.id, sessionIds: selection.addons[addon.id] ?? [] }
        : { addonId: addon.id },
    );
  return {
    ...(tier ? { priceTierId: tier.id } : {}),
    ...(tier?.attendance === 'chosen_sessions'
      ? { selectedSessionIds: selection.selectedSessionIds }
      : {}),
    ...(addons.length > 0 ? { addons } : {}),
    ...(options.uniform && selection.uniformSize
      ? { uniform: { offeringUniformId: options.uniform.id, size: selection.uniformSize } }
      : {}),
  };
}

function tierDays(tier: Tier): string {
  if (tier.attendance === 'all_sessions') return 'every session';
  const min = tier.minSessions ?? 1;
  if (tier.maxSessions === null) return `${min} or more days of your choice`;
  if (tier.maxSessions === min)
    return min === 1 ? '1 day of your choice' : `${min} days of your choice`;
  return `${min} to ${tier.maxSessions} days of your choice`;
}

/** The purchase options of an offering, read only while one of the two capabilities is on. */
export function usePurchaseOptions(offeringId: string) {
  const permissions = usePermissions();
  const enabled =
    offeringId !== '' &&
    (permissions.isCapabilityEnabled('price_tiers_addons') === true ||
      permissions.isCapabilityEnabled('uniforms') === true);
  return useApiQuery({
    path: '/offerings/{id}/purchase-options',
    request: { path: { id: offeringId } },
    enabled,
  });
}

export function PurchaseChoices({
  offeringId,
  options,
  value,
  onChange,
  errors,
}: {
  offeringId: string;
  options: Options | undefined;
  value: PurchaseSelection;
  onChange: (value: PurchaseSelection) => void;
  errors: Record<string, string | undefined>;
}) {
  const { timeZoneOf } = useFacilities();
  const hasChoices =
    options !== undefined &&
    (options.tiers.length > 0 || options.addons.length > 0 || options.uniform !== null);
  const needsDays =
    hasChoices &&
    (options.tiers.some((t) => t.attendance === 'chosen_sessions') ||
      options.addons.some((a) => a.selection === 'per_session'));
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: offeringId } },
    enabled: needsDays,
    staleTime: 60_000,
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId } },
    enabled: needsDays,
  });
  if (!hasChoices) return null;
  const zone = offering.data ? timeZoneOf(offering.data.facilityId) : null;
  const tier = options.tiers.find((t) => t.id === value.priceTierId);
  const currency = options.currency ?? options.addons[0]?.currency ?? 'USD';
  const days = (sessions.data ?? [])
    .filter((s) => s.status === 'scheduled')
    .map((s) => ({
      value: s.id,
      label: `${s.title ?? `Session ${s.sequence}`}: ${formatInstant(s.scheduledStart, zone)}`,
    }));
  // The days an add-on can be chosen for: the days chosen under the tier, or every day.
  const attended =
    tier?.attendance === 'chosen_sessions'
      ? days.filter((d) => value.selectedSessionIds.includes(d.value))
      : days;
  const uniform = options.uniform;
  return (
    <fieldset className="rf-panel" aria-label="Tier, days, add-ons and uniform">
      {options.tiers.length > 0 ? (
        <SelectField
          label="Price tier"
          required
          placeholder="Choose a tier"
          hint={`Exactly one tier applies to a registration. Proposed, pending ${PENDING.priceTiersAddons.ids.join(', ')}.`}
          value={value.priceTierId}
          onChange={(priceTierId) =>
            onChange({ ...value, priceTierId, selectedSessionIds: [], addons: {} })
          }
          options={options.tiers.map((t) => ({
            value: t.id,
            label: `${t.name}: ${formatMoney(t.priceMinor, currency)}${
              options.pricingBasis === 'per_session' ? ' per day' : ''
            }, ${tierDays(t)}`,
          }))}
          error={errors.priceTierId}
        />
      ) : null}
      {tier?.attendance === 'chosen_sessions' ? (
        <>
          <CheckboxGroup
            legend={`Days for ${tier.name}`}
            hint={`Choose ${tierDays(tier)}.`}
            options={days}
            values={value.selectedSessionIds}
            onChange={(selectedSessionIds) =>
              onChange({
                ...value,
                selectedSessionIds,
                // An add-on stays chosen only for days still attended.
                addons: Object.fromEntries(
                  Object.entries(value.addons).map(([id, ids]) => [
                    id,
                    ids.filter((sessionId) => selectedSessionIds.includes(sessionId)),
                  ]),
                ),
              })
            }
          />
          {errors.selectedSessionIds ? (
            <p className="rf-error">{errors.selectedSessionIds}</p>
          ) : null}
        </>
      ) : null}
      {options.addons.map((addon) =>
        addon.selection === 'per_session' ? (
          <CheckboxGroup
            key={addon.id}
            legend={`${addon.name}: ${formatMoney(addon.priceMinor, addon.currency)} each day`}
            hint={
              addon.capacity !== null
                ? `Limited to ${addon.capacity} place(s) each day; the place is held with the basket.`
                : undefined
            }
            options={attended}
            values={value.addons[addon.id] ?? []}
            onChange={(ids) => onChange({ ...value, addons: { ...value.addons, [addon.id]: ids } })}
          />
        ) : (
          <CheckboxGroup
            key={addon.id}
            legend={`${addon.name}: ${formatMoney(addon.priceMinor, addon.currency)}`}
            hint={
              addon.capacity !== null ? `Limited to ${addon.capacity} place(s) in all.` : undefined
            }
            options={[{ value: addon.id, label: `Add ${addon.name} to this registration` }]}
            values={value.addons[addon.id] !== undefined ? [addon.id] : []}
            onChange={(ids) => {
              const next = { ...value.addons };
              if (ids.length > 0) next[addon.id] = [];
              else delete next[addon.id];
              onChange({ ...value, addons: next });
            }}
          />
        ),
      )}
      {errors.addons ? <p className="rf-error">{errors.addons}</p> : null}
      {uniform ? (
        <SelectField
          label={`${uniform.name} size`}
          required={uniform.requirement === 'required'}
          placeholder={uniform.requirement === 'required' ? 'Choose a size' : 'No uniform'}
          hint={`${uniform.requirement === 'required' ? 'Required by this offering' : 'Optional'}${
            uniform.priceMinor !== null && uniform.currency
              ? `, ${formatMoney(uniform.priceMinor, uniform.currency)}`
              : ', not charged'
          }${
            uniform.returningHolderFree
              ? '; a participant who already holds this uniform is not charged again'
              : ''
          }. Proposed, pending ${PENDING.uniforms.ids.join(', ')}.`}
          value={value.uniformSize}
          onChange={(uniformSize) => onChange({ ...value, uniformSize })}
          options={uniform.sizes.map((size) => ({ value: size, label: size }))}
          error={errors.uniform}
        />
      ) : null}
    </fieldset>
  );
}

/** What must be chosen before the line can be sent; the API checks everything else. */
export function purchaseSelectionErrors(
  selection: PurchaseSelection,
  options: Options | undefined,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!options) return errors;
  const tier = options.tiers.find((t) => t.id === selection.priceTierId);
  if (options.tiers.length > 0 && !tier) errors.priceTierId = 'Choose a price tier.';
  if (tier?.attendance === 'chosen_sessions') {
    const count = selection.selectedSessionIds.length;
    const min = tier.minSessions ?? 1;
    if (count < min || (tier.maxSessions !== null && count > tier.maxSessions)) {
      errors.selectedSessionIds = `Choose ${tierDays(tier)}.`;
    }
  }
  if (options.uniform?.requirement === 'required' && !selection.uniformSize) {
    errors.uniform = 'Choose a size: this offering requires the uniform.';
  }
  return errors;
}
