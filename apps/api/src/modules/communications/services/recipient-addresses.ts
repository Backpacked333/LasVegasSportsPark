import { Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { UnitOfWork, type Trx } from '../../../kernel';
import { PeopleService } from '../../identity';
import type { ExternalChannel } from '../ports';

/**
 * Resolves where an external channel reaches a person, immediately before the provider call.
 * Email and SMS: contact points stay owned by identity (read through its exported service, never
 * its tables) and are never copied onto delivery attempts; one address. Push (COM-01, SPK-UX-001):
 * every active device the person registered (this module's `push_devices`); a revoked device is
 * never addressed, and a person with no active device has no push address (the attempt fails with
 * NO_ADDRESS). An empty list means "no address".
 */
@Injectable()
export class RecipientAddresses {
  constructor(
    private readonly people: PeopleService,
    private readonly uow: UnitOfWork,
  ) {}

  async resolve(
    organizationId: string,
    personId: string,
    channel: ExternalChannel,
    db?: Db | Trx,
  ): Promise<string[]> {
    const reader = db ?? this.uow.reader();
    if (channel === 'push') {
      const devices = await reader
        .selectFrom('push_devices')
        .select('token')
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', personId)
        .where('status', '=', 'active')
        .orderBy('registered_at')
        .orderBy('id')
        .execute();
      return devices.map((d) => d.token).filter((t): t is string => t !== null);
    }
    let contactPoints: Array<{
      kind: string;
      value: string;
      isPrimary: boolean;
      verifiedAt: string | null;
    }>;
    try {
      contactPoints = (await this.people.detail(reader, organizationId, personId)).contactPoints;
    } catch {
      return [];
    }
    const kind = channel === 'email' ? 'email' : 'phone';
    const candidates = contactPoints.filter((c) => c.kind === kind);
    const pick =
      candidates.find((c) => c.isPrimary && c.verifiedAt !== null) ??
      candidates.find((c) => c.isPrimary) ??
      candidates.find((c) => c.verifiedAt !== null) ??
      candidates[0];
    return pick ? [pick.value] : [];
  }
}
