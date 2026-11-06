import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AcceptStaffInvitationBody,
  CreateStaffInvitationBody,
  ListStaffAccessReviewsQuery,
  ListStaffInvitationsQuery,
  RecordCareNoteBody,
  RecordStaffAccessReviewBody,
  RetireCareNoteBody,
  RevokeStaffInvitationBody,
  z,
  type CareNote,
  type Page,
  type PersonCareNotes,
  type Principal,
  type StaffAccessReview,
  type StaffAccessSummary,
  type StaffInvitation,
  type StaffInvitationAccepted,
  type StaffInvitationIssued,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { CareNotesService } from '../services/care-notes.service';
import { StaffAccessService } from '../services/staff-access.service';

const IdParams = z.object({ id: z.uuid() });

/** Operational care notes (migration 0181; §1.7, §4.14, SPK-DISC-005). */
@Controller()
export class CareNotesController {
  constructor(private readonly notes: CareNotesService) {}

  /** Every read that returns a note is audited (§4.14). */
  @Get('people/:id/care-notes')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PersonCareNotes> {
    return this.notes.list(principal, params.id, correlationId);
  }

  @Post('people/:id/care-notes')
  @NoRecordAuthority('Operational care note, not a §5.3 record category')
  @Idempotent()
  record(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecordCareNoteBody) body: z.infer<typeof RecordCareNoteBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CareNote> {
    return this.notes.record(principal, params.id, body, correlationId);
  }

  @Post('care-notes/:id/retire')
  @NoRecordAuthority('Operational care note, not a §5.3 record category')
  @HttpCode(200)
  @Idempotent()
  retire(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetireCareNoteBody) body: z.infer<typeof RetireCareNoteBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CareNote> {
    return this.notes.retire(principal, params.id, body, correlationId);
  }
}

/** Staff access reviews and staff invitations (migration 0181; §2.1, §4.14, SPK-IAM-004). */
@Controller()
export class StaffAccessController {
  constructor(private readonly access: StaffAccessService) {}

  @Post('staff-access-reviews')
  @NoRecordAuthority('Staff access administration, not a §5.3 record category')
  @Idempotent()
  recordReview(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordStaffAccessReviewBody) body: z.infer<typeof RecordStaffAccessReviewBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<StaffAccessReview> {
    return this.access.recordReview(principal, body, correlationId);
  }

  @Get('staff-access-reviews')
  listReviews(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListStaffAccessReviewsQuery) query: z.infer<typeof ListStaffAccessReviewsQuery>,
  ): Promise<Page<StaffAccessReview>> {
    return this.access.listReviews(principal, query);
  }

  @Get('staff-access-summary')
  summary(@CurrentPrincipal() principal: Principal): Promise<StaffAccessSummary> {
    return this.access.summary(principal);
  }

  /** The token is returned once and never stored with the idempotency key (§4.14). */
  @Post('staff-invitations')
  @NoRecordAuthority('Staff access administration, not a §5.3 record category')
  @Idempotent({ withhold: ['token'] })
  createInvitation(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateStaffInvitationBody) body: z.infer<typeof CreateStaffInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<StaffInvitationIssued> {
    return this.access.createInvitation(principal, body, correlationId);
  }

  @Get('staff-invitations')
  listInvitations(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListStaffInvitationsQuery) query: z.infer<typeof ListStaffInvitationsQuery>,
  ): Promise<Page<StaffInvitation>> {
    return this.access.listInvitations(principal, query);
  }

  @Post('staff-invitations/:id/accept')
  @NoRecordAuthority('Staff access administration, not a §5.3 record category')
  @HttpCode(200)
  @Idempotent()
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AcceptStaffInvitationBody) body: z.infer<typeof AcceptStaffInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<StaffInvitationAccepted> {
    return this.access.acceptInvitation(principal, params.id, body, correlationId);
  }

  @Post('staff-invitations/:id/revoke')
  @NoRecordAuthority('Staff access administration, not a §5.3 record category')
  @HttpCode(200)
  @Idempotent()
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokeStaffInvitationBody) body: z.infer<typeof RevokeStaffInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<StaffInvitation> {
    return this.access.revokeInvitation(principal, params.id, body, correlationId);
  }
}
