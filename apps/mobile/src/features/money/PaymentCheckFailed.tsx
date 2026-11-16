/**
 * SCR-C-34 (SPK-PAY-007, SPK-UX-008): the read that finds a payment still on its way
 * (`useOrderPayments`, `GET /v1/me/payments?purpose=`) failed, so a record may read "Not paid yet"
 * although its payment is being confirmed. The failure is said with its code and "Try again";
 * offline and "not available" add nothing here (the banner and the list's own states cover them).
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { View } from 'react-native';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { Text } from '../../ui/Text';

export function PaymentCheckFailed({
  query,
  what,
}: {
  query: { data: unknown; error: ApiError | null; refetch: () => unknown };
  /** What the payments would be for: "these orders", "this order". */
  what: string;
}) {
  const error = query.data === undefined ? query.error : null;
  if (!error || presentationForError(error) !== 'error') return null;
  return (
    <View testID="payments-unchecked">
      <Text variant="caption" tone="muted">
        {`We could not check whether a payment for ${what} is on its way, so one being confirmed may not be shown. Do not pay again before checking.`}
      </Text>
      <QueryErrorView error={error} onRetry={() => void query.refetch()} />
    </View>
  );
}
