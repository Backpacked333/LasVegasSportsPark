/**
 * A consequential command that needs a reason (retire, withdraw, void, cancel; §4.9 `reason`):
 * a button opens a labelled form with the reason, so nothing happens on a single click
 * (SPK-UX-009 keyboard operable, labelled controls). The form stays open with its text when the
 * command is refused; the caller shows the refusal next to it.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { TextAreaField } from '../../ui/FormFields';

export interface ReasonActionProps {
  /** The button that opens the form, and the form's accessible name. */
  label: string;
  confirmLabel: string;
  reasonLabel?: string;
  /** What the command does, shown in the form. */
  explanation?: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  /** Resolves true when the API confirmed the command (the form then closes). */
  onConfirm: (reason: string) => Promise<boolean>;
}

export function ReasonAction({
  label,
  confirmLabel,
  reasonLabel = 'Reason',
  explanation,
  busy,
  disabled,
  onConfirm,
}: ReasonActionProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  if (!open) {
    return (
      <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!reason.trim()) return;
    if (await onConfirm(reason.trim())) {
      setOpen(false);
      setReason('');
      setTouched(false);
    }
  };
  return (
    <form className="panel" aria-label={label} onSubmit={(e) => void submit(e)} noValidate>
      {explanation ? <p>{explanation}</p> : null}
      <TextAreaField
        label={reasonLabel}
        required
        value={reason}
        onChange={setReason}
        maxLength={2000}
        error={touched && !reason.trim() ? 'Enter a reason.' : null}
        disabled={busy}
      />
      <div className="actions-row">
        <Button type="submit" busy={busy} disabled={disabled}>
          {confirmLabel}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
