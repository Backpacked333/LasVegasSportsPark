import { Injectable } from '@nestjs/common';
import { errors, type OfferingSession } from '@sportspark/contracts';
import { currentTransaction } from '../../../kernel';
import { SessionsService } from '../../catalog';
import { enrollmentSystem } from '../enrollment.shared';

/**
 * Reads catalog sessions through the catalog module's exported service (§4.2: enrollment never
 * queries catalog tables). The catalog service reads through the root database, so this reader
 * must run before or after a command's transaction, never inside it: under PGlite a root read
 * inside an open transaction waits for the only connection. The guard below turns that mistake
 * into an immediate error instead of a timeout.
 */
@Injectable()
export class CatalogSessions {
  constructor(private readonly sessions: SessionsService) {}

  async list(organizationId: string, offeringId: string): Promise<OfferingSession[]> {
    if (currentTransaction()) {
      throw errors.internal('catalog sessions must be read outside the command transaction');
    }
    // Enrollment has already authorized its own command; the catalog read is organization-scoped.
    return this.sessions.list(
      enrollmentSystem(organizationId, 'enrollment.catalog_read'),
      offeringId,
    );
  }

  /** The named session of the offering; NOT_FOUND when it does not belong to that offering. */
  async get(
    organizationId: string,
    offeringId: string,
    sessionId: string,
  ): Promise<OfferingSession> {
    const session = (await this.list(organizationId, offeringId)).find((s) => s.id === sessionId);
    if (!session) throw errors.notFound('offering_session', sessionId);
    return session;
  }

  /** Sessions keyed by id for a set of (offering, session) pairs. */
  async many(
    organizationId: string,
    pairs: ReadonlyArray<{ offeringId: string; sessionId: string | null }>,
  ): Promise<Map<string, OfferingSession>> {
    const out = new Map<string, OfferingSession>();
    const offerings = [...new Set(pairs.filter((p) => p.sessionId).map((p) => p.offeringId))];
    for (const offeringId of offerings) {
      for (const session of await this.list(organizationId, offeringId))
        out.set(session.id, session);
    }
    return out;
  }
}
