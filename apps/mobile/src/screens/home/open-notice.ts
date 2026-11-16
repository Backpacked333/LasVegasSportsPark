/**
 * Opening a notice from Home (PA-11 SPK-UX-003 **Proposed**): the record it is about
 * (`noticeTarget`), else the notice in the inbox, as before. Opened on its record, an unread notice
 * is marked read with the same request the inbox sends on opening it (`POST /v1/me/inbox/{id}/read`
 * with the revision known, SPK-COMMS-004); the inbox does that itself when it opens the notice. Not
 * while offline, as in the inbox.
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { UNREAD_COUNT_KEY } from '../../api/inbox-unread';
import { useApiCommand } from '../../api/useApiCommand';
import { noticeTarget } from '../../features/today/notice-target';
import { nameOf } from '../../features/today/queries';
import { useConnectivity } from '../../providers/AppProviders';

type InboxItem = Schema<'InboxItem'>;

export function useOpenNotice() {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const read = useApiCommand('post', '/me/inbox/{id}/read', {
    invalidate: [['api', '/me/inbox'], UNREAD_COUNT_KEY],
  });
  return (item: InboxItem) => {
    const target = noticeTarget(item);
    router.push(target.href as Href);
    if (target.kind !== 'subject' || item.readAt || item.acknowledgedAt || reachable === false) {
      return;
    }
    const body = typeof item.revision === 'number' ? { expectedRevision: item.revision } : {};
    read.submit({ path: { id: item.attemptId }, body }).catch(() => undefined);
  };
}

/** The hint of a row or card that opens a notice: its record, or the notice in the inbox. */
export function openNoticeHint(item: InboxItem): string {
  return noticeTarget(item).kind === 'subject'
    ? 'Opens what this notice is about'
    : 'Opens the notice in your notifications';
}

/** "For: Sam. " ahead of a notice's text: whom it concerns (SPK-UX-003, `subjectPersonIds`). */
export function noticeFor(item: InboxItem, names: Map<string, string>): string {
  const ids = item.subjectPersonIds ?? [];
  if (ids.length === 0) return '';
  return `For: ${ids.map((id) => nameOf(names, id)).join(', ')}. `;
}
