/**
 * SCR-S-48 External mappings (§5.3 external identifiers preserved; SPK-AT-024 stable identities):
 * lookup by identifiers only, at least one filter required, results with status and batches.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  BATCH_1,
  BATCH_2,
  NOW_ISO,
  page,
  uuid,
} from '../../../features/insight-admin/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';

describe('SCR-S-48 ExternalMappingsScreen', () => {
  it('looks up an external id and shows the stable internal record across batches', async () => {
    const user = userEvent.setup();
    const test = createTestApp({
      routes: {
        'GET /external-mappings': page([
          {
            id: uuid(70),
            sourceSystem: 'legacy-registration',
            entityType: 'person',
            externalId: 'P-1',
            status: 'linked',
            internalId: uuid(71),
            firstSeenBatchId: BATCH_1,
            lastSeenBatchId: BATCH_2,
            provenance: {},
            linkedAt: NOW_ISO,
            revision: 1,
            createdAt: NOW_ISO,
          },
        ]),
      },
    });
    render(test.at('/admin/migration/mappings'));
    await user.click(await screen.findByRole('button', { name: 'Look up' }));
    expect(screen.getByText('Enter at least one identifier or filter.')).toBeInTheDocument();
    expect(test.fake.requests.some((r) => r.route === '/external-mappings')).toBe(false);
    await user.type(screen.getByLabelText('External id'), 'P-1');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    const table = await screen.findByRole('region', { name: 'External mappings table' });
    expect(within(table).getByText('linked')).toBeInTheDocument();
    expect(
      within(table).getByText(`${BATCH_1.slice(0, 8)} / ${BATCH_2.slice(0, 8)}`),
    ).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/external-mappings')?.query).toEqual({
      limit: '100',
      externalId: 'P-1',
    });
  });
});
