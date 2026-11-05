/**
 * Accessible button (SPK-UX-009): native <button>, keyboard operable, disabled and busy state
 * exposed (aria-busy), minimum 44 px target.
 */
import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: 'primary' | 'secondary';
  /** A command is in flight (SPK-UX-008 processing). */
  busy?: boolean;
  type?: 'button' | 'submit';
}

export function Button({
  variant = 'primary',
  busy = false,
  disabled,
  children,
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={['button', `button-${variant}`, className].filter(Boolean).join(' ')}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span aria-hidden="true">…</span> : null}
      {children}
    </button>
  );
}
