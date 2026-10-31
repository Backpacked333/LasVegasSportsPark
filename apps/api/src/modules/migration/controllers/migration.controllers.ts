import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AbortImportBatchBody,
  AppendImportRowsBody,
  ApplyImportBatchBody,
  ApproveReconciliationBody,
  AuthorityMatrixQuery,
  CreateAuthorityAssignmentBody,
  CreateImportBatchBody,
  DecideImportExceptionBody,
  EndAuthorityAssignmentBody,
  GenerateReconciliationBody,
  ListAuthorityAssignmentsQuery,
  ListExternalMappingsQuery,
  ListImportBatchesQuery,
  ListImportExceptionsQuery,
  ListImportRowsQuery,
  ReviewImportBatchBody,
  ValidateImportBatchBody,
  z,
  type AuthorityAssignment,
  type AuthorityMatrix,
  type ExternalMapping,
  type ImportBatch,
  type ImportException,
  type ImportRow,
  type MigrationReconciliationReport,
  type MigrationReconciliationReportList,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { AuthorityService } from '../services/authority.service';
import { ExternalMappingsService } from '../services/external-mappings.service';
import { ImportApplyService } from '../services/import-apply.service';
import { ImportBatchesService } from '../services/import-batches.service';
import { ImportExceptionsService } from '../services/import-exceptions.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/** Import batches (§5.3, §5.4, SPK-AT-024). Every consequential POST is idempotent (§4.9). */
@Controller('import-batches')
export class ImportBatchesController {
  constructor(
    private readonly batches: ImportBatchesService,
    private readonly applies: ImportApplyService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Post()
  @Idempotent()
  stage(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateImportBatchBody) body: z.infer<typeof CreateImportBatchBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.batches.stage(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListImportBatchesQuery) query: ListImportBatchesQuery,
  ): Promise<Page<ImportBatch>> {
    return this.batches.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<ImportBatch> {
    return this.batches.get(principal, params.id);
  }

  @Post(':id/rows')
  @HttpCode(200)
  @Idempotent()
  append(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AppendImportRowsBody) body: z.infer<typeof AppendImportRowsBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.batches.append(principal, params.id, body, correlationId);
  }

  @Get(':id/rows')
  rows(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodQuery(ListImportRowsQuery) query: ListImportRowsQuery,
  ): Promise<Page<ImportRow>> {
    return this.batches.rows(principal, params.id, query);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @Idempotent()
  validate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ValidateImportBatchBody) body: z.infer<typeof ValidateImportBatchBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.batches.validate(principal, params.id, body, correlationId);
  }

  @Post(':id/review')
  @HttpCode(200)
  @Idempotent()
  review(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ReviewImportBatchBody) body: z.infer<typeof ReviewImportBatchBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.batches.review(principal, params.id, body, correlationId);
  }

  @Post(':id/apply')
  @HttpCode(200)
  @Idempotent()
  apply(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ApplyImportBatchBody) body: z.infer<typeof ApplyImportBatchBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.applies.apply(principal, params.id, body, correlationId);
  }

  @Post(':id/abort')
  @HttpCode(200)
  @Idempotent()
  abort(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AbortImportBatchBody) body: z.infer<typeof AbortImportBatchBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.batches.abort(principal, params.id, body, correlationId);
  }

  @Post(':id/reconciliation-reports')
  @Idempotent()
  reconcile(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(GenerateReconciliationBody) body: z.infer<typeof GenerateReconciliationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MigrationReconciliationReport> {
    return this.reconciliation.generate(principal, params.id, body, correlationId);
  }

  @Get(':id/reconciliation-reports')
  reports(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<MigrationReconciliationReportList> {
    return this.reconciliation.listForBatch(principal, params.id);
  }
}

/** Reconciliation reports (§5.5). */
@Controller('import-reconciliation-reports')
export class ReconciliationReportsController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<MigrationReconciliationReport> {
    return this.reconciliation.get(principal, params.id);
  }

  @Post(':id/approvals')
  @HttpCode(200)
  @Idempotent()
  decide(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ApproveReconciliationBody) body: z.infer<typeof ApproveReconciliationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MigrationReconciliationReport> {
    return this.reconciliation.decide(principal, params.id, body, correlationId);
  }
}

/** Import review queues (§5.4). */
@Controller('import-exceptions')
export class ImportExceptionsController {
  constructor(private readonly exceptions: ImportExceptionsService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListImportExceptionsQuery) query: ListImportExceptionsQuery,
  ): Promise<Page<ImportException>> {
    return this.exceptions.list(principal, query);
  }

  @Post(':id/decide')
  @HttpCode(200)
  @Idempotent()
  decide(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(DecideImportExceptionBody) body: z.infer<typeof DecideImportExceptionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ImportException> {
    return this.exceptions.decide(principal, params.id, body, correlationId);
  }
}

/** External identifier lookup (§5.3). */
@Controller('external-mappings')
export class ExternalMappingsController {
  constructor(private readonly mappings: ExternalMappingsService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListExternalMappingsQuery) query: ListExternalMappingsQuery,
  ): Promise<Page<ExternalMapping>> {
    return this.mappings.list(principal, query);
  }
}

/** Authority matrix (§5.6, §4.7 invariant 11). */
@Controller()
export class AuthorityController {
  constructor(private readonly authority: AuthorityService) {}

  @Get('authority-assignments')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAuthorityAssignmentsQuery) query: ListAuthorityAssignmentsQuery,
  ): Promise<Page<AuthorityAssignment>> {
    return this.authority.list(principal, query);
  }

  @Get('authority-assignments/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<AuthorityAssignment> {
    return this.authority.get(principal, params.id);
  }

  @Post('authority-assignments')
  @Idempotent()
  assign(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAuthorityAssignmentBody) body: z.infer<typeof CreateAuthorityAssignmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AuthorityAssignment> {
    return this.authority.assign(principal, body, correlationId);
  }

  @Post('authority-assignments/:id/end')
  @HttpCode(200)
  @Idempotent()
  end(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(EndAuthorityAssignmentBody) body: z.infer<typeof EndAuthorityAssignmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AuthorityAssignment> {
    return this.authority.end(principal, params.id, body, correlationId);
  }

  @Get('authority-matrix')
  matrix(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(AuthorityMatrixQuery) query: AuthorityMatrixQuery,
  ): Promise<AuthorityMatrix> {
    return this.authority.matrix(principal, query);
  }
}
