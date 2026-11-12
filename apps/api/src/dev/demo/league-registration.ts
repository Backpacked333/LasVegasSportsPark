import { checkoutBasket, publishOffering } from './catalog';
import type { DemoContext } from './context';
import type { DemoFacility } from './facility';
import type { DemoLeague, DemoTeam } from './league';
import { createAccount, createPerson } from './people';

export interface DemoLeagueRegistration {
  offeringId: string;
  playerPersonId: string;
  checkoutId: string;
  priceMinor: number;
}

/** Synthetic player fee for the demo league. Not an operator decision (DEC-008 is pending). */
const PLAYER_FEE_MINOR = 4_500;

/**
 * The league's priced registration (SPK-PAY-001, SPK-REG-007, SPK-AT-002): a season offering with
 * its own price rule that the season names, and one new adult who joins dev-parent's team through
 * it. The league manager accepts the application, the player pays through checkout, and the
 * confirmation places the player on the roster.
 */
export async function seedLeagueRegistration(
  ctx: DemoContext,
  facility: DemoFacility,
  league: DemoLeague,
): Promise<DemoLeagueRegistration> {
  const { api } = ctx;
  const manager = ctx.staff.league;
  const team = league.teams[0] as DemoTeam;

  const { offeringId, formPolicyVersionId } = await publishOffering(ctx, {
    slug: 'demo-league',
    program: {
      name: 'Demo Adult League (synthetic)',
      description: 'Synthetic example program for demonstrations: adult small-sided league play.',
      format: '5v5',
      ageBand: { minAgeYears: 18 },
    },
    entitlementName: 'Demo league player place (synthetic)',
    offering: {
      name: 'Demo Indoor League: player registration (synthetic)',
      description:
        'Synthetic example offering: join a team of the Demo Indoor League for the current season.',
      kind: 'season',
      locationLabel: 'Demo Indoor Court (boarded)',
      resourceIds: [facility.indoorCourt],
      startDayOffset: league.startDayOffset,
      endDayOffset: league.endDayOffset,
      seats: 40,
    },
    basePriceMinor: PLAYER_FEE_MINOR,
    wording: {
      eligibility:
        'Synthetic example wording: adults aged 18 or over on the first day of the season.',
      cancellation: 'Synthetic example wording, not a real cancellation policy.',
      form: 'Synthetic example wording, not a real participation form or waiver.',
    },
  });
  const season = await api.get<{ revision: number }>(`/seasons/${league.seasonId}`, manager);
  await api.patch(`/seasons/${league.seasonId}`, manager, {
    registrationOfferingRef: offeringId,
    expectedRevision: season.revision,
  });

  const playerPersonId = await createPerson(ctx, {
    kind: 'adult',
    givenName: 'Wren',
    familyName: 'Sample (demo new player)',
    dateOfBirth: '1992-05-05',
  });
  const player = await createAccount(
    ctx,
    'demo-player',
    playerPersonId,
    `customer: joined ${team.name} through a paid registration`,
  );
  await api.post('/acknowledgments', player, {
    subjectPersonId: playerPersonId,
    policyVersionId: formPolicyVersionId,
  });
  const basket = await api.post<{ id: string }>('/baskets', player, {
    ownerPersonId: playerPersonId,
  });
  const withLine = await api.post<{ lines: Array<{ applicationId: string }> }>(
    `/baskets/${basket.id}/lines`,
    player,
    {
      participantPersonId: playerPersonId,
      offeringId,
      intent: 'join_team',
      teamEntryId: team.entryId,
    },
  );
  const applicationId = withLine.lines[0]?.applicationId;
  if (!applicationId) throw new Error('demo seed: the join_team line has no application');
  const application = await api.get<{ revision: number }>(
    `/applications/${applicationId}`,
    manager,
  );
  await api.post(`/applications/${applicationId}/accept`, manager, {
    expectedRevision: application.revision,
  });
  const paid = await checkoutBasket(ctx, player, basket.id, null);

  return {
    offeringId,
    playerPersonId,
    checkoutId: paid.checkoutId,
    priceMinor: PLAYER_FEE_MINOR,
  };
}
