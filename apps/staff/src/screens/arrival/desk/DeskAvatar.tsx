/**
 * A person's face at the desk: initials on the person's colour (the product has no uploaded
 * profile photo yet; the redesign's photos are placeholders). The colour is stable per person.
 *
 * TODO(staff shell): swap for the shared staff Avatar primitive once it lands in `src/ui`; this
 * local version exists only so the front-desk screens do not wait for it.
 */
import { initialsOf } from '../../../features/operations/format';

function colourOf(personId: string): number {
  let hash = 0;
  for (let i = 0; i < personId.length; i += 1) hash = (hash * 31 + personId.charCodeAt(i)) >>> 0;
  return (hash % 5) + 1;
}

export function DeskAvatar({
  personId,
  name,
  size = 40,
  ring = false,
}: {
  personId: string;
  name: string;
  size?: number;
  /** A light ring around the face (on a dark or green surface). */
  ring?: boolean;
}) {
  return (
    <span
      className="desk-avatar"
      data-colour={colourOf(personId)}
      data-ring={ring || undefined}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}
