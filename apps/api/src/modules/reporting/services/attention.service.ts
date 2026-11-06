import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  type AttentionCounts,
  type NavigationAreaId,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CLOCK, type Clock } from '../../../kernel';
import { NotificationsService } from '../../communications';
import { ApplicationsService } from '../../enrollment';
import { MoneyReadsService } from '../../finance';
import { CasesService, ExceptionsService } from '../../support';
import { iso } from '../reporting.shared';

/** Each area counts at most this many items (the sidebar pill shows "99+" beyond). */
export const ATTENTION_CAP = 99;

/** Refusals that mean "the viewer may not read this list": the area is left out, not zero. */
const NOT_READABLE = new Set(['ACCESS_DENIED', 'NOT_FOUND', 'AUTHENTICATION_REQUIRED']);

interface AreaSource {
  area: NavigationAreaId;
  counts: string;
  read: (principal: Principal, limit: number) => Promise<Array<Page<unknown>>>;
}

/**
 * Sidebar attention counts (park UI redesign "live counts in the sidebar"; SPK-UX-005,
 * SPK-UX-006). One read that asks each owning module's exported list service, with the viewer's
 * own principal, for the first page of the items that wait for someone in the viewer's role:
 *
 * - today: operational exceptions still `open` (not yet acknowledged) in the viewer's queues;
 * - registrations: applications awaiting review;
 * - finance: payment and refund attempts whose outcome is unknown (SPK-PAY-007);
 * - communications: composed notices not yet sent;
 * - admin: open support cases the viewer owns.
 *
 * Nothing is computed from another module's tables (§4.2): each list applies its own
 * authorization and facility scope, so a count never includes a record the viewer could not open.
 * A list the viewer may not read leaves its area out. Reads only; counts are capped.
 */
@Injectable()
export class AttentionService {
  private readonly sources: readonly AreaSource[];

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    exceptions: ExceptionsService,
    applications: ApplicationsService,
    money: MoneyReadsService,
    notifications: NotificationsService,
    cases: CasesService,
  ) {
    this.sources = [
      {
        area: 'today',
        counts: 'open exceptions',
        read: async (p, limit) => [await exceptions.list(p, { limit, status: 'open' })],
      },
      {
        area: 'registrations',
        counts: 'applications awaiting review',
        read: async (p, limit) => [
          await applications.list(p, { limit, status: 'awaiting_review' }),
        ],
      },
      {
        area: 'finance',
        counts: 'unknown payment and refund outcomes',
        read: async (p, limit) => [
          await money.listPayments(p, { limit, status: 'unknown' }),
          await money.listRefunds(p, { limit, status: 'unknown' }),
        ],
      },
      {
        area: 'communications',
        counts: 'notices composed and not sent',
        read: async (p, limit) => [await notifications.list(p, { limit, status: 'composed' })],
      },
      {
        area: 'admin',
        counts: 'open support cases you own',
        read: async (p, limit) =>
          p.personId
            ? [await cases.list(p, { limit, status: 'open', ownerPersonId: p.personId })]
            : [],
      },
    ];
  }

  async counts(principal: Principal): Promise<AttentionCounts> {
    const areas: AttentionCounts['areas'] = [];
    for (const source of this.sources) {
      let pages: Array<Page<unknown>>;
      try {
        pages = await source.read(principal, ATTENTION_CAP + 1);
      } catch (error) {
        if (DomainError.is(error) && NOT_READABLE.has(error.code)) continue;
        if (DomainError.is(error) && error.code === 'VALIDATION_FAILED') continue;
        throw error;
      }
      if (pages.length === 0) continue;
      const total = pages.reduce((sum, page) => sum + page.items.length, 0);
      const more = pages.some((page) => page.nextCursor !== null);
      const capped = total > ATTENTION_CAP || more;
      areas.push({
        area: source.area,
        count: Math.min(total, ATTENTION_CAP),
        capped,
        counts: source.counts,
      });
    }
    return { computedAt: iso(this.clock.now()), cap: ATTENTION_CAP, areas };
  }
}
