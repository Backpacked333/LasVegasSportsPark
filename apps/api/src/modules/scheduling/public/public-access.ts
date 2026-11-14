import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  DomainError,
  PublicCode,
  PublicOrganizationSlug,
  z,
  type PublicScore,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { CapabilityService, Trx } from '../../../kernel';

/**
 * What every public read shares (SPK-SCHED-010, proposed amendment PA-06, ADR-005): the one
 * "not available" answer, the resolution of an organization from its slug, the random public
 * codes, the cache lifetime, and the registry through which the module that owns a source of
 * schedule events vouches for a title the system generated.
 */

/** Seconds a shared cache may keep a public answer (a technical value; a lobby re-reads sooner). */
export const PUBLIC_CACHE_SECONDS = 30;
export const PUBLIC_CACHE_CONTROL = `public, max-age=${PUBLIC_CACHE_SECONDS}`;

/**
 * Marks a successful public answer as cacheable for a short time. Called after the read has
 * succeeded, so a "not available" or rate-limited answer keeps the API's `no-store`.
 */
export function allowPublicCache(response: { setHeader(name: string, value: string): unknown }) {
  response.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
}

/**
 * The single answer of a public route with nothing to show: an unknown organization, an unknown
 * or disabled code, a competition that is not public and the capability turned off are
 * indistinguishable, so a caller learns nothing about what exists (ADR-005 "fail closed").
 */
export function publicViewNotAvailable(): DomainError {
  return new DomainError('NOT_FOUND', 'This view is not available.', {
    details: { code: 'PUBLIC_VIEW_NOT_AVAILABLE' },
  });
}

/**
 * The path parameters of a public route. They are accepted as any text and checked here, so a
 * value that is not shaped like a slug or a code gets the same "not available" as an unknown one,
 * never a validation message that describes the shape of a code.
 */
export const PublicAddressParams = z.object({ organization: z.string(), code: z.string() });
export type PublicAddress = z.infer<typeof PublicAddressParams>;

export function assertPublicAddress(address: PublicAddress): PublicAddress {
  if (
    !PublicOrganizationSlug.safeParse(address.organization).success ||
    !PublicCode.safeParse(address.code).success
  ) {
    throw publicViewNotAvailable();
  }
  return address;
}

/** A new random public code: 24 lower-case hexadecimal characters (96 random bits). */
export function newPublicCode(): string {
  return randomBytes(12).toString('hex');
}

export interface PublicOrganization {
  id: string;
  name: string;
  slug: string;
}

/**
 * The active organization a public slug names, only while it has public views turned on
 * (`public_schedule`). Anything else is "not available".
 */
export async function resolvePublicOrganization(
  db: Db | Trx,
  capabilities: Pick<CapabilityService, 'isEnabled'>,
  slug: string,
): Promise<PublicOrganization> {
  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'name', 'slug'])
    .where('slug', '=', slug)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!organization) throw publicViewNotAvailable();
  if (!(await capabilities.isEnabled(organization.id, 'public_schedule', db))) {
    throw publicViewNotAvailable();
  }
  return organization;
}

/** A published schedule event as a title contributor sees it. */
export interface PublicEventRef {
  eventId: string;
  sourceType: string | null;
  sourceId: string | null;
}

/** A title the owning module generated for an event, and the official score of a game. */
export interface PublicEventTitle {
  title: string;
  score: PublicScore | null;
}

export type PublicScheduleTitleContributor = (
  db: Db | Trx,
  organizationId: string,
  events: readonly PublicEventRef[],
) => Promise<Map<string, PublicEventTitle>>;

/**
 * Titles for the public schedule. The schedule never shows the title stored on an event, because
 * a person may have typed it (a renter's name, a child's name). The module that owns an event's
 * source registers a contributor and answers, for the events it recognizes, a title the system
 * generated: competition answers the team names of a game of a public competition. An event no
 * contributor answers for shows its kind in words.
 */
@Injectable()
export class PublicScheduleTitles {
  private readonly contributors = new Map<string, PublicScheduleTitleContributor>();

  register(name: string, contributor: PublicScheduleTitleContributor): void {
    if (this.contributors.has(name)) {
      throw new Error(`public schedule title contributor ${name} already registered`);
    }
    this.contributors.set(name, contributor);
  }

  async collect(
    db: Db | Trx,
    organizationId: string,
    events: readonly PublicEventRef[],
  ): Promise<Map<string, PublicEventTitle>> {
    const out = new Map<string, PublicEventTitle>();
    if (events.length === 0) return out;
    const known = new Set(events.map((event) => event.eventId));
    for (const contributor of this.contributors.values()) {
      for (const [eventId, title] of await contributor(db, organizationId, events)) {
        // A contribution only names events of this read, and the first contributor wins.
        if (known.has(eventId) && !out.has(eventId)) out.set(eventId, title);
      }
    }
    return out;
  }
}
