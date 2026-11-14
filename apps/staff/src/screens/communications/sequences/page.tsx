/**
 * The frame of the message template, sequence and schedule screens (SPK-COMMS-009, proposed
 * amendment PA-05; capability `message_sequences`, DEC-099 pending). With the switch off the
 * "turned off" notice stands above what already exists, which the API keeps readable; nothing new
 * can be created, confirmed or sent, and the screens offer none of it.
 */
import type { ReactNode } from 'react';
import { usePermissions } from '../../../api/permissions';
import { AreaTabs, COMMUNICATIONS_TABS } from '../../../features/operations/AreaTabs';
import { CapabilityGate } from '../../../ui/CapabilityGate';
import { PageHeader } from '../../../ui/Page';
import { StatusBadge } from '../../../ui/StatusBadge';
import { PROPOSED_NOTE } from './labels';
import './sequences.css';

export function SequencesPage({
  titleId,
  title,
  intro,
  actions,
  stillAvailable,
  children,
}: {
  titleId: string;
  title: string;
  intro: string;
  actions?: ReactNode;
  stillAvailable: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={titleId} className="ms">
      <PageHeader
        eyebrow="Business · Communications"
        title={title}
        titleId={titleId}
        intro={intro}
        actions={actions}
      />
      <AreaTabs label="Communications screens" tabs={COMMUNICATIONS_TABS} />
      <p className="ms-badges">
        <StatusBadge tone="info" label={PROPOSED_NOTE} />
      </p>
      <CapabilityGate
        capability="message_sequences"
        whenOff="notice"
        stillAvailable={stillAvailable}
      >
        {children}
      </CapabilityGate>
    </section>
  );
}

/**
 * Whether the viewer can be offered a command of the action: the switch is on and a held role
 * permits it. The API still decides each command; offline, `CommandButton` says it needs a
 * connection.
 */
export function useCanDo(actionId: string, options: { needsCapability?: boolean } = {}): boolean {
  const permissions = usePermissions();
  const on =
    options.needsCapability === false ||
    permissions.isCapabilityEnabled('message_sequences') === true;
  return on && permissions.isPermitted(actionId) === true;
}
