/**
 * Code sign-in, the port the redesigned welcome uses (handoff M 5a, 5b; §4.13, §5.2). Managed
 * identity is a provider-selection gate (DEC-018, pending): no vendor is chosen, so the app codes
 * against this interface. Development builds in demo mode get a deterministic stand-in (src/demo,
 * compiled out of release bundles); release builds have no adapter and keep saying that signing
 * in is not available yet. Nothing here weakens the API's own checks: whatever the adapter does,
 * the session it returns is a token the API verifies on every request.
 */

export type ContactKind = 'phone' | 'email';

export interface SignedInSession {
  token: string;
  expiresAt: string;
  accountId: string;
}

export type VerifyOutcome = { kind: 'signed_in'; session: SignedInSession } | { kind: 'wrong' };

export interface CodeSignInPort {
  /** Sends a 6-digit code to the phone or email; when it may be sent again, in seconds. */
  requestCode(contact: string, kind: ContactKind): Promise<{ resendAfterSeconds: number }>;
  /** Checks the code; a wrong code is an answer, not an error. */
  verifyCode(contact: string, code: string): Promise<VerifyOutcome>;
  /** Words shown under the code boxes in a stand-in (the demo's code); null for a real provider. */
  hint: string | null;
}

export const CODE_LENGTH = 6;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;

/** "phone" once the entry has 10 or more digits and nothing else but phone punctuation. */
export function contactKind(text: string): ContactKind | null {
  const value = text.trim();
  if (EMAIL.test(value)) return 'email';
  if (/^[+\d\s().-]+$/u.test(value) && value.replace(/\D/gu, '').length >= 10) return 'phone';
  return null;
}

/** "(702) 555-0148" for a 10-digit US number; anything else as typed. */
export function displayContact(text: string): string {
  const digits = text.replace(/\D/gu, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (contactKind(text) === 'phone' && local.length === 10) {
    return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
  }
  return text.trim();
}

/** "0:41". */
export function resendWords(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
