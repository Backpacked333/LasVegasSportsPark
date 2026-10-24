import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  AccessControlEventBody,
  AttendanceQuery,
  CorrectAttendanceObservationBody,
  errors,
  OccupancyQuery,
  OfflineSyncBody,
  RecordAttendanceObservationBody,
  RecordReleaseBody,
  TakeOccupancySnapshotBody,
  z,
  type ActivityAttendance,
  type Occupancy,
  type OccupancySnapshot,
  type OfflineSyncBatch,
  type Principal,
  type RecordedObservation,
  type RecordedRelease,
  type ReleaseRecord,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  CurrentPrincipal,
  DATABASE,
  Idempotent,
  Inbox,
  Public,
  ZodBody,
  ZodParams,
  ZodQuery,
  ZodValidationPipe,
} from '../../../kernel';
import {
  FAKE_ACCESS_CONTROL_PROVIDER,
  FAKE_ACCESS_CONTROL_SIGNATURE_HEADER,
  FakeAccessControlProvider,
} from '../providers/fake-access-control.provider';
import { AttendanceService } from '../services/attendance.service';
import { OccupancyService } from '../services/occupancy.service';
import { OfflineSyncService } from '../services/offline-sync.service';
import { ReleasesService } from '../services/releases.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Attendance observations (§4.8 POST /v1/attendance-observations, SPK-ENTRY-005). */
@Controller()
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('attendance-observations')
  @Idempotent()
  record(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordAttendanceObservationBody) body: RecordAttendanceObservationBody,
    @CorrelationId() correlationId: string,
  ): Promise<RecordedObservation> {
    return this.attendance.record(principal, body, correlationId);
  }

  @Post('attendance-observations/:id/corrections')
  @Idempotent()
  correct(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CorrectAttendanceObservationBody) body: CorrectAttendanceObservationBody,
    @CorrelationId() correlationId: string,
  ): Promise<RecordedObservation> {
    return this.attendance.correct(principal, params.id, body, correlationId);
  }

  @Get('attendance')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(AttendanceQuery) query: AttendanceQuery,
  ): Promise<ActivityAttendance> {
    return this.attendance.attendance(principal, query);
  }
}

/** Supervised release (§4.8 POST /v1/releases, SPK-ENTRY-007). */
@Controller('releases')
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Post()
  @Idempotent()
  record(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordReleaseBody) body: RecordReleaseBody,
    @CorrelationId() correlationId: string,
  ): Promise<RecordedRelease> {
    return this.releases.record(principal, body, correlationId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ReleaseRecord> {
    return this.releases.get(principal, params.id);
  }
}

/** Offline synchronization (§4.15, SPK-AT-018). */
@Controller('offline-sync')
export class OfflineSyncController {
  constructor(private readonly sync: OfflineSyncService) {}

  @Post()
  @Idempotent()
  upload(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(OfflineSyncBody) body: OfflineSyncBody,
    @CorrelationId() correlationId: string,
  ): Promise<OfflineSyncBatch> {
    return this.sync.sync(principal, body, correlationId);
  }
}

/** Occupancy (SPK-ENTRY-008). */
@Controller('facilities')
export class OccupancyController {
  constructor(private readonly occupancy: OccupancyService) {}

  @Get(':id/occupancy')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(OccupancyQuery) query: OccupancyQuery,
  ): Promise<Occupancy> {
    return this.occupancy.get(principal, params.id, query);
  }

  @Post(':id/occupancy-snapshots')
  @Idempotent()
  snapshot(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(TakeOccupancySnapshotBody) body: TakeOccupancySnapshotBody,
    @CorrelationId() correlationId: string,
  ): Promise<OccupancySnapshot> {
    return this.occupancy.snapshot(principal, params.id, body, correlationId);
  }
}

const accessEventPipe = new ZodValidationPipe(AccessControlEventBody);

/**
 * Access hardware webhooks (§4.11 pattern, SPK-COND-004): authenticate the event, record it
 * durably and idempotently in the kernel inbox, and let the inbox worker apply it. Only the fake
 * provider exists until a hardware vendor is selected (DEC-023).
 */
@Controller('webhooks/access-control')
export class AccessControlWebhooksController {
  constructor(
    private readonly inbox: Inbox,
    @Inject(DATABASE) private readonly db: Db,
  ) {}

  @Public()
  @Post(':provider')
  @HttpCode(202)
  async receive(
    @Param('provider') provider: string,
    @Body() raw: unknown,
    @Headers(FAKE_ACCESS_CONTROL_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<{ inboxEventId: string; duplicate: boolean }> {
    if (provider !== FAKE_ACCESS_CONTROL_PROVIDER) {
      throw errors.notFound('access control provider', provider);
    }
    if (!FakeAccessControlProvider.verify(raw, signature)) {
      throw errors.authenticationRequired('The webhook signature is invalid.');
    }
    const body: AccessControlEventBody = accessEventPipe.transform(raw);
    const organization = await this.db
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', body.data.organizationId)
      .executeTakeFirst();
    if (!organization) throw errors.notFound('organization');
    const recorded = await this.inbox.record({
      provider,
      providerEventId: body.id,
      eventType: body.type,
      payload: body,
      organizationId: organization.id,
      signatureVerified: true,
    });
    return { inboxEventId: recorded.id, duplicate: recorded.duplicate };
  }
}
