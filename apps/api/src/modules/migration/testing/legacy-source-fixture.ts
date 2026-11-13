import type { StagedRow } from '@sportspark/contracts';

/**
 * A synthetic snapshot shaped like the records the facility's current system holds (§5.3), for
 * migration development and tests. Nothing here is a real person, price list or transaction:
 * names are invented, email addresses use the reserved `.test` domain and telephone numbers the
 * reserved 555-01xx range.
 *
 * Status (§6.7): the record kinds, their fields and the oddities are **Proposed**. They follow
 * what was observed read-only in the current system's screens (`docs/package-a/
 * operator-questionnaire.md`, third column); no export has been supplied (§1.4), so the wire
 * format and field names of a real export are **Pending decision** (questionnaire A1, DEC-014).
 * Money is in cents as the source shows it, including the prices that are workarounds.
 */

export interface LegacyCustomer {
  id: string;
  firstName: string;
  lastName: string;
  birthDate?: string;
  email?: string;
  phone?: string;
  active: boolean;
  /** The digital waiver the person accepted, if any. */
  waiver?: { version: number; signedAt: string };
  /** A paper waiver is recorded by its date only. */
  paperWaiverOn?: string;
}

export interface LegacyFamilyLink {
  id: string;
  /** The customer the link is recorded on. */
  customerId: string;
  relatedCustomerId: string;
  relation: 'child' | 'partner' | 'authorized_adult';
}

export interface LegacyProduct {
  id: string;
  name: string;
  section: string;
  priceCents: number;
}

export interface LegacySeason {
  id: string;
  name: string;
  registrationType: 'class' | 'camp' | 'league_team';
  startsOn: string;
  endsOn: string;
}

/** A level of a season: an age band, a division or a tournament group. */
export interface LegacyLevel {
  id: string;
  seasonId: string;
  name: string;
  priceCents: number;
}

export interface LegacyTeam {
  id: string;
  levelId: string;
  name: string;
}

export interface LegacyRosterEntry {
  id: string;
  teamId: string;
  customerId: string;
}

export interface LegacyInvoiceItem {
  /** A register product, or absent for a registration line. */
  productId?: string;
  description: string;
  unitCents: number;
  quantity: number;
}

export interface LegacyInvoice {
  id: string;
  customerId: string;
  createdOn: string;
  status: 'paid' | 'open';
  items: LegacyInvoiceItem[];
  paidCents: number;
}

export interface LegacyCredit {
  id: string;
  customerId: string;
  kind: 'gift_card' | 'employee' | 'discount' | 'other';
  remainingCents: number;
}

export interface LegacySourceFixture {
  customers: LegacyCustomer[];
  familyLinks: LegacyFamilyLink[];
  products: LegacyProduct[];
  seasons: LegacySeason[];
  levels: LegacyLevel[];
  teams: LegacyTeam[];
  rosterEntries: LegacyRosterEntry[];
  invoices: LegacyInvoice[];
  credits: LegacyCredit[];
}

export function legacySourceFixture(): LegacySourceFixture {
  return {
    customers: [
      {
        id: '1001',
        firstName: 'Dana',
        lastName: 'Okafor',
        birthDate: '1985-04-12',
        email: 'dana.okafor@example.test',
        phone: '(702) 555-0101',
        active: true,
        waiver: { version: 4, signedAt: '2024-08-19T23:10:00.000Z' },
      },
      {
        id: '1002',
        firstName: 'Milo',
        lastName: 'Okafor',
        birthDate: '2017-06-30',
        active: true,
        waiver: { version: 4, signedAt: '2024-08-19T23:12:00.000Z' },
      },
      {
        id: '1003',
        firstName: 'Ines',
        lastName: 'Okafor',
        birthDate: '2019-11-02',
        active: true,
        paperWaiverOn: '2023-01-14',
      },
      // Not a parent: allowed to collect the children.
      {
        id: '1004',
        firstName: 'Ruth',
        lastName: 'Adeyemi',
        birthDate: '1958-02-03',
        phone: '(702) 555-0104',
        active: true,
      },
      // The same adult entered a second time years later: same name and birth date, the email in
      // another case, a different telephone number.
      {
        id: '1482',
        firstName: 'Dana',
        lastName: 'Okafor',
        birthDate: '1985-04-12',
        email: 'Dana.Okafor@Example.test',
        phone: '(702) 555-0182',
        active: true,
      },
      // Two people with one name and different birth dates. Not a duplicate.
      {
        id: '2001',
        firstName: 'Sam',
        lastName: 'Rivera',
        birthDate: '1990-09-09',
        email: 'sam.rivera@example.test',
        active: true,
        waiver: { version: 3, signedAt: '2019-03-02T18:00:00.000Z' },
      },
      {
        id: '2002',
        firstName: 'Sam',
        lastName: 'Rivera',
        birthDate: '1979-01-23',
        email: 'srivera79@example.test',
        active: true,
      },
      // No birth date: common for adults entered at the desk.
      {
        id: '2003',
        firstName: 'Priya',
        lastName: 'Nair',
        email: 'priya.nair@example.test',
        active: true,
        waiver: { version: 2, signedAt: '2011-05-07T17:30:00.000Z' },
      },
      // A renter's player, on file only to sign the waiver.
      {
        id: '2004',
        firstName: 'Cole',
        lastName: 'Hart',
        birthDate: '2001-07-15',
        active: true,
        paperWaiverOn: '2026-09-05',
      },
      { id: '2005', firstName: 'Lena', lastName: 'Voss', birthDate: '1988-12-01', active: false },
    ],
    familyLinks: [
      { id: 'L1', customerId: '1001', relatedCustomerId: '1002', relation: 'child' },
      { id: 'L2', customerId: '1001', relatedCustomerId: '1003', relation: 'child' },
      { id: 'L3', customerId: '1002', relatedCustomerId: '1004', relation: 'authorized_adult' },
      { id: 'L4', customerId: '1003', relatedCustomerId: '1004', relation: 'authorized_adult' },
    ],
    products: [
      { id: 'P10', name: 'Pick-Up Game', section: 'Drop In Soccer', priceCents: 1_500 },
      { id: 'P11', name: 'Youth Jersey', section: 'Clothes', priceCents: 3_500 },
      // Open amounts rung up as 1.00 times a quantity.
      { id: 'P20', name: 'Indoor Rental Special', section: 'Field Rental', priceCents: 100 },
      { id: 'P21', name: 'Security Deposit', section: 'Field Rental', priceCents: 100 },
      { id: 'P22', name: 'Birthday Coach Tip', section: 'Birthday Parties', priceCents: 100 },
      // Discounts and refunds rung up as negative items.
      {
        id: 'P30',
        name: '2nd Class Sibling Discount',
        section: 'Kids Classes',
        priceCents: -1_500,
      },
      { id: 'P31', name: 'Class Voucher', section: 'Kids Classes', priceCents: -2_500 },
      { id: 'P32', name: 'Security Deposit Refund', section: 'Field Rental', priceCents: -100 },
    ],
    seasons: [
      {
        id: 'S900',
        name: 'Kids Classes Fall 2026',
        registrationType: 'class',
        startsOn: '2026-09-08',
        endsOn: '2026-11-14',
      },
      {
        id: 'S901',
        name: 'Adult League Coed Fall 2026',
        registrationType: 'league_team',
        startsOn: '2026-09-14',
        endsOn: '2026-11-23',
      },
      // Not a league: holds rental groups so that their players can sign the waiver.
      {
        id: 'S902',
        name: 'Indoor/Outdoor Rental Waiver List',
        registrationType: 'league_team',
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      },
      // Open play, with teams waiting for a league place parked in it.
      {
        id: 'S903',
        name: 'Open Play Oct.-Dec. 2026 + Waiting List Teams',
        registrationType: 'league_team',
        startsOn: '2026-10-01',
        endsOn: '2026-12-31',
      },
      {
        id: 'S904',
        name: 'First Responders Cup 2026',
        registrationType: 'league_team',
        startsOn: '2026-05-16',
        endsOn: '2026-05-17',
      },
      {
        id: 'S905',
        name: 'Youth Indoor League Fall 2026',
        registrationType: 'league_team',
        startsOn: '2026-09-12',
        endsOn: '2026-11-21',
      },
    ],
    levels: [
      { id: 'V1', seasonId: 'S900', name: 'Ages 5-6 Saturday 9:00', priceCents: 24_000 },
      { id: 'V2', seasonId: 'S901', name: 'Coed Monday', priceCents: 85_000 },
      { id: 'V3', seasonId: 'S902', name: 'Desert Lacrosse Club', priceCents: 0 },
      { id: 'V4', seasonId: 'S903', name: 'Waiting List', priceCents: 0 },
      // Tournament groups carry no price; the entry fee is taken another way.
      { id: 'V5', seasonId: 'S904', name: 'Group A', priceCents: 0 },
      { id: 'V6', seasonId: 'S904', name: 'Group B', priceCents: 0 },
      { id: 'V7', seasonId: 'S905', name: 'U8', priceCents: 12_000 },
    ],
    teams: [
      { id: 'T40001', levelId: 'V2', name: 'Monday Mayhem' },
      { id: 'T40002', levelId: 'V3', name: 'Desert Lacrosse Club' },
      { id: 'T40003', levelId: 'V4', name: 'Night Owls FC' },
      { id: 'T40004', levelId: 'V5', name: 'Station 12' },
      // A bucket for individually registered children and a jersey price, not a team.
      { id: 'T40005', levelId: 'V7', name: 'U8 Individual Player Red $35' },
    ],
    rosterEntries: [
      { id: 'R1', teamId: 'T40001', customerId: '2001' },
      { id: 'R2', teamId: 'T40001', customerId: '2003' },
      { id: 'R3', teamId: 'T40002', customerId: '2004' },
      { id: 'R4', teamId: 'T40003', customerId: '2002' },
      { id: 'R5', teamId: 'T40005', customerId: '1002' },
    ],
    invoices: [
      // Two children in a class with the sibling discount as a negative line; paid.
      {
        id: 'I7001',
        customerId: '1001',
        createdOn: '2026-08-19',
        status: 'paid',
        items: [
          { description: 'Kids Classes Fall 2026 - Milo', unitCents: 24_000, quantity: 1 },
          { description: 'Kids Classes Fall 2026 - Ines', unitCents: 24_000, quantity: 1 },
          {
            productId: 'P30',
            description: '2nd Class Sibling Discount',
            unitCents: -1_500,
            quantity: 1,
          },
        ],
        paidCents: 46_500,
      },
      // A rental rung up as 1.00 x 400 with a 1.00 x 200 deposit; part paid.
      {
        id: 'I7002',
        customerId: '2002',
        createdOn: '2026-10-03',
        status: 'open',
        items: [
          { productId: 'P20', description: 'Indoor Rental Special', unitCents: 100, quantity: 400 },
          { productId: 'P21', description: 'Security Deposit', unitCents: 100, quantity: 200 },
        ],
        paidCents: 20_000,
      },
      // The deposit handed back as a negative item on its own invoice.
      {
        id: 'I7003',
        customerId: '2002',
        createdOn: '2026-10-05',
        status: 'paid',
        items: [
          {
            productId: 'P32',
            description: 'Security Deposit Refund',
            unitCents: -100,
            quantity: 200,
          },
        ],
        paidCents: -20_000,
      },
      // A team fee still owed in full, recorded on the duplicate customer record.
      {
        id: 'I7004',
        customerId: '1482',
        createdOn: '2026-09-01',
        status: 'open',
        items: [
          {
            description: 'Adult League Coed Fall 2026 - Monday Mayhem',
            unitCents: 85_000,
            quantity: 1,
          },
        ],
        paidCents: 0,
      },
      {
        id: 'I5120',
        customerId: '2003',
        createdOn: '2011-05-07',
        status: 'paid',
        items: [{ productId: 'P10', description: 'Pick-Up Game', unitCents: 1_500, quantity: 1 }],
        paidCents: 1_500,
      },
    ],
    credits: [
      { id: 'K1', customerId: '1001', kind: 'other', remainingCents: 2_500 },
      { id: 'K2', customerId: '2003', kind: 'gift_card', remainingCents: 5_000 },
      { id: 'K3', customerId: '2005', kind: 'employee', remainingCents: 0 },
    ],
  };
}

/**
 * Where each oddity of the current system sits in the fixture, by source id, so that a test or an
 * import rule names the case it covers instead of rediscovering it.
 */
export const LEGACY_SOURCE_ODDITIES = {
  /** One person held as two customer records. */
  duplicateCustomers: [['1001', '1482']],
  /** Same name, different people: must never be merged on the name. */
  namesakes: [['2001', '2002']],
  customersWithoutBirthDate: ['2003'],
  paperWaiverCustomers: ['1003', '2004'],
  /** Waiver versions older than the current one, never re-accepted. */
  staleWaiverCustomers: ['2001', '2003'],
  openAmountProducts: ['P20', 'P21', 'P22'],
  negativeProducts: ['P30', 'P31', 'P32'],
  rentalWaiverListSeasons: ['S902'],
  waitingListSeasons: ['S903'],
  zeroPriceTournamentLevels: ['V5', 'V6'],
  jerseyBucketTeams: ['T40005'],
  /** An invoice whose total is below zero because a refund was rung up as a negative item. */
  negativeInvoices: ['I7003'],
  /** A spent credit left on a customer who is no longer active. */
  creditsOnInactiveCustomers: ['K3'],
} as const;

export function legacyInvoiceTotalCents(invoice: LegacyInvoice): number {
  return invoice.items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
}

/** A source record the staging contract cannot carry yet, and why. */
export interface UnmappedLegacyRecord {
  kind: keyof LegacySourceFixture;
  id: string;
  reason: string;
}

export interface LegacyStagingResult {
  rows: StagedRow[];
  unmapped: UnmappedLegacyRecord[];
}

const NEEDS_COMPETITION =
  'A staged season names a SportsPark competition and rule set, which are configuration the facility has not supplied (DEC-001, DEC-002).';

/**
 * Proposed transformation of the fixture into neutral staging rows (`staging-v1`). Every source
 * record becomes at least one row or is returned as unmapped with a reason; nothing is dropped.
 * It applies no identity resolution: two customer records stay two people.
 */
export function legacySourceToStaging(
  source: LegacySourceFixture,
  options: { dueAt: string },
): LegacyStagingResult {
  const rows: StagedRow[] = [];
  const unmapped: UnmappedLegacyRecord[] = [];
  const person = (id: string): string => `customer:${id}`;
  const byId = new Map(source.customers.map((c) => [c.id, c]));

  for (const c of source.customers) {
    rows.push({
      entityType: 'person',
      externalId: person(c.id),
      payload: {
        givenName: c.firstName,
        familyName: c.lastName,
        // A missing birth date is not invented; such a record is an adult entered at the desk.
        ...(c.birthDate ? { dateOfBirth: c.birthDate } : { kind: 'adult' }),
        ...(c.email ? { email: c.email } : {}),
        ...(c.phone ? { phone: c.phone } : {}),
        status: c.active ? 'active' : 'inactive',
      },
    });
    if (c.waiver) {
      rows.push({
        entityType: 'document',
        externalId: `waiver:${c.id}:v${c.waiver.version}`,
        payload: {
          documentKind: 'waiver',
          personExternalId: person(c.id),
          medium: 'digital',
          version: c.waiver.version,
          signedAt: c.waiver.signedAt,
        },
      });
    }
    if (c.paperWaiverOn) {
      rows.push({
        entityType: 'document',
        externalId: `waiver:${c.id}:paper`,
        payload: {
          documentKind: 'waiver',
          personExternalId: person(c.id),
          medium: 'paper',
          signedOn: c.paperWaiverOn,
        },
      });
    }
  }

  const childrenOf = new Map<string, string[]>();
  for (const link of source.familyLinks) {
    if (link.relation === 'child') {
      childrenOf.set(link.customerId, [
        ...(childrenOf.get(link.customerId) ?? []),
        link.relatedCustomerId,
      ]);
      rows.push({
        entityType: 'relationship_evidence',
        externalId: `family-link:${link.id}`,
        payload: {
          actorExternalId: person(link.customerId),
          subjectExternalId: person(link.relatedCustomerId),
          kind: 'guardian',
          permissions: ['view', 'register', 'pay', 'receive_messages', 'complete_forms'],
          basis: 'documented',
        },
      });
    } else {
      unmapped.push({
        kind: 'familyLinks',
        id: link.id,
        reason:
          link.relation === 'authorized_adult'
            ? 'Which permissions an authorized adult holds is an operator decision (questionnaire E3, DEC-005).'
            : 'A partner link grants no authority over a person and has no staged record kind.',
      });
    }
  }
  for (const [parentId, children] of childrenOf) {
    rows.push({
      entityType: 'household',
      externalId: `family:${parentId}`,
      payload: {
        name: `${byId.get(parentId)?.lastName ?? parentId} household`,
        memberExternalIds: [parentId, ...children].map(person),
      },
    });
  }

  for (const invoice of source.invoices) {
    const totalCents = legacyInvoiceTotalCents(invoice);
    rows.push({
      entityType: 'order',
      externalId: `invoice:${invoice.id}`,
      payload: {
        totalMinor: totalCents,
        currency: 'USD',
        customerExternalId: person(invoice.customerId),
        createdOn: invoice.createdOn,
        paidMinor: invoice.paidCents,
        items: invoice.items,
      },
    });
    const owedCents = totalCents - invoice.paidCents;
    if (owedCents !== 0) {
      rows.push({
        entityType: 'open_obligation',
        externalId: `invoice-balance:${invoice.id}`,
        payload: {
          debtorExternalId: person(invoice.customerId),
          amountMinor: owedCents,
          currency: 'USD',
          dueAt: options.dueAt,
          description: `Balance of invoice ${invoice.id}`,
          originalAmountMinor: totalCents,
          paidMinor: invoice.paidCents,
        },
      });
    }
  }

  for (const credit of source.credits) {
    rows.push({
      entityType: 'credit',
      externalId: `credit:${credit.id}`,
      payload: {
        ownerExternalId: person(credit.customerId),
        amountMinor: credit.remainingCents,
        currency: 'USD',
        sourceKind: credit.kind,
      },
    });
  }

  for (const p of source.products) {
    unmapped.push({
      kind: 'products',
      id: p.id,
      reason:
        'Register products are not a §5.3 inventory line; the product list is set up in SportsPark (questionnaire G1, H1).',
    });
  }
  for (const s of source.seasons)
    unmapped.push({ kind: 'seasons', id: s.id, reason: NEEDS_COMPETITION });
  for (const l of source.levels)
    unmapped.push({ kind: 'levels', id: l.id, reason: NEEDS_COMPETITION });
  for (const t of source.teams)
    unmapped.push({ kind: 'teams', id: t.id, reason: NEEDS_COMPETITION });
  for (const r of source.rosterEntries)
    unmapped.push({ kind: 'rosterEntries', id: r.id, reason: NEEDS_COMPETITION });

  return { rows, unmapped };
}
