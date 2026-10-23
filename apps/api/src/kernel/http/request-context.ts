import type { Principal } from '@sportspark/contracts';
import type { Request } from 'express';

export interface RequestWithContext extends Request {
  correlationId: string;
  principal?: Principal;
}
