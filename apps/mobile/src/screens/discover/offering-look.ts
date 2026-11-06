/**
 * How an offering is drawn in Discover lists (SCR-C-07): its kind's decorative icon and tile
 * colour, and the one-line summary read with its name.
 */
import type { Schema } from '@sportspark/api-client';
import {
  OFFERING_KIND_LABELS,
  ageBandLabel,
  formatMoney,
  type OfferingKind,
} from '../../features/registration/format';
import { offeringDates } from '../../features/registration/status';
import { kindColors } from '../../ui/theme';

type PublicOffering = Schema<'PublicOffering'>;

/** Decorative icon and tile colour per kind; the kind's name is always in the row's text. */
export const KIND_LOOK: Record<OfferingKind, readonly [string, string]> = {
  season: ['sports_soccer', kindColors.league],
  term: ['school', kindColors.program],
  camp: ['wb_sunny', kindColors.rental],
  session: ['event', kindColors.program],
  trial: ['sports', kindColors.league],
  makeup: ['replay', kindColors.program],
  pickup: ['stadium', kindColors.dropin],
  private_coaching: ['person', kindColors.basketball],
  rental: ['event_available', kindColors.rental],
  package: ['confirmation_number', kindColors.dropin],
  membership: ['card_membership', kindColors.league],
  party: ['cake', kindColors.party],
};

export function offeringSummary(offering: PublicOffering): string {
  return [
    OFFERING_KIND_LABELS[offering.kind],
    offering.format,
    ageBandLabel(offering.ageBand),
    offeringDates(offering),
    offering.locationLabel,
    offering.price
      ? `From ${formatMoney(offering.price.basePriceMinor, offering.price.currency)}`
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

