/**
 * Renew a membership at checkout (Package G; ENR-12, SPK-COND-001; capability `memberships`,
 * DEC-016, DEC-072). `POST /v1/enrollments/{id}/renew` adds the renewal of the membership offering
 * the customer chooses to a new cart; nothing is charged until checkout (cart, review and
 * checkout, SCR-C-11 to SCR-C-15). Customer words (PA-11): "cart", never "basket". The app never
 * renews automatically, never preselects a target and never states a renewal price: the cart's
 * price summary does (automatic renewal and member pricing are not specified, POL-038, DEC-007).
 *
 * Targets: membership offerings open for registration (`GET /v1/offerings?kind=membership`, cursor
 * pages). The API checks eligibility, the participant's authority (PARTICIPANT_AUTHORITY_REQUIRED
 * is "not available to your account") and the switch (CAPABILITY_DISABLED shows "turned off").
 * One idempotency key per renewal intent; a retry after no answer reuses it.
 *
 * States: loading targets; empty (none open); ready; validation (no target chosen); offline;
 * processing; failure with the code; success (opens the cart).
 */
import type { ApiError } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { CommandFailure } from '../../features/money/CommandFailure';
import { formatDateRange } from '../../features/money/format';
import { ChoiceCard } from '../../ui/ChoiceList';
import { registrationRoutes } from '../../features/registration/routes';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { FieldErrorText } from '../../ui/Field';
import { LoadMore } from '../../ui/LoadMore';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { makeStyles, spacing } from '../../ui/theme';
import { Actions } from '../../features/money/surfaces';

const CHOICE_LABEL = 'Membership to renew into';

export function RenewMembership({
  enrollmentId,
  onClose,
}: {
  enrollmentId: string;
  onClose: () => void;
}) {
  const styles = useStyles();
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
  const missingError = missing ? 'Choose the membership to renew into.' : null;
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
      <Text variant="caption" tone="muted">
        Renewing adds the membership you choose to a new cart. Nothing is charged until you check
        out, where the price is shown.
      </Text>
      {targets.data === undefined ? (
        targets.error ? (
          <QueryErrorView error={targets.error} onRetry={() => void targets.refetch()} />
        ) : (
          <StateView variant="loading" label="memberships open for registration" />
        )
      ) : open.length === 0 && !targets.hasNextPage ? (
        <Text variant="caption" tone="muted">
          No membership is open for registration right now.
        </Text>
      ) : (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={CHOICE_LABEL}
          accessibilityHint={missingError ? `Error: ${missingError}` : undefined}
          style={styles.choices}
        >
          {open.map((o) => (
            <ChoiceCard
              key={o.id}
              mode="single"
              option={{
                value: o.id,
                label: o.name,
                description: `${formatDateRange(o.startsOn, o.endsOn)}, ${o.facility.name}`,
              }}
              checked={targetId === o.id}
              error={missingError}
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
      {/* Announced when it appears, like every field error (SPK-UX-009). */}
      <FieldErrorText error={missingError} glyph="▲" testID="renew-target-error" />
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
      {offline ? (
        <Text variant="caption" tone="muted">
          Renewing needs a connection.
        </Text>
      ) : null}
      <Actions>
        <Button
          label="Add the renewal to your cart"
          onPress={() => void submit()}
          disabled={offline}
          busy={renew.isProcessing}
          accessibilityHint="Adds the renewal to a new cart; nothing is charged until checkout"
        />
        <Button label="Not now" variant="secondary" onPress={onClose} />
      </Actions>
    </Section>
  );
}

const useStyles = makeStyles(() => ({
  choices: { gap: spacing.sm },
}));
