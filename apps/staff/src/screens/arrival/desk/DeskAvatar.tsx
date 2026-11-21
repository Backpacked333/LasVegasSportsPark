/**
 * A person's face at the desk: the shared `Avatar` (photo, else initials on the person colour),
 * decorative because the name is always written beside it. `ring` lights it with a floodlight
 * ring for dark or green surfaces (the big green "Checked in" answer, S 3d).
 */
import { Avatar } from '../../../ui/Avatar';

export function DeskAvatar({
  personId,
  name,
  size = 40,
  ring = false,
}: {
  personId: string;
  name: string;
  size?: number;
  /** A floodlight ring around the face (on a dark or green surface). */
  ring?: boolean;
}) {
  return (
    <Avatar
      name={name}
      personKey={personId}
      size={size}
      decorative
      className={ring ? 'desk-avatar desk-avatar-lit' : 'desk-avatar'}
    />
  );
}
