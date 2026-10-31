/**
 * SCR-S-40 Delivery status, list of notices (SPK-COMMS-004, SPK-COMMS-005, SPK-UX-006,
 * SPK-REPORT-002): every notice of the organization (or the selected facility), newest first,
 * with its status (composed, queued, dispatched, suppressed with reason). Each opens its preview
 * (while composed) or its per-recipient delivery status.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, COMMUNICATIONS_TABS } from '../../features/operations/AreaTabs';
import { useFacilityZone, useOperatingFacility } from '../../features/operations/context';
import { SelectField } from '../../features/operations/fields';
import { formatInstant, humanize } from '../../features/operations/format';
import { NOTIFICATION_STATUS } from '../../features/operations/labels';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type Status = Schema<'NotificationStatus'>;

export function NotificationsScreen() {
  const facility = useOperatingFacility();
  const [status, setStatus] = useState<Status | ''>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useApiQuery({
    path: '/notifications',
    request: {
      query: {
        status: status || undefined,
        facilityId: facility.facilityId ?? undefined,
        limit: 50,
        cursor,
      },
    },
    // Wait for the viewer's scope so the first read is already the facility's.
    enabled: !facility.loading,
  });
  return (
    <section aria-labelledby="notifications-title">
      <h2 id="notifications-title">Delivery status</h2>
      <AreaTabs label="Communications screens" tabs={COMMUNICATIONS_TABS} />
      <SelectField
        label="Show"
        value={status}
        onChange={(v) => {
          setStatus(v as Status | '');
          setCursor(undefined);
        }}
        placeholder="Every state"
        options={(Object.keys(NOTIFICATION_STATUS) as Status[]).map((s) => ({
          value: s,
          label: NOTIFICATION_STATUS[s].label,
        }))}
      />
      <QueryBoundary
        query={list}
        label="messages"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'Nothing queued',
          description:
            'Messages you compose, and notices the system sends, appear here with their delivery status.',
        }}
        unavailableOffline={['composing and sending messages']}
      >
        {(data) => (
          <>
            <ul className="list" aria-label="Messages">
              {data.items.map((n) => (
                <NotificationRow key={n.id} notification={n} />
              ))}
            </ul>
            {data.nextCursor ? (
              <Button variant="secondary" onClick={() => setCursor(data.nextCursor ?? undefined)}>
                Next page
              </Button>
            ) : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}

/** One message; its time in the notice's facility zone when it names one (SPK-SCHED-008). */
function NotificationRow({ notification: n }: { notification: Schema<'Notification'> }) {
  const zone = useFacilityZone(n.facilityId);
  const badge = NOTIFICATION_STATUS[n.status];
  return (
    <li>
      <div className="row-text">
        <Link className="row-title" to={`/communications/notifications/${n.id}`}>
          {n.title}
        </Link>
        <span className="caption">
          {humanize(n.kind)} · {n.category === 'operational' ? 'Essential' : 'Promotional'} ·
          created {formatInstant(n.createdAt, zone)}
        </span>
        <StatusBadge tone={badge.tone} label={badge.label} />
      </div>
    </li>
  );
}
