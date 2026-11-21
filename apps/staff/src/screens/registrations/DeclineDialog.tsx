/**
 * Decline with a reason (handoff S 3f; INTERACTIONS 1c row 5; SPK-REG-002, SPK-REG-007): a reason
 * is required and the family sees it. The message is prefilled per reason and editable; the button
 * says what will happen ("Decline", "Decline and offer U12 Dev"). When the API names a fitting
 * alternative with places (`eligibility.alternatives`, an offering), offering it is ticked by
 * default, so a "no" comes with a next step; the suggestion travels in the message the family
 * reads (the family registers for it themselves). Esc cancels; Ctrl or ⌘ with Enter sends.
 *
 * Several applications with one reason (the bulk bar) share the reason and the message; each name
 * is written into its own family's message, and each decline is its own audited command.
 */
import { useState } from 'react';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { DECLINE_REASONS, declineButton, declineMessage, type DeclineReason } from './triage-model';

export interface DeclineTarget {
  applicationId: string;
  personId: string;
  name: string;
  givenName: string;
  offeringName: string;
}

export interface Alternative {
  offeringId: string;
  name: string;
  placesLeft: number | null;
}

export interface DeclineChoice {
  reason: DeclineReason;
  /** The message per application (the name written in). */
  messages: ReadonlyMap<string, string>;
  offerAlternative: boolean;
}

const NAME = '{name}';

export function DeclineDialog({
  targets,
  alternative,
  initialReason = 'level',
  busy = false,
  error,
  onCancel,
  onSend,
}: {
  targets: readonly DeclineTarget[];
  alternative: Alternative | null;
  initialReason?: DeclineReason;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSend: (choice: DeclineChoice) => void;
}) {
  const single = targets.length === 1 ? targets[0]! : null;
  const fits = alternative !== null && (alternative.placesLeft ?? 1) > 0;
  const [reason, setReason] = useState<DeclineReason>(initialReason);
  const [offer, setOffer] = useState(fits);
  const template = (r: DeclineReason, withAlt: boolean) =>
    declineMessage(
      r,
      single ? single.givenName : NAME,
      withAlt && alternative ? alternative.name : null,
    );
  const [message, setMessage] = useState(() => template(initialReason, fits));
  const [edited, setEdited] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const choose = (r: DeclineReason, withAlt = offer) => {
    setReason(r);
    if (!edited) setMessage(template(r, withAlt));
  };
  const send = () => {
    setAttempted(true);
    if (!message.trim()) return;
    const messages = new Map(
      targets.map((t) => [t.applicationId, message.replaceAll(NAME, t.givenName).trim()]),
    );
    onSend({ reason, messages, offerAlternative: offer && fits });
  };
  const title = single ? `Decline ${single.name}?` : `Decline ${targets.length} applications?`;
  return (
    <Dialog
      labelledBy="decline-title"
      onClose={onCancel}
      locked={busy}
      width={520}
      testId="decline-dialog"
      header={
        <>
          {single ? (
            <Avatar name={single.name} personKey={single.personId} size={48} decorative />
          ) : null}
          <span className="decline-head">
            <h3 id="decline-title">{title}</h3>
            <span className="caption">
              {single
                ? single.offeringName
                : `${targets[0]?.offeringName ?? ''} · each family gets its own message`}
            </span>
          </span>
        </>
      }
      footer={
        <>
          <span className="caption decline-keys">Esc to cancel · ⌘↵ to send</span>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button className="button-danger" busy={busy} onClick={send}>
            {declineButton(offer && fits, alternative?.name ?? null)}
          </Button>
        </>
      }
    >
      <div
        className="decline-body"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      >
        <fieldset className="decline-reasons">
          <legend>Reason · the family sees this</legend>
          {DECLINE_REASONS.map((r) => (
            <label
              key={r.id}
              className="decline-reason"
              data-checked={reason === r.id || undefined}
            >
              <input
                type="radio"
                name="decline-reason"
                checked={reason === r.id}
                onChange={() => choose(r.id)}
              />
              {r.label}
            </label>
          ))}
        </fieldset>
        <label htmlFor="decline-message" className="decline-label">
          Message to the family
        </label>
        <textarea
          id="decline-message"
          rows={3}
          value={message}
          maxLength={1800}
          aria-invalid={attempted && !message.trim() ? true : undefined}
          onChange={(e) => {
            setEdited(true);
            setMessage(e.target.value);
          }}
        />
        {!single ? (
          <span className="caption">{'{name}'} is replaced by each child’s first name.</span>
        ) : null}
        {attempted && !message.trim() ? (
          <span className="error-text" role="alert">
            Write the message the family will read.
          </span>
        ) : null}
        {fits && alternative ? (
          <label className="decline-offer" data-checked={offer || undefined}>
            <input
              type="checkbox"
              checked={offer}
              onChange={(e) => {
                setOffer(e.target.checked);
                if (!edited) setMessage(template(reason, e.target.checked));
              }}
            />
            <span>
              Offer <b>{alternative.name}</b> instead
              {alternative.placesLeft !== null ? ` (${alternative.placesLeft} places left)` : ''}
            </span>
          </label>
        ) : null}
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
