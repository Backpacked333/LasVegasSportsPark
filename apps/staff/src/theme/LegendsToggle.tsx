/**
 * The "Legends mode" switch: turns the dashboard to the night theme with the gold accent and
 * back. A native button with `role="switch"` and its state in `aria-checked`, so it is keyboard
 * operable and read as on or off (SPK-UX-009); the written label is always present (hidden only
 * visually in the compact form, where the control still carries its name).
 */
import { Icon } from '../ui/Icon';
import { useTheme } from './ThemeProvider';
import './legends-toggle.css';

export function LegendsToggle({
  compact = false,
  standalone = false,
}: {
  /** Glyph and switch only; the name stays for assistive technology. */
  compact?: boolean;
  /** On a plain surface (the sign-in page) rather than inside the header glass. */
  standalone?: boolean;
}) {
  const { legends, toggleLegends } = useTheme();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={legends}
      className="legends-toggle"
      data-compact={compact || undefined}
      data-standalone={standalone || undefined}
      data-testid="legends-toggle"
      title={legends ? 'Legends mode is on' : 'Turn on Legends mode'}
      onClick={toggleLegends}
    >
      <span className="legends-toggle-icon" aria-hidden="true">
        <Icon name="crown" size={16} filled />
      </span>
      <span className="legends-toggle-label">Legends mode</span>
      <span className="legends-toggle-track" aria-hidden="true">
        <span className="legends-toggle-knob" />
      </span>
    </button>
  );
}
