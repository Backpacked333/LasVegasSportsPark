/**
 * Membership states for staff (SCR-S-53; ENR-12, SPK-COND-001): a membership is an enrollment with
 * the `membership` intent, so its state is the §4.6 Enrollment machine's (journeys.md section 3
 * rule 4 machine names), and a suspension is `active` or `ended`. Always through `StatusBadge`
 * (glyph and text, never colour alone).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../../ui/StatusBadge';

type EnrollmentStatus = Schema<'EnrollmentStatus'>;

export const ENROLLMENT_STATUS: Record<EnrollmentStatus, { tone: StatusTone; label: string }> = {
  pending: { tone: 'pending', label: 'pending' },
  confirmed: { tone: 'success', label: 'confirmed' },
  canceled: { tone: 'neutral', label: 'canceled' },
  transferred: { tone: 'info', label: 'transferred' },
  completed: { tone: 'neutral', label: 'completed' },
};

export const ENROLLMENT_STATUSES = Object.keys(ENROLLMENT_STATUS) as EnrollmentStatus[];

export const SUSPENSION_STATUS: Record<
  Schema<'MembershipSuspension'>['status'],
  { tone: StatusTone; label: string }
> = {
  active: { tone: 'warning', label: 'active' },
  ended: { tone: 'neutral', label: 'ended' },
};
