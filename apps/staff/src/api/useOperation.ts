/**
 * Follows an asynchronous outcome at `GET /v1/operations/{id}` until it is terminal (§4.8, §4.12,
 * SPK-UX-008 processing and recovery required). Polling stops at `succeeded`, `failed`,
 * `recovery_required` or `compensated`.
 */
import {
  apiQueryKey,
  isTerminalOperationStatus,
  type ApiResponse,
  type Schema,
} from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useApiQuery } from './useApiQuery';

export const OPERATION_POLL_MS = 2_000;

export function useOperation(operationId: string | null | undefined) {
  const queryClient = useQueryClient();
  const request = { path: { id: operationId ?? '' } };
  // The latest answer decides whether to keep polling; each answer re-renders the caller.
  const cached = queryClient.getQueryData<ApiResponse<Schema<'Operation'>>>(
    apiQueryKey('/operations/{id}', request),
  );
  const terminal = cached ? isTerminalOperationStatus(cached.data.status) : false;
  return useApiQuery({
    path: '/operations/{id}',
    request,
    enabled: Boolean(operationId),
    refetchInterval: terminal ? false : OPERATION_POLL_MS,
  });
}
