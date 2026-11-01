/**
 * Supported resolution of a dead letter on SCR-S-02 (R3-OPERATIONS-03, §5.11 "operational issues
 * must have owners and supported resolution actions", §4.12, SPK-UX-006). A
 * `reliability.outbox_dead_letter` exception names its outbox event in `details.eventId`; a
 * `reliability.inbox_dead_letter` exception's affected record is the provider (inbox) event. Once
 * the cause is fixed, the owner replays the event (`POST /v1/outbox-events/{id}/replay` or
 * `POST /v1/provider-events/{id}/replay`, with a reason, audited): it returns to the worker, and the
 * exception stays open until the worker settles it and resolves it. "Mark resolved" before that is
 * refused (`dead_letter_replay_required`); closing with a reason stops the follow-up instead.
 *
 * Replay is offered to a viewer whose roles include `core.replay_dead_letter` (any queue), or
 * `core.replay_own_dead_letter` with the staff role the exception's queue is named after, as the
 * API decides (`DeadLetters.requireReplay`). The role view only chooses what to offer; the API's
 * answer (ACCESS_DENIED, NOT_FOUND, INVALID_TRANSITION for an event that is no longer dead) is
 * shown as it comes. Offline the command is not sent.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { TextAreaField } from '../../ui/FormFields';
import { EXCEPTIONS_KEY, EXCEPTION_KEY, TODAY_KEY } from './TodayScreen';

type OperationalException = Schema<'OperationalException'>;

export const OUTBOX_DEAD_LETTER = 'reliability.outbox_dead_letter';
export const INBOX_DEAD_LETTER = 'reliability.inbox_dead_letter';
export const REPLAY_ANY_ACTION = 'core.replay_dead_letter';
export const REPLAY_OWN_ACTION = 'core.replay_own_dead_letter';

/** The dead-lettered event an exception stands for, or null for any other exception. */
export function deadLetterOf(
  exception: OperationalException,
): { source: 'outbox' | 'inbox'; eventId: string } | null {
  if (exception.category === OUTBOX_DEAD_LETTER) {
    const eventId = exception.details['eventId'];
    return typeof eventId === 'string' && eventId ? { source: 'outbox', eventId } : null;
  }
  if (exception.category === INBOX_DEAD_LETTER) {
    return exception.affected?.type === 'inbox_event' && exception.affected.id
      ? { source: 'inbox', eventId: exception.affected.id }
      : null;
  }
  return null;
}

function detailCode(error: ApiError | null): string | null {
  const details = error?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const code = (details as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : null;
}

/** "Mark resolved" on a dead letter whose event has not settled (OperationalExceptions.transition). */
export function isReplayRequired(error: ApiError | null): boolean {
  return (
    error?.code === 'INVALID_TRANSITION' && detailCode(error) === 'dead_letter_replay_required'
  );
}

export function ReplayRequiredNotice() {
  return (
    <p className="error-text" role="alert">
      This follow-up has not happened yet, so the exception cannot be marked resolved. Replay the
      event once its cause is fixed (it is resolved when the replay settles), or close the exception
      with a reason if the follow-up is no longer wanted.
    </p>
  );
}

export function DeadLetterReplay({ exception }: { exception: OperationalException }) {
  const deadLetter = deadLetterOf(exception);
  const permissions = usePermissions();
  const { online } = useApp();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const invalidate = [EXCEPTION_KEY, EXCEPTIONS_KEY, TODAY_KEY];
  const outbox = useApiCommand('post', '/outbox-events/{id}/replay', { invalidate });
  const inbox = useApiCommand('post', '/provider-events/{id}/replay', { invalidate });
  if (!deadLetter || exception.status === 'resolved' || exception.status === 'closed') return null;
  const ownQueue =
    permissions.isPermitted(REPLAY_OWN_ACTION) === true &&
    (permissions.data?.staffRoles ?? []).some((role) => role === exception.ownerQueue);
  if (permissions.isPermitted(REPLAY_ANY_ACTION) !== true && !ownQueue) return null;
  const command = deadLetter.source === 'outbox' ? outbox : inbox;

  const replay = () => {
    setSuccess(null);
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError('Say what fixed the cause; the reason is kept in the audit record.');
      return;
    }
    setReasonError(null);
    void command
      .submit({ path: { id: deadLetter.eventId }, body: { reason: trimmed } })
      .then((r) => {
        setSuccess(
          `Event sent back to the worker (replay ${r.replayCount}). State: ${r.status}. The exception is resolved when it settles.`,
        );
        setReason('');
      })
      .catch(() => undefined);
  };

  return (
    <section className="panel" aria-labelledby="replay-title">
      <h3 id="replay-title">Replay the event</h3>
      <p className="caption">
        {deadLetter.source === 'outbox'
          ? 'The follow-up stopped after its retries. Once the cause is fixed, replay it: the steps that already ran are skipped.'
          : 'The provider event could not be processed after its retries. Once the cause is fixed, replay it.'}
      </p>
      <TextAreaField
        label="Replay reason"
        hint="Needed to replay. Say what fixed the cause; it is kept in the audit record."
        value={reason}
        onChange={setReason}
        error={reasonError}
        maxLength={2000}
      />
      <div className="actions-row">
        <Button
          busy={command.isProcessing}
          disabled={!online || command.isProcessing}
          onClick={replay}
        >
          Replay
        </Button>
      </div>
      <CommandSuccess message={success} />
      <CommandError error={command.error} onRetry={replay} />
    </section>
  );
}
