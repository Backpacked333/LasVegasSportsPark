/**
 * Keyboard alternative to drag-and-drop (SPK-UX-009 "Staff must have keyboard alternatives to drag
 * interactions"). Every reorderable list (placement board SCR-S-18, schedule draft editor SCR-S-04,
 * youth groups SCR-S-19) uses this, or offers the same controls: "Move up" and "Move down" buttons
 * per item and Alt+Arrow keys on the focused item, each move announced in a live region. Pointer
 * dragging, when added, calls the same `onMove`.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';

export interface ReorderableListProps<T> {
  /** Accessible name of the list, e.g. "Teams in division". */
  label: string;
  items: readonly T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  onMove: (from: number, to: number) => void;
  renderItem?: (item: T) => ReactNode;
  disabled?: boolean;
}

export function ReorderableList<T>({
  label,
  items,
  getKey,
  getLabel,
  onMove,
  renderItem,
  disabled = false,
}: ReorderableListProps<T>) {
  const [announcement, setAnnouncement] = useState('');
  const helpId = useId();

  const move = (from: number, to: number) => {
    if (disabled || to < 0 || to >= items.length || from === to) return;
    const item = items[from];
    if (item === undefined) return;
    onMove(from, to);
    setAnnouncement(`${getLabel(item)} moved to position ${to + 1} of ${items.length}.`);
  };

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLLIElement>) => {
    if (!event.altKey) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(index, index - 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(index, index + 1);
    }
  };

  return (
    <div>
      <p className="caption" id={helpId}>
        To reorder, use the Move buttons, or focus an item and press Alt with the up or down arrow.
      </p>
      <ol className="list" aria-label={label} aria-describedby={helpId}>
        {items.map((item, index) => {
          const name = getLabel(item);
          return (
            <li
              key={getKey(item)}
              tabIndex={0}
              onKeyDown={onKeyDown(index)}
              aria-label={`${name}, position ${index + 1} of ${items.length}`}
            >
              <span className="row-text">{renderItem ? renderItem(item) : name}</span>
              <span className="reorder-controls">
                <Button
                  variant="secondary"
                  aria-label={`Move ${name} up`}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  Move up
                </Button>
                <Button
                  variant="secondary"
                  aria-label={`Move ${name} down`}
                  disabled={disabled || index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  Move down
                </Button>
              </span>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="caption" data-testid="reorder-announcement">
        {announcement}
      </p>
    </div>
  );
}
