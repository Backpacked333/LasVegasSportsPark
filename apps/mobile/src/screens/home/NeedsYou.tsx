/**
 * "Needs you" on SCR-C-03 Home (SPK-UX-003 "actions required before participation", then
 * "invitations and offers"; PA-11 SPK-UX-011 **Proposed**; ADR-008): one card of up to three rows.
 * Registrations waiting on the customer come first (they are not in the inbox), then action
 * notices, then invitations and offers. Each row carries one verb ("Pay", "Sign form", "Answer",
 * "Accept") and opens the item: a registration its record, a notice the record it is about
 * (`noticeTarget`, with the inbox "read" request) or else the notice in the inbox. Rows beyond the
 * third are behind "See all" (the registrations list while one is hidden, otherwise the inbox).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';
import { nameOf } from '../../features/today/queries';
import { enrollmentStatus, noticeStatus } from '../../features/today/status';
import { ListRow } from '../../ui/ListRow';
import { Section } from '../../ui/Section';
import { NEEDS_YOU_ROWS, noticeVerb, registrationVerb } from './home-layout';
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

export function NeedsYou({
  registrations,
  actions,
  invitations,
  names,
  offeringNames,
}: {
  registrations: readonly PendingRegistration[];
  actions: readonly InboxItem[];
  invitations: readonly InboxItem[];
  names: Map<string, string>;
  offeringNames: Map<string, string>;
}) {
  const router = useRouter();
  const total = registrations.length + actions.length + invitations.length;
  if (total === 0) return null;
  let room = NEEDS_YOU_ROWS;
  const take = <T,>(list: readonly T[]): T[] => {
    const shown = list.slice(0, Math.max(room, 0));
    room -= shown.length;
    return shown;
  };
  const shownRegistrations = take(registrations);
  const shownActions = take(actions);
  const shownInvitations = take(invitations);
  const hidden = total - NEEDS_YOU_ROWS;
  const registrationHidden = shownRegistrations.length < registrations.length;
  return (
    <Section
      title="Needs you"
      subtitle={hidden > 0 ? `${NEEDS_YOU_ROWS} of ${total}` : undefined}
      action={
        hidden > 0
          ? {
              label: 'See all',
              onPress: () => router.push((registrationHidden ? '/enrollments' : '/inbox') as Href),
            }
          : undefined
      }
      testID="home-needs-you"
    >
      {shownRegistrations.length + shownActions.length > 0 ? (
        <View accessibilityRole="list" testID="home-actions">
          {shownRegistrations.map((row) => (
            <RegistrationRow
              key={row.enrollment.id}
              row={row}
              names={names}
              offeringNames={offeringNames}
              verb={registrationVerb(row.enrollment.pendingReason)}
              onPress={() => router.push(`/enrollments/${row.enrollment.id}` as Href)}
              testID="home-registration"
            />
          ))}
          {shownActions.map((item) => (
            <NoticeRow key={item.attemptId} item={item} names={names} />
          ))}
        </View>
      ) : null}
      {shownInvitations.length > 0 ? (
        <View accessibilityRole="list" testID="home-invitations">
          {shownInvitations.map((item) => (
            <NoticeRow key={item.attemptId} item={item} names={names} />
          ))}
        </View>
      ) : null}
    </Section>
  );
}
