import { Injectable } from '@nestjs/common';
import type { NextAction, Principal } from '@sportspark/contracts';
import type { OperationalExceptionsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import { AuthorizationService, ExceptionActions, type ActionDefinition } from '../../../kernel';
import { CommunicationsActions } from '../../communications';
import { FacilitiesActions } from '../../facilities';
import { FinanceActions } from '../../finance';
import { WorkforceActions } from '../../workforce';

export type ExceptionRow = Selectable<OperationalExceptionsTable>;

export interface Candidate {
  definition: ActionDefinition;
  label: string;
  method: 'GET' | 'POST';
  href: string | null;
  facilityId: string | null;
}

/**
 * SPK-UX-006 "next permitted action": each candidate names the owning module's action and is
 * kept only when the viewer's principal is authorized for it right now, so the feed never offers
 * an action the viewer would be refused. Support only points at the owning module's command; it
 * never performs it on the viewer's behalf.
 */
@Injectable()
export class NextActions {
  constructor(private readonly authorization: AuthorizationService) {}

  async permitted(principal: Principal, candidates: readonly Candidate[]): Promise<NextAction[]> {
    const out: NextAction[] = [];
    if (!principal.organizationId) return out;
    for (const c of candidates) {
      const decision = await this.authorization.decide(principal, c.definition, {
        type: 'next_action',
        organizationId: principal.organizationId,
        facilityId: c.facilityId,
      });
      if (decision.allowed) {
        out.push({ action: c.definition.id, label: c.label, method: c.method, href: c.href });
      }
    }
    return out;
  }

  /** The domain action that addresses an exception's underlying problem, by category. */
  domainCandidates(row: ExceptionRow): Candidate[] {
    const facilityId = row.facility_id;
    const details = (row.details ?? {}) as Record<string, unknown>;
    const affectedId = row.affected_id;
    switch (row.category) {
      case 'finance.unknown_payment_outcome':
      case 'finance.payment_evidence_conflict':
        return row.affected_type === 'payment_attempt' && affectedId
          ? [
              {
                definition: FinanceActions.reconcilePayment,
                label: 'Reconcile the payment with the provider',
                method: 'POST',
                href: `/v1/payments/${affectedId}/reconcile`,
                facilityId,
              },
            ]
          : [];
      case 'finance.fulfillment_incomplete':
        return row.affected_type === 'checkout' && affectedId
          ? [
              {
                definition: FinanceActions.recoverCheckout,
                label: 'Recover or compensate the checkout',
                method: 'POST',
                href: `/v1/registration-checkouts/${affectedId}/recover`,
                facilityId,
              },
            ]
          : [];
      case 'workforce.uncovered_assignment':
        return [
          {
            definition: WorkforceActions.proposeAssignment,
            label: 'Find and offer a replacement',
            method: 'POST',
            href:
              typeof details['replacementsHref'] === 'string' ? details['replacementsHref'] : null,
            facilityId,
          },
        ];
      case 'communications.delivery_failed':
        return typeof details['notificationId'] === 'string'
          ? [
              {
                definition: CommunicationsActions.readNotification,
                label: 'Review the delivery attempts',
                method: 'GET',
                href: `/v1/notifications/${details['notificationId']}/deliveries`,
                facilityId,
              },
            ]
          : [];
      default:
        if (row.category.startsWith('facilities.') && row.affected_type === 'maintenance_task') {
          return [
            {
              definition: FacilitiesActions.manageMaintenanceTask,
              label: 'Work the maintenance task',
              method: 'GET',
              href: affectedId ? `/v1/maintenance-tasks/${affectedId}` : null,
              facilityId,
            },
          ];
        }
        return [];
    }
  }

  /** The exception workflow itself (kernel `exceptions.manage`), by current status. */
  lifecycleCandidates(row: ExceptionRow): Candidate[] {
    const make = (verb: 'acknowledge' | 'resolve' | 'close', label: string): Candidate => ({
      definition: ExceptionActions.manage,
      label,
      method: 'POST',
      href: `/v1/exceptions/${row.id}/${verb}`,
      facilityId: row.facility_id,
    });
    switch (row.status) {
      case 'open':
        return [
          make('acknowledge', 'Acknowledge'),
          make('resolve', 'Mark resolved'),
          make('close', 'Close'),
        ];
      case 'acknowledged':
        return [make('resolve', 'Mark resolved'), make('close', 'Close')];
      case 'resolved':
        return [make('close', 'Close')];
      default:
        return [];
    }
  }
}
