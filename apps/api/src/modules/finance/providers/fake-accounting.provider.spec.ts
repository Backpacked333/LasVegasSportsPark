import { describe, expect, it } from 'vitest';
import type { AccountingBatchSubmission } from '../finance.ports';
import { FakeAccountingProvider } from './fake-accounting.provider';

const submission = (key: string): AccountingBatchSubmission => ({
  organizationId: '01a18600-0000-7000-8000-000000000001',
  batchId: '01a18600-0000-7000-8000-000000000002',
  idempotencyKey: key,
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  lines: [
    {
      journalEntryId: '01a18600-0000-7000-8000-000000000003',
      externalAccountRef: '4000',
      debitMinor: 0,
      creditMinor: 5000,
      currency: 'USD',
      postedAt: '2026-10-05T12:00:00.000Z',
      memo: 'registration revenue',
    },
  ],
  checksum: 'sha256:abc',
});

describe('FakeAccountingProvider (IF-37, §5.2 accounting gate, DEC-022)', () => {
  it('success, failure, timeout with an unknown outcome, and duplicates returning the first outcome', async () => {
    const fake = new FakeAccountingProvider();
    expect(await fake.submitBatch(submission('k1'))).toEqual({
      outcome: 'accepted',
      providerReference: 'fa_k1',
    });
    // A duplicate submission returns the first outcome and records nothing new.
    fake.scriptSubmissions('reject');
    expect((await fake.submitBatch(submission('k1'))).outcome).toBe('accepted');
    expect(fake.recordedBatches()).toBe(1);
    expect((await fake.submitBatch(submission('k2'))).outcome).toBe('rejected');

    fake.scriptSubmissions('timeout_accepted', 'timeout_lost');
    expect((await fake.submitBatch(submission('k3'))).outcome).toBe('unknown');
    expect((await fake.submitBatch(submission('k4'))).outcome).toBe('unknown');
    const s = submission('k3');
    // Reconciliation: the timed-out batch the provider kept reads accepted; the lost one is absent.
    expect(
      await fake.batchStatus({
        organizationId: s.organizationId,
        batchId: s.batchId,
        idempotencyKey: 'k3',
      }),
    ).toEqual({ outcome: 'accepted', providerReference: 'fa_k3' });
    expect(
      await fake.batchStatus({
        organizationId: s.organizationId,
        batchId: s.batchId,
        idempotencyKey: 'k4',
      }),
    ).toEqual({ outcome: 'not_found' });
    // Another organization never reads this organization's batch.
    expect(
      await fake.batchStatus({
        organizationId: '01a18600-0000-7000-8000-0000000000ff',
        batchId: s.batchId,
        idempotencyKey: 'k3',
      }),
    ).toEqual({ outcome: 'not_found' });
    expect(fake.submissions).toHaveLength(5);
  });
});
