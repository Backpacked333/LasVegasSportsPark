/**
 * The link from a season or an offering to its message schedule (SPK-COMMS-009, proposed
 * amendment PA-05; capability `message_sequences`). Shown only while the organization has message
 * sequences turned on and the viewer may read schedules; otherwise nothing is rendered, so the
 * season and offering screens stay as they are with the switch off.
 */
import { Link } from 'react-router';
import { usePermissions } from '../../../api/permissions';
import { READ_ACTION, type SubjectType } from './labels';

export const schedulePath = (subject: SubjectType, id: string): string =>
  `/communications/schedules/${subject}/${id}`;

export function MessageScheduleLink({ subject, id }: { subject: SubjectType; id: string }) {
  const permissions = usePermissions();
  if (permissions.isCapabilityEnabled('message_sequences') !== true) return null;
  if (permissions.isPermitted(READ_ACTION) !== true) return null;
  return <Link to={schedulePath(subject, id)}>Message schedule</Link>;
}
