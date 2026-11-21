/**
 * The signed-in person in the rail foot (redesign handoff, staff shell row 4): photo or initials,
 * name and first staff role from `GET /v1/me`, and a menu with Profile, the shared-tablet lock
 * (Proposed, S 3h), Switch user and Sign out. The sign-out icon stays beside the name, as drawn.
 *
 * "Lock this tablet when idle" asks the staff member to choose a 4-digit PIN for this device
 * first (it is kept hashed on the device only; `lock/pin.ts`). "Switch user" signs this session
 * out so another staff member signs in on the same tablet.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useApiQuery } from '../api/useApiQuery';
import { useApp } from '../providers/AppProviders';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { useFocusTrap } from '../ui/useFocusTrap';
import { useLock } from './lock/LockProvider';
import { DEVICE_NAME_KEY, isPin } from './lock/pin';

/** Role names, most senior first: the rail shows the first one the person holds. */
export const ROLE_LABELS: Record<string, string> = {
  general_manager: 'General manager',
  system_administrator: 'System administrator',
  league_manager: 'League manager',
  program_manager: 'Program manager',
  finance_operator: 'Finance operator',
  facilities_operator: 'Facilities operator',
  scheduler: 'Scheduler',
  front_desk: 'Front desk',
  support_operator: 'Support operator',
  coach: 'Coach',
  official: 'Official',
};

function PinSetupDialog({ onClose }: { onClose: () => void }) {
  const lock = useLock();
  const { preferences } = useApp();
  const ref = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [deviceName, setDeviceName] = useState(preferences.get(DEVICE_NAME_KEY) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useFocusTrap(ref, true, onClose);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isPin(pin)) return setError('Choose four digits.');
    if (pin !== again) return setError('The two PINs are not the same.');
    setSaving(true);
    try {
      preferences.set(DEVICE_NAME_KEY, deviceName.trim() || null);
      await lock?.enableSharedDevice(pin);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="ui-overlay ui-overlay-center">
      <div className="ui-scrim" aria-hidden="true" onClick={onClose} />
      <form
        ref={ref}
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
      >
        <h3 id={titleId}>Lock this tablet when idle</h3>
        <p className="caption">
          After 10 minutes without a touch the tablet locks. Families can still scan their pass;
          your PIN opens it again where you left off. The PIN stays on this tablet only.
        </p>
        <label className="field">
          <span>Choose a 4-digit PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            data-autofocus
          />
        </label>
        <label className="field">
          <span>Type it again</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={again}
            onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <label className="field">
          <span>Name of this tablet (optional)</span>
          <input
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Front desk tablet 2"
            maxLength={40}
          />
        </label>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions-row">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={saving}>
            Turn on the lock
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function UserMenu() {
  const { session, signOut } = useApp();
  const lock = useLock();
  const navigate = useNavigate();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const person = me.data?.person ?? null;
  const name = [person?.givenName, person?.familyName].filter(Boolean).join(' ') || 'Signed in';
  const roles = me.data?.principal.staffRoles ?? [];
  const role =
    Object.keys(ROLE_LABELS).find((r) => (roles as readonly string[]).includes(r)) ?? roles[0];
  const personId = me.data?.principal.personId ?? null;
  const [open, setOpen] = useState(false);
  const [settingPin, setSettingPin] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKey = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className="side-user">
      <button
        ref={buttonRef}
        type="button"
        className="side-user-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${name}, account menu`}
        title={name}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={name} personKey={personId ?? undefined} size={34} decorative />
        <span className="side-user-text">
          <span className="side-user-name">{name}</span>
          <span className="side-user-role">
            {role ? (ROLE_LABELS[role] ?? role) : 'Staff dashboard'}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="side-icon-button"
        aria-label="Sign out"
        title="Sign out"
        onClick={() => void signOut()}
      >
        <Icon name="logout" size={18} />
      </button>
      {open ? (
        <ul
          ref={menuRef}
          id={menuId}
          className="user-menu"
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKey}
        >
          {personId ? (
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close(false);
                  navigate(`/people/${personId}`);
                }}
              >
                <Icon name="person" size={18} />
                Profile
              </button>
            </li>
          ) : null}
          {lock ? (
            <li role="none">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={lock.sharedDevice}
                onClick={() => {
                  close(false);
                  if (lock.sharedDevice) lock.disableSharedDevice();
                  else setSettingPin(true);
                }}
              >
                <Icon name="tablet" size={18} />
                Lock this tablet when idle
                <span className="user-menu-state">{lock.sharedDevice ? 'On' : 'Off'}</span>
              </button>
            </li>
          ) : null}
          {lock?.sharedDevice && lock.hasPin ? (
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close(false);
                  lock.lockNow();
                }}
              >
                <Icon name="lock" size={18} />
                Lock now
              </button>
            </li>
          ) : null}
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                void (lock ? lock.switchUser() : signOut());
              }}
            >
              <Icon name="swap_horiz" size={18} />
              Switch user
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                void signOut();
              }}
            >
              <Icon name="logout" size={18} />
              Sign out
            </button>
          </li>
        </ul>
      ) : null}
      {settingPin ? <PinSetupDialog onClose={() => setSettingPin(false)} /> : null}
    </div>
  );
}
