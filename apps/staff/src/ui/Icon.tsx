/**
 * Icon: an inline Material Symbols Rounded glyph (redesign system, SPK-UX-010 soccer-specific
 * identity). Decorative by default (`aria-hidden`): the text beside it always carries the meaning
 * (SPK-UX-009, never an icon or colour alone). Pass `label` only for an icon-only control.
 */
import { ICON_PATHS, type IconName } from './icon-paths';

export type { IconName } from './icon-paths';

export function Icon({
  name,
  size = 20,
  filled = false,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  filled?: boolean;
  label?: string;
  className?: string;
}) {
  const paths: { o: string; f?: string } = ICON_PATHS[name];
  const d = filled && paths.f ? paths.f : paths.o;
  return (
    <svg
      className={['icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <path d={d} />
    </svg>
  );
}
