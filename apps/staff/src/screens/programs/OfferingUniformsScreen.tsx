/**
 * Uniforms of a class or a team (SPK-REG-012, proposed amendment PA-07; capability `uniforms`,
 * pending DEC-101): for an offering (`/programs/offerings/:offeringId/uniforms`), optionally one
 * team entry of it (`?team=<team entry reference>`), what was ordered, in which size, whether it
 * is paid, and whether it was handed over, by whom and when (`GET /v1/uniform-orders`).
 *
 * Handing over is a command that records who handed it over and when
 * (`POST /v1/uniform-orders/{id}/hand-over`). It is undone only by a recorded correction with a
 * reason (`POST /v1/uniform-orders/{id}/hand-over-corrections`); nothing is rewritten.
 *
 * - With the capability off the list of existing orders stays readable (the API keeps reads
 *   available), under the "turned off" notice; hand-over is not offered.
 * - "Paid" follows the registration: a uniform is paid when its registration is confirmed, and a
 *   uniform that is not charged is paid with nothing owed. Nothing here takes or implies payment.
 * - Stock is not counted and jersey numbers stay on the team roster (SPK-COMP-005).
 * - Offline: commands are disabled; what is shown is marked with its age.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { SelectField, TextArea } from '../../features/registration-finance/fields';
import { formatInstant, formatMoney } from '../../features/registration-finance/format';
import { OfferingName } from '../../features/registration-finance/names';
import { PENDING } from '../../features/registration-finance/pending';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { CommandButton } from '../../ui/CommandButton';
import { Toolbar } from '../../ui/glass/GlassCard';
import { PageHeader } from '../../ui/Page';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import '../../features/grow/grow.css';

type UniformOrder = Schema<'UniformOrder'>;
type Filter = 'all' | 'to_hand_over' | 'handed_over' | 'awaiting_payment';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDERS_KEY = ['api', '/uniform-orders'] as const;

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All uniforms' },
  { value: 'to_hand_over', label: 'Paid, to hand over' },
  { value: 'handed_over', label: 'Handed over' },
  { value: 'awaiting_payment', label: 'Awaiting payment' },
];

const STATUS: Record<UniformOrder['status'], { tone: StatusTone; label: string }> = {
  ordered: { tone: 'pending', label: 'ordered' },
  paid: { tone: 'info', label: 'paid' },
  handed_over: { tone: 'success', label: 'handed over' },
  canceled: { tone: 'neutral', label: 'canceled' },
};

function matches(order: UniformOrder, filter: Filter): boolean {
  if (filter === 'to_hand_over') return order.status === 'paid';
  if (filter === 'handed_over') return order.status === 'handed_over';
  if (filter === 'awaiting_payment') return order.status === 'ordered';
  return true;
}

/** "Paid", "Awaiting payment", or that nothing is owed for a uniform that is not charged. */
function paidState(order: UniformOrder): string {
  if (order.status === 'canceled') return 'Canceled with the registration';
  if (order.status === 'ordered') {
    return order.priceMinor === null || order.priceMinor === 0
      ? 'Not charged; awaiting the registration'
      : 'Awaiting payment';
  }
  if (order.priceMinor === null || order.priceMinor === 0) return 'Not charged';
  return `Paid${order.paidAt ? ` ${formatInstant(order.paidAt)}` : ''}`;
}

function OrderRow({ order, canHandOver }: { order: UniformOrder; canHandOver: boolean }) {
  const handOver = useApiCommand('post', '/uniform-orders/{id}/hand-over', {
    invalidate: [ORDERS_KEY],
  });
  const correct = useApiCommand('post', '/uniform-orders/{id}/hand-over-corrections', {
    invalidate: [ORDERS_KEY],
  });
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState('');
  const who = order.participantDisplayName ?? 'Participant';
  return (
    <tr>
      <th scope="row">
        {who}
        <div className="caption">
          <Link to={`/registrations/enrollments/${order.enrollmentId}`}>Registration</Link>
        </div>
      </th>
      <td>
        {order.name}, size {order.size}
        <div className="caption">
          {order.priceMinor !== null && order.currency
            ? formatMoney(order.priceMinor, order.currency)
            : 'Not charged'}
        </div>
      </td>
      <td>
        <StatusBadge {...STATUS[order.status]} />
        <div className="caption">{paidState(order)}</div>
      </td>
      <td>
        {order.handedOverAt
          ? `${formatInstant(order.handedOverAt)}${order.handedOverBy ? ` by ${order.handedOverBy}` : ''}`
          : 'Not handed over'}
      </td>
      <td>
        {canHandOver && order.status === 'paid' ? (
          <CommandButton
            busy={handOver.isProcessing}
            aria-label={`Hand over to ${who}`}
            onClick={() => {
              handOver
                .submit({ path: { id: order.id }, body: { expectedRevision: order.revision } })
                .catch(() => undefined);
            }}
          >
            Hand over
          </CommandButton>
        ) : null}
        {canHandOver && order.status === 'handed_over' ? (
          correcting ? (
            <form
              noValidate
              aria-label={`Undo the hand-over to ${who}`}
              onSubmit={(event) => {
                event.preventDefault();
                if (reason.trim().length < 3) return;
                correct
                  .submit({
                    path: { id: order.id },
                    body: { reason: reason.trim(), expectedRevision: order.revision },
                  })
                  .then(() => {
                    setCorrecting(false);
                    setReason('');
                  })
                  .catch(() => undefined);
              }}
            >
              <TextArea
                label={`Reason for undoing the hand-over to ${who}`}
                required
                hint="Recorded as a correction; the hand-over record is kept."
                value={reason}
                onChange={setReason}
                error={fieldErrorsOf(correct.error).reason}
              />
              <div className="rf-actions">
                <CommandButton
                  type="submit"
                  busy={correct.isProcessing}
                  disabled={reason.trim().length < 3}
                >
                  Record the correction
                </CommandButton>
                <Button variant="secondary" onClick={() => setCorrecting(false)}>
                  Keep the hand-over
                </Button>
              </div>
            </form>
          ) : (
            <Button
              variant="secondary"
              aria-label={`Undo the hand-over to ${who}`}
              onClick={() => setCorrecting(true)}
            >
              Undo…
            </Button>
          )
        ) : null}
        <CommandError error={handOver.error} />
        <CommandError error={correct.error} />
      </td>
    </tr>
  );
}

export function OfferingUniformsScreen() {
  const { offeringId = '' } = useParams();
  const [search] = useSearchParams();
  const team = search.get('team') ?? '';
  const teamEntryId = UUID.test(team) ? team : '';
  const [filter, setFilter] = useState<Filter>('all');
  const permissions = usePermissions();
  const capabilityOn = permissions.isCapabilityEnabled('uniforms') === true;
  const orders = useApiQuery({
    path: '/uniform-orders',
    request: { query: { offeringId, ...(teamEntryId ? { teamEntryId } : {}) } },
    enabled: UUID.test(offeringId),
  });
  const all = orders.data ?? [];
  const live = all.filter((o) => o.status !== 'canceled');
  const eyebrow = [
    'Grow · Programs and camps',
    orders.data
      ? `${live.length} ${live.length === 1 ? 'uniform' : 'uniforms'} ordered, ${
          live.filter((o) => o.status === 'handed_over').length
        } handed over`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section aria-labelledby="uniforms-title" className="grow">
      <PageHeader
        eyebrow={eyebrow}
        title="Uniforms"
        titleId="uniforms-title"
        intro={
          <>
            <OfferingName id={offeringId} />
            {teamEntryId ? ', one team entry' : ''}: what was ordered, what is paid and what was
            handed over. Proposed, pending {PENDING.uniforms.ids.join(', ')} (owner:{' '}
            {PENDING.uniforms.owner}).
          </>
        }
        actions={<Link to={`/programs/offerings/${offeringId}`}>Back to the offering</Link>}
      />
      <CapabilityGate
        capability="uniforms"
        whenOff="notice"
        stillAvailable="Uniforms already ordered stay listed; hand-over is not offered."
      >
        <Toolbar role="group" aria-label="Uniform filters">
          <SelectField
            label="Show"
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            options={FILTERS}
          />
        </Toolbar>
        <QueryBoundary
          query={orders}
          label="uniforms"
          isEmpty={(list) => list.length === 0}
          empty={{
            title: 'No uniforms ordered',
            description:
              'A uniform appears here when a registration that chose one is held or paid.',
          }}
          unavailableOffline={['handing over a uniform', 'correcting a hand-over']}
        >
          {(list) => {
            const shown = list.filter((order) => matches(order, filter));
            return shown.length === 0 ? (
              <p className="caption">No uniform matches this filter.</p>
            ) : (
              <div className="card rf-table-wrap">
                <table className="rf-table" aria-label="Uniforms ordered">
                  <thead>
                    <tr>
                      <th scope="col">Participant</th>
                      <th scope="col">Uniform</th>
                      <th scope="col">Paid</th>
                      <th scope="col">Handed over</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((order) => (
                      <OrderRow key={order.id} order={order} canHandOver={capabilityOn} />
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        </QueryBoundary>
      </CapabilityGate>
    </section>
  );
}
