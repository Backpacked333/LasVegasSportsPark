/**
 * SCR-S-37 one refund (SPK-PAY-008, SPK-AT-007): its state and reservation, the payment's
 * refundable figures, and, while the outcome is not final, "Reconcile from provider evidence"
 * (`POST /v1/refunds/{id}/reconcile`, idempotency key per intent). The RefundMachine lets
 * `unknown` become only `succeeded` or `failed`; until then the reservation is retained.
 */
import { useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { shortRef } from '../../features/registration-finance/format';
import { REFUND_STATUS } from '../../features/registration-finance/labels';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { RefundView } from '../../features/registration-finance/RefundView';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';

const OPEN_REFUND = new Set(['requested', 'processing', 'unknown']);

export function RefundScreen() {
  const { refundId = '' } = useParams();
  const online = useOnline();
  const refund = useApiQuery({ path: '/refunds/{id}', request: { path: { id: refundId } } });
  const reconcile = useApiCommand('post', '/refunds/{id}/reconcile', {
    invalidate: [
      ['api', '/refunds/{id}'],
      ['api', '/exceptions'],
    ],
  });
  const run = () => reconcile.submit({ path: { id: refundId } }).catch(() => undefined);
  return (
    <section aria-labelledby="refund-title">
      <h2 id="refund-title">Refund {shortRef(refundId)}</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <QueryBoundary
        query={refund}
        label="the refund"
        empty={{ title: '', description: '' }}
        unavailableOffline={['reconciling']}
      >
        {(data) => (
          <>
            <RefundView refund={data} />
            {OPEN_REFUND.has(data.status) ? (
              <div className="rf-actions">
                <Button busy={reconcile.isProcessing} disabled={!online} onClick={run}>
                  Reconcile from provider evidence
                </Button>
              </div>
            ) : null}
          </>
        )}
      </QueryBoundary>
      <OfflineCaption action="reconciling" />
      {reconcile.data ? (
        <p role="status">
          Refund now {REFUND_STATUS[reconcile.data.status].label}.
          {OPEN_REFUND.has(reconcile.data.status)
            ? ' The reservation is kept until the provider confirms.'
            : ''}
        </p>
      ) : null}
      <CommandError error={reconcile.error} onRetry={run} />
    </section>
  );
}
