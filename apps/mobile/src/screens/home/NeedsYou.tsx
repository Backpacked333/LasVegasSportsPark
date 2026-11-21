/**
 * Rows of SCR-C-03 Home's "To do" card that open an item elsewhere (SPK-UX-003 "actions required
 * before participation", then "invitations and offers"; PA-11 SPK-UX-011 **Proposed**; ADR-008),
 * under the redesign's in-place rows (handoff 1b). Registrations waiting on the customer come
 * first (they are not in the inbox), then action notices, then invitations and offers. Each row
 * carries one verb ("Pay", "Sign form", "Answer", "Accept") and opens the item: a registration its
 * record, a notice the record it is about (`noticeTarget`, with the inbox "read" request) or else
 * the notice in the inbox. The same rows show the pinned recovery and "In progress".
 */
import type { Schema } from '@sportspark/api-client';
import { nameOf } from '../../features/today/queries';
import { enrollmentStatus, noticeStatus } from '../../features/today/status';
import { ListRow } from '../../ui/ListRow';
import { noticeVerb } from './home-layout';
import { noticeFor, openNoticeHint, useOpenNotice } from './open-notice';
import type { PendingRegistration } from './pending-registrations';

type InboxItem = Schema<'InboxItem'>;

/** The name of a registration's activity: with the enrollment (ENR-02), else the offering read. */
export function registrationName(
  row: PendingRegistration,
  offeringNames: Map<string, string>,
): string {
  const { enrollment } = row;
  return enrollment.offering?.name ?? offeringNames.get(enrollment.offeringId) ?? 'Registration';
}

/** A registration as a row (also the pinned recovery and "In progress" rows, without a verb). */
export function RegistrationRow({
  row,
  names,
  offeringNames,
  verb,
  onPress,
  testID,
}: {
  row: PendingRegistration;
  names: Map<string, string>;
  offeringNames: Map<string, string>;
  verb?: string;
  onPress?: () => void;
  testID: string;
}) {
  const { enrollment, operation, checkout } = row;
  const offeringName = registrationName(row, offeringNames);
  return (
    <ListRow
      title={offeringName}
      detail={`For: ${nameOf(names, enrollment.participantPersonId)}`}
      value={verb}
      status={enrollmentStatus(enrollment, { offeringName, operation, checkout })}
      onPress={onPress}
      accessibilityHint={onPress ? 'Opens the registration' : undefined}
      testID={`${testID}-${enrollment.id}`}
    />
  );
}

/** A notice as a row with its verb; it opens the item it is about. */
export function NoticeRow({ item, names }: { item: InboxItem; names: Map<string, string> }) {
  const openNotice = useOpenNotice();
  return (
    <ListRow
      title={item.title}
      detail={`${noticeFor(item, names)}${item.body}`}
      value={noticeVerb(item)}
      status={noticeStatus(item)}
      onPress={() => openNotice(item)}
      accessibilityHint={openNoticeHint(item)}
      testID={`home-notice-${item.attemptId}`}
    />
  );
}
