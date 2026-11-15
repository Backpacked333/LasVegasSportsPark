/**
 * "Join the waitlist" for one basket line (SPK-REG-008; SPK-AT-005 the customer who loses the
 * final place gets the permitted alternative, CAPACITY_UNAVAILABLE `join_waitlist_or_choose_alternative`).
 * Sends `POST /v1/waitlist-entries` for the line's participant, offering and intent and opens
 * SCR-C-16; the entry is then listed by `GET /v1/me/waitlist-entries` on every device.
 *
 * SPK-PAY-014, SPK-REG-012 (proposed; quality review M-2): the entry asks for exactly what the
 * line chose (the price option, the days, the extras, the uniform size), so the customer waits
 * for the day or extra that was full and the place later offered can be paid at that price. A
 * line that chose none of them sends none, as before.
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

/** What a basket line chose, as a waitlist entry asks for it; nothing for a line that chose none. */
export function waitlistChoicesOf(
  line: Partial<Pick<BasketLine, 'priceTierId' | 'selectedSessionIds' | 'addons' | 'uniform'>>,
) {
  return {
    ...(line.priceTierId ? { priceTierId: line.priceTierId } : {}),
    ...(line.selectedSessionIds ? { selectedSessionIds: line.selectedSessionIds } : {}),
    ...(line.addons && line.addons.length > 0
      ? {
          addons: line.addons.map((addon) => ({
            addonId: addon.addonId,
            ...(addon.sessionIds.length > 0 ? { sessionIds: addon.sessionIds } : {}),
          })),
        }
      : {}),
    ...(line.uniform
      ? { uniform: { offeringUniformId: line.uniform.offeringUniformId, size: line.uniform.size } }
      : {}),
  };
}

export function JoinWaitlistButton({
  line,
  participantName,
  disabled = false,
}: {
  line: Pick<BasketLine, 'offeringId' | 'participantPersonId' | 'intent' | 'id'> &
    Partial<Pick<BasketLine, 'priceTierId' | 'selectedSessionIds' | 'addons' | 'uniform'>>;
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
          ...waitlistChoicesOf(line),
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
