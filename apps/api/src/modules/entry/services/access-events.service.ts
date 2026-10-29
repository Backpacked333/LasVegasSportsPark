import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccessControlEventBody, systemPrincipal } from '@sportspark/contracts';
import {
  OperationalExceptions,
  runWithTransaction,
  type InboundEvent,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { HARDWARE_QUEUE, UNREGISTERED_ACCESS_DEVICE } from '../access-hardware.shared';
import { ENTRY_POLICY, policyForFacility, type EntryPolicy } from '../entry.policy';
import { hashPassReference } from '../entry.shared';
import { ActivityResolver } from './activity-resolver';
import { VisitsService } from './visits.service';

/**
 * Hardware access events (SPK-COND-004, §3.16 "Access hardware"; vendor not selected, DEC-023).
 * A granted entry is recorded as a facility arrival (a visit, source `access_control`) and as
 * nothing else: hardware access never establishes session attendance or child pickup
 * authorization. Denied entries record nothing; an unknown outcome (the device lost contact)
 * records no visit and raises an operational exception so staff can check the device. Duplicate
 * deliveries are absorbed by the inbox and by the unique access-event reference on visits.
 *
 * ENT-05: an arrival names the registered access device it came through when the event's device
 * reference matches an active device of that facility. An unregistered or retired reference still
 * yields the arrival (the person did come in), and, when the organization keeps a device inventory,
 * one `entry.unregistered_access_device` exception per reference asks the facilities operator to
 * reconcile it. Heartbeats and command receipts are handled by DeviceDeliveryService.
 */
@Injectable()
export class AccessEventsService {
  private readonly logger = new Logger(AccessEventsService.name);

  constructor(
    @Inject(ENTRY_POLICY) private readonly policy: EntryPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly exceptions: OperationalExceptions,
    private readonly resolver: ActivityResolver,
    private readonly visits: VisitsService,
  ) {}

  async handle(event: InboundEvent, trx: Trx): Promise<void> {
    if (!event.eventType.startsWith('access.')) return;
    await runWithTransaction(trx, () => this.apply(event, trx));
  }

  private async apply(event: InboundEvent, trx: Trx): Promise<void> {
    const parsed = AccessControlEventBody.safeParse(event.payload);
    if (!parsed.success || !event.organizationId || !event.signatureVerified) {
      this.logger.warn(`ignoring malformed or unverified access event ${event.id}`);
      return;
    }
    const body = parsed.data;
    const organizationId = event.organizationId;
    if (body.data.organizationId !== organizationId) return;
    const facility = await this.resolver
      .facility(organizationId, body.data.facilityId, trx)
      .catch(() => null);
    if (!facility) return;
    const system = systemPrincipal(organizationId, 'entry.access_control');
    const accessDeviceId = await this.registeredDevice(
      trx,
      organizationId,
      facility.id,
      body.data.deviceId,
      event.providerEventId,
    );
    if (body.type === 'access.denied') return;
    if (body.type === 'access.unknown') {
      const policy = policyForFacility(this.policy, facility.settings);
      await this.exceptions.raise(trx, {
        organizationId,
        facilityId: facility.id,
        category: 'entry.access_outcome_unknown',
        severity: 'warning',
        title: 'An access device reported an unknown outcome; arrivals may be missing',
        affectedType: 'access_device',
        affectedId: body.data.deviceId,
        ownerQueue: policy.facilityOperationsQueue,
        dedupeKey: `entry.access_outcome_unknown:${facility.id}:${body.data.deviceId}`,
        details: { deviceId: body.data.deviceId, providerEventId: event.providerEventId },
      });
      return;
    }

    let personId: string | null = null;
    let passId: string | null = null;
    if (body.data.passReference) {
      const pass = await trx
        .selectFrom('passes')
        .select(['id', 'status', 'holder_person_id'])
        .where('organization_id', '=', organizationId)
        .where('reference_hash', '=', hashPassReference(body.data.passReference))
        .executeTakeFirst();
      if (!pass || pass.status !== 'active') return;
      passId = pass.id;
      // ENT-04, SPK-IAM-007: a pass issued to a person later merged arrives as the survivor.
      personId = pass.holder_person_id
        ? await this.people.resolveCanonicalPersonId(organizationId, pass.holder_person_id, trx)
        : null;
    } else if (body.data.personId) {
      const person = await this.people.findPerson(organizationId, body.data.personId, trx);
      if (!person || person.status !== 'active') return;
      personId = person.id;
    }
    if (personId) {
      const open = await this.visits.openVisit(trx, organizationId, facility.id, personId);
      if (open) return; // already on site: the turnstile adds no second arrival
    }
    const category = body.data.visitorCategory ?? 'unclassified';
    const row = await this.visits.insertVisit(trx, system, organizationId, {
      facilityId: facility.id,
      personId,
      visitorDescription: personId
        ? null
        : passId
          ? 'Access device entry (household pass)'
          : 'Access device entry',
      // A device cannot attest that someone is a session participant (SPK-COND-004).
      visitorCategory: category === 'participant' && !personId ? 'unclassified' : category,
      arrivedAt: new Date(body.data.occurredAt),
      passId,
      source: 'access_control',
      deviceId: body.data.deviceId,
      accessDeviceId,
      accessEventRef: `${event.provider}:${event.providerEventId}`,
    });
    if (row) await this.visits.afterVisit(trx, system, organizationId, row, null);
  }

  /**
   * The active registered device the reference names at this facility, or null. An unmatched
   * reference raises one exception per reference while the organization keeps a device inventory
   * (before any device is registered, refs are not reconciled: access hardware may not be in use).
   */
  private async registeredDevice(
    trx: Trx,
    organizationId: string,
    facilityId: string,
    deviceRef: string,
    providerEventId: string,
  ): Promise<string | null> {
    const device = await trx
      .selectFrom('access_devices')
      .select(['id', 'status', 'facility_id'])
      .where('organization_id', '=', organizationId)
      .where('provider_device_ref', '=', deviceRef)
      .executeTakeFirst();
    if (device?.status === 'active' && device.facility_id === facilityId) return device.id;
    const inventory = await trx
      .selectFrom('access_devices')
      .select('id')
      .where('organization_id', '=', organizationId)
      .limit(1)
      .executeTakeFirst();
    if (!inventory) return null;
    await this.exceptions.raise(trx, {
      organizationId,
      facilityId,
      category: UNREGISTERED_ACCESS_DEVICE,
      severity: 'warning',
      title: 'Access events arrive from a device that is not registered (or is retired) here',
      affectedType: 'access_device_ref',
      affectedId: deviceRef,
      ownerQueue: HARDWARE_QUEUE,
      dedupeKey: `${UNREGISTERED_ACCESS_DEVICE}:${deviceRef}`,
      details: {
        deviceRef,
        facilityId,
        registeredDeviceId: device?.id ?? null,
        registeredStatus: device?.status ?? null,
        firstProviderEventId: providerEventId,
        nextAction: 'register_the_device_or_disconnect_it',
      },
    });
    return null;
  }
}
