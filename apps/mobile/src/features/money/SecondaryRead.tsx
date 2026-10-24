/**
 * A secondary read on a money screen (the order or the installment plan beside a balance, the
 * payment summary beside an enrollment) with its own SPK-UX-008 states: loading, not available
 * only for a protected NOT_FOUND or a permission restriction, offline with "Try again", and any
 * other error with its code and "Try again". Never silently missing, never a permission message
 * for what is only loading or failed.
 */
import type { ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { Section } from './ui';

export interface SecondaryQuery<T> {
  data: T | undefined;
  error: ApiError | null;
  refetch: () => unknown;
}

export function SecondaryRead<T>({
  query,
  label,
  title,
  unavailable,
  children,
}: {
  query: SecondaryQuery<T>;
  /** What is loading, for the announcement: "the order". */
  label: string;
  /** The section title shown around a loading or error state. */
  title: string;
  /** Words for "not available" here; default: the generic wording. */
  unavailable?: { title?: string; description?: string };
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  return (
    <Section title={title}>
      {query.error ? (
        <QueryErrorView
          error={query.error}
          onRetry={() => void query.refetch()}
          unavailable={unavailable}
        />
      ) : (
        <StateView variant="loading" label={label} />
      )}
    </Section>
  );
}
