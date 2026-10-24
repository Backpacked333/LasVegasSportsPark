import { Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { UnitOfWork, type Trx } from '../../../kernel';
import { PeopleService } from '../../identity';
import type { ExternalChannel } from '../ports';

/**
 * Resolves where an external channel reaches a person, immediately before the provider call:
 * contact points stay owned by identity (read through its exported service, never its tables) and
 * are never copied onto delivery attempts. Push has no device registry yet (no app build, Package E),
 * so the handle is the person id and the fake push provider addresses by it; a real adapter maps a
 * registered device token here.
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
  ): Promise<string | null> {
    if (channel === 'push') return `person:${personId}`;
    let contactPoints: Array<{
      kind: string;
      value: string;
      isPrimary: boolean;
      verifiedAt: string | null;
    }>;
    try {
      contactPoints = (await this.people.detail(db ?? this.uow.reader(), organizationId, personId))
        .contactPoints;
    } catch {
      return null;
    }
    const kind = channel === 'email' ? 'email' : 'phone';
    const candidates = contactPoints.filter((c) => c.kind === kind);
    const pick =
      candidates.find((c) => c.isPrimary && c.verifiedAt !== null) ??
      candidates.find((c) => c.isPrimary) ??
      candidates.find((c) => c.verifiedAt !== null) ??
      candidates[0];
    return pick?.value ?? null;
  }
}
