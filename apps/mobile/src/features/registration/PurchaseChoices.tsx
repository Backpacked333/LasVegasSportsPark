/**
 * What a registration chooses beyond the place itself, per participant: the price tier and the
 * days under it, add-ons for the registration or for each day (SPK-PAY-014, proposed amendment
 * PA-03, capability `price_tiers_addons`, DEC-097 pending), and the uniform size (SPK-REG-012,
 * proposed amendment PA-07, capability `uniforms`, DEC-101 pending).
 *
 * The choices are the API's: `GET /v1/offerings/{id}/purchase-options` lists nothing of a
 * feature whose capability is off, so with both off nothing is asked and the line is the line of
 * before. Prices shown are the catalog's; the quote decides what is charged, and the app never
 * works out a total here. The API checks every choice again when the line is added.
 *
 * Accessibility (SPK-UX-009): every choice is a radio or checkbox row with its label, detail and
 * state; a missing choice is said in words next to its group, never by colour.
 */
import type { Schema } from '@sportspark/api-client';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant, formatMoney } from './format';
import { Body, ChoiceRow, Section } from './ui';

type Options = Schema<'OfferingPurchaseOptions'>;
type Tier = Options['tiers'][number];
type Session = Schema<'OfferingSession'>;

export interface PurchaseSelection {
  priceTierId: string | null;
  selectedSessionIds: readonly string[];
  /** Add-on id to the days chosen (an add-on chosen once maps to an empty list). */
  addons: Readonly<Record<string, readonly string[]>>;
  uniformSize: string | null;
}

export const EMPTY_SELECTION: PurchaseSelection = {
  priceTierId: null,
  selectedSessionIds: [],
  addons: {},
  uniformSize: null,
};

export type PurchaseLineFields = Pick<
  Schema<'AddBasketLineRequest'>,
  'priceTierId' | 'selectedSessionIds' | 'addons' | 'uniform'
>;

/** Whether the offering asks the customer to choose anything. */
export function hasPurchaseChoices(options: Options | undefined): options is Options {
  return (
    options !== undefined &&
    (options.tiers.length > 0 || options.addons.length > 0 || options.uniform !== null)
  );
}

function tierDays(tier: Tier): string {
  if (tier.attendance === 'all_sessions') return 'every day';
  const min = tier.minSessions ?? 1;
  if (tier.maxSessions === null) return `${min} or more days of your choice`;
  if (tier.maxSessions === min)
    return min === 1 ? '1 day of your choice' : `${min} days of your choice`;
  return `${min} to ${tier.maxSessions} days of your choice`;
}

/** What is still missing before a participant's line can be sent; empty when nothing is. */
export function missingChoices(selection: PurchaseSelection, options: Options): string[] {
  const missing: string[] = [];
  const tier = options.tiers.find((t) => t.id === selection.priceTierId);
  if (options.tiers.length > 0 && !tier) missing.push('Choose an option.');
  if (tier?.attendance === 'chosen_sessions') {
    const count = selection.selectedSessionIds.length;
    const min = tier.minSessions ?? 1;
    if (count < min || (tier.maxSessions !== null && count > tier.maxSessions)) {
      missing.push(`Choose ${tierDays(tier)}.`);
    }
  }
  if (options.uniform?.requirement === 'required' && !selection.uniformSize) {
    missing.push(`Choose a size for the ${options.uniform.name}.`);
  }
  return missing;
}

/** The request fields of a selection; nothing for a selection that chose nothing. */
export function purchaseLineFields(
  selection: PurchaseSelection,
  options: Options | undefined,
): PurchaseLineFields {
  if (!options) return {};
  const tier = options.tiers.find((t) => t.id === selection.priceTierId);
  const addons = options.addons.flatMap((addon) => {
    const chosen = selection.addons[addon.id];
    if (chosen === undefined) return [];
    if (addon.selection === 'per_session') {
      return chosen.length > 0 ? [{ addonId: addon.id, sessionIds: [...chosen] }] : [];
    }
    return [{ addonId: addon.id }];
  });
  return {
    ...(tier ? { priceTierId: tier.id } : {}),
    ...(tier?.attendance === 'chosen_sessions'
      ? { selectedSessionIds: [...selection.selectedSessionIds] }
      : {}),
    ...(addons.length > 0 ? { addons } : {}),
    ...(options.uniform && selection.uniformSize
      ? { uniform: { offeringUniformId: options.uniform.id, size: selection.uniformSize } }
      : {}),
  };
}

/** The purchase options and, when a choice is made per day, the offering's days. */
export function usePurchaseOptions(offeringId: string, enabled: boolean) {
  const options = useApiQuery({
    path: '/offerings/{id}/purchase-options',
    request: { path: { id: offeringId } },
    enabled,
  });
  const perDay =
    hasPurchaseChoices(options.data) &&
    (options.data.tiers.some((t) => t.attendance === 'chosen_sessions') ||
      options.data.addons.some((a) => a.selection === 'per_session'));
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId } },
    enabled: enabled && perDay,
  });
  return { options, sessions, perDay };
}

function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The choices of one participant. */
export function PurchaseChoices({
  personId,
  personName,
  options,
  sessions,
  timeZone,
  value,
  onChange,
  showMissing,
}: {
  personId: string;
  personName: string;
  options: Options;
  sessions: readonly Session[];
  timeZone?: string;
  value: PurchaseSelection;
  onChange: (value: PurchaseSelection) => void;
  /** After a first attempt: say what is still missing. */
  showMissing: boolean;
}) {
  const tier = options.tiers.find((t) => t.id === value.priceTierId);
  const currency = options.currency ?? options.addons[0]?.currency ?? 'USD';
  const days = sessions
    .filter((s) => s.status === 'scheduled')
    .map((s) => ({ id: s.id, label: formatInstant(s.scheduledStart, timeZone) }));
  const attended =
    tier?.attendance === 'chosen_sessions'
      ? days.filter((d) => value.selectedSessionIds.includes(d.id))
      : days;
  const uniform = options.uniform;
  const missing = showMissing ? missingChoices(value, options) : [];
  return (
    <Section title={`Options for ${personName}`} testID={`choices-${personId}`}>
      {options.tiers.length > 0 ? (
        <View accessibilityRole="radiogroup">
          {options.tiers.map((t) => (
            <ChoiceRow
              key={t.id}
              mode="radio"
              label={`${t.name}: ${formatMoney(t.priceMinor, currency)}${
                options.pricingBasis === 'per_session' ? ' per day' : ''
              }`}
              detail={`Attends ${tierDays(t)}`}
              checked={value.priceTierId === t.id}
              onToggle={() =>
                onChange({ ...value, priceTierId: t.id, selectedSessionIds: [], addons: {} })
              }
              testID={`tier-${personId}-${t.code}`}
            />
          ))}
        </View>
      ) : null}
      {tier?.attendance === 'chosen_sessions' ? (
        <View>
          <Body muted>{`Choose ${tierDays(tier)}.`}</Body>
          {days.map((day) => (
            <ChoiceRow
              key={day.id}
              label={day.label}
              checked={value.selectedSessionIds.includes(day.id)}
              onToggle={() => {
                const selectedSessionIds = toggled(value.selectedSessionIds, day.id);
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
                });
              }}
              testID={`day-${personId}-${day.id}`}
            />
          ))}
        </View>
      ) : null}
      {options.addons.map((addon) =>
        addon.selection === 'per_session' ? (
          <View key={addon.id}>
            <Body>{`${addon.name}: ${formatMoney(addon.priceMinor, addon.currency)} each day`}</Body>
            {addon.capacity !== null ? (
              <Body muted>Places are limited each day and held with your basket.</Body>
            ) : null}
            {attended.map((day) => (
              <ChoiceRow
                key={day.id}
                label={`${addon.name} on ${day.label}`}
                checked={(value.addons[addon.id] ?? []).includes(day.id)}
                onToggle={() =>
                  onChange({
                    ...value,
                    addons: {
                      ...value.addons,
                      [addon.id]: toggled(value.addons[addon.id] ?? [], day.id),
                    },
                  })
                }
                testID={`addon-${personId}-${addon.code}-${day.id}`}
              />
            ))}
          </View>
        ) : (
          <ChoiceRow
            key={addon.id}
            label={`${addon.name}: ${formatMoney(addon.priceMinor, addon.currency)}`}
            detail={
              addon.capacity !== null
                ? 'Once for this registration. Places are limited and held with your basket.'
                : 'Once for this registration'
            }
            checked={value.addons[addon.id] !== undefined}
            onToggle={() => {
              const next = { ...value.addons };
              if (next[addon.id] !== undefined) delete next[addon.id];
              else next[addon.id] = [];
              onChange({ ...value, addons: next });
            }}
            testID={`addon-${personId}-${addon.code}`}
          />
        ),
      )}
      {uniform ? (
        <View>
          <Body>
            {`${uniform.name}${
              uniform.priceMinor !== null && uniform.currency
                ? `: ${formatMoney(uniform.priceMinor, uniform.currency)}`
                : ''
            }`}
          </Body>
          <Body muted>
            {`${uniform.requirement === 'required' ? 'Required: choose a size.' : 'Optional: choose a size to add it.'}${
              uniform.returningHolderFree
                ? ' If this person already has this uniform, it is not charged again.'
                : ''
            }`}
          </Body>
          <View accessibilityRole="radiogroup">
            {uniform.sizes.map((size) => (
              <ChoiceRow
                key={size}
                mode="radio"
                label={`Size ${size}`}
                checked={value.uniformSize === size}
                onToggle={() =>
                  onChange({
                    ...value,
                    // An optional uniform is removed by choosing its size again.
                    uniformSize:
                      value.uniformSize === size && uniform.requirement === 'optional'
                        ? null
                        : size,
                  })
                }
                testID={`uniform-${personId}-${size}`}
              />
            ))}
          </View>
        </View>
      ) : null}
      {missing.map((text) => (
        <Body key={text}>{`✕ ${text}`}</Body>
      ))}
    </Section>
  );
}
