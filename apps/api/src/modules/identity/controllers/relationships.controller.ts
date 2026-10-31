import { Controller, HttpCode, Post } from '@nestjs/common';
import {
  CreateAccessGrantBody,
  CreateRelationshipBody,
  RevokeAccessGrantBody,
  z,
  type AccessGrant,
  type Principal,
  type Relationship,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { RelationshipsService } from '../services/relationships.service';

const IdParams = z.object({ id: z.uuid() });

@Controller()
export class RelationshipsController {
  constructor(private readonly relationships: RelationshipsService) {}

  @Post('relationships')
  @Idempotent()
  createRelationship(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateRelationshipBody) body: z.infer<typeof CreateRelationshipBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<{ relationship: Relationship; grants: AccessGrant[] }> {
    return this.relationships.createRelationship(principal, body, correlationId);
  }

  @Post('access-grants')
  @Idempotent()
  grant(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAccessGrantBody) body: z.infer<typeof CreateAccessGrantBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccessGrant> {
    return this.relationships.grantAccess(principal, body, correlationId);
  }

  @Post('access-grants/:id/revoke')
  @HttpCode(200)
  @Idempotent()
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokeAccessGrantBody) body: z.infer<typeof RevokeAccessGrantBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccessGrant> {
    return this.relationships.revokeGrant(principal, params.id, body, correlationId);
  }
}
