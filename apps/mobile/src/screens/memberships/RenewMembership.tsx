/**
 * Renew a membership at checkout (Package G; ENR-12, SPK-COND-001; capability `memberships`,
 * DEC-016, DEC-072). `POST /v1/enrollments/{id}/renew` adds the renewal of the membership offering
 * the customer chooses to a new basket; nothing is charged until checkout (basket, quote and
 * checkout, SCR-C-11 to SCR-C-15). The app never renews automatically, never preselects a target
 * and never states a renewal price: the basket's quote does (automatic renewal and member pricing
 * are not specified, POL-038, DEC-007).
 *
 * Targets: membership offerings open for registration (`GET /v1/offerings?kind=membership`, cursor
 * pages). The API checks eligibility, the participant's authority (PARTICIPANT_AUTHORITY_REQUIRED
 * is "not available to your account") and the switch (CAPABILITY_DISABLED shows "turned off").
 * One idempotency key per renewal intent; a retry after no answer reuses it.
 *
 * States: loading targets; empty (none open); ready; validation (no target chosen); offline;
 * processing; failure with the code; success (opens the basket).
 */
import type { ApiError } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { CommandFailure } from '../../features/money/CommandFailure';
import { formatDateRange } from '../../features/money/format';
import { ButtonRow, Caption, ChoiceRow, Section } from '../../features/money/ui';
import { registrationRoutes } from '../../features/registration/routes';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';

export function RenewMembership({
  enrollmentId,
  onClose,
}: {
  enrollmentId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const targets = useApiPages({
    path: '/offerings',
    request: { query: { kind: 'membership', limit: 20 } },
  });
  const renew = useApiCommand('post', '/enrollments/{id}/renew', {
    invalidate: [['api', '/me/memberships']],
  });
  const [targetId, setTargetId] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const open = (targets.data ?? []).filter((o) => o.publicationState === 'registration_open');

  const submit = async () => {
    if (!targetId) {
      setMissing(true);
      return;
    }
    setFailure(null);
    try {
      const basket = await renew.submit({
        path: { id: enrollmentId },
        body: { targetOfferingId: targetId },
      });
      router.push(registrationRoutes.basket(basket.id));
    } catch (error) {
      setFailure(error as ApiError);
    }
  };

  return (
    <Section title="Renew" testID={`renew-${enrollmentId}`}>
      <Caption>
        Renewing adds the membership you choose to a new basket. Nothing is charged until you check
        out, where the price is shown.
      </Caption>
      {targets.data === undefined ? (
        targets.error ? (
          <QueryErrorView error={targets.error} onRetry={() => void targets.refetch()} />
        ) : (
          <StateView variant="loading" label="memberships open for registration" />
        )
      ) : open.length === 0 && !targets.hasNextPage ? (
        <Caption>No membership is open for registration right now.</Caption>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel="Membership to renew into">
          {open.map((o) => (
            <ChoiceRow
              key={o.id}
              mode="radio"
              label={o.name}
              detail={`${formatDateRange(o.startsOn, o.endsOn)}, ${o.facility.name}`}
              checked={targetId === o.id}
              onPress={() => {
                setTargetId(o.id);
                setMissing(false);
                setFailure(null);
              }}
            />
          ))}
        </View>
      )}
      <LoadMore pages={targets} label="memberships" />
      {missing ? <Caption>▲ Choose the membership to renew into.</Caption> : null}
      {failure ? (
        <CommandFailure
          error={failure}
          what="the renewal"
          onRetry={() => void submit()}
          onReload={() => {
            setFailure(null);
            renew.reset();
            void targets.refetch();
          }}
        />
      ) : null}
      {offline ? <Caption>Renewing needs a connection.</Caption> : null}
      <ButtonRow>
        <Button
          label="Add the renewal to a basket"
          onPress={() => void submit()}
          disabled={offline}
          busy={renew.isProcessing}
          accessibilityHint="Adds the renewal to a new basket; nothing is charged until checkout"
        />
        <Button label="Not now" variant="secondary" onPress={onClose} />
      </ButtonRow>
    </Section>
  );
}
