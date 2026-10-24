import { Controller, Get, Headers, HttpCode, Post, Res } from '@nestjs/common';
import {
  CreateExportBody,
  EXPORT_TOKEN_HEADER,
  RevokeExportBody,
  z,
  type Principal,
  type ReportExport,
  type ReportExportCreated,
} from '@sportspark/contracts';
import type { Response } from 'express';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { ExportsService } from '../services/exports.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/** Exports of stored runs (SPK-REPORT-007, §4.14). Every consequential POST is idempotent (§4.9). */
@Controller('reports/exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateExportBody) body: z.infer<typeof CreateExportBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ReportExportCreated> {
    return this.exports.create(principal, body, correlationId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<ReportExport> {
    return this.exports.get(principal, params.id);
  }

  /** Single-use download; the response is the file itself (never cached). */
  @Get(':id/download')
  async download(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @Headers(EXPORT_TOKEN_HEADER) token: string | undefined,
    @CorrelationId() correlationId: string | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const download = await this.exports.download(principal, params.id, token, correlationId);
    response.setHeader('Content-Type', download.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Report-As-Of', download.asOf);
    response.setHeader('X-Report-Run-Id', download.reportRunId);
    return download.content;
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @Idempotent()
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(RevokeExportBody) body: z.infer<typeof RevokeExportBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ReportExport> {
    return this.exports.revoke(principal, params.id, body, correlationId);
  }
}
