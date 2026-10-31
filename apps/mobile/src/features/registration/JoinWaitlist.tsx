/**
 * "Join the waitlist" for one basket line (SPK-REG-008; SPK-AT-005 the customer who loses the
 * final place gets the permitted alternative, CAPACITY_UNAVAILABLE `join_waitlist_or_choose_alternative`).
 * Sends `POST /v1/waitlist-entries` for the line's participant, offering and intent and opens
 * SCR-C-16; the entry is then listed by `GET /v1/me/waitlist-entries` on every device.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { Button } from '../../ui/Button';
import { CommandError } from './CommandError';
import { MY_WAITLIST_KEY } from './in-progress';
import { registrationRoutes } from './routes';

type BasketLine = Schema<'BasketLine'>;

export function JoinWaitlistButton({
  line,
  participantName,
  disabled = false,
}: {
  line: Pick<BasketLine, 'offeringId' | 'participantPersonId' | 'intent' | 'id'>;
  participantName: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const join = useApiCommand('post', '/waitlist-entries', { invalidate: [MY_WAITLIST_KEY] });
  const [failure, setFailure] = useState<ApiError | null>(null);
  const submit = async () => {
    setFailure(null);
    try {
      const entry = await join.submit({
        body: {
          offeringId: line.offeringId,
          participantPersonId: line.participantPersonId,
          intent: line.intent,
          preferences: {},
        },
      });
      router.push(registrationRoutes.waitlist(entry.id));
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  return (
    <View testID={`join-waitlist-${line.id}`}>
      <Button
        label={
          participantName === 'You'
            ? 'Join the waitlist'
            : `Join the waitlist for ${participantName}`
        }
        variant="secondary"
        onPress={() => void submit()}
        busy={join.isProcessing}
        disabled={disabled}
      />
      <CommandError error={failure} onRetry={() => void submit()} />
    </View>
  );
}
