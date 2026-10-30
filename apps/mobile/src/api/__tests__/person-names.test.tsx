/**
 * usePersonNames over GET /v1/person-names (ID-02; SPK-IAM-002, §4.10, §4.14): one read for a set
 * of ids, names only, a person the API leaves out is "not available", and a failed read keeps its
 * error and retry.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { renderHook, waitFor } from '@testing-library/react-native';
import { createTestApp } from '../../testing/test-app';
import { usePersonNames } from '../person-names';

const SELF = '0192f1a0-0000-7000-8000-00000000a001';
const CHILD = '0192f1a0-0000-7000-8000-00000000b001';
const STRANGER = '0192f1a0-0000-7000-8000-00000000c001';

function name(personId: string, givenName: string, kind: 'adult' | 'child') {
  return {
    personId,
    canonicalPersonId: personId,
    givenName,
    familyName: 'Morgan',
    displayName: `${givenName} Morgan`,
    kind,
  };
}

describe('usePersonNames (GET /v1/person-names)', () => {
  it('reads the deduplicated ids once and marks people the API omits as not available', async () => {
    const app = createTestApp({
      routes: {
        'GET /person-names': {
          status: 200,
          body: { items: [name(SELF, 'Alex', 'adult'), name(CHILD, 'Sam', 'child')] },
        },
      },
    });
    const { result } = renderHook(() => usePersonNames([CHILD, SELF, STRANGER, CHILD, null]), {
      wrapper: app.wrapper,
    });
    await waitFor(() => expect(result.current.get(CHILD)?.state).toBe('ready'));
    const child = result.current.get(CHILD);
    expect(child?.state === 'ready' ? child.name.givenName : null).toBe('Sam');
    expect(result.current.get(STRANGER)).toEqual({ state: 'unavailable' });
    const requests = app.fake.requests.filter((r) => r.route === '/person-names');
    expect(requests).toHaveLength(1);
    // One read, the ids sorted; no names, dates of birth or contacts in the request.
    expect(requests[0]?.path).toBe('/person-names');
  });

  it('a failed read keeps the error code and a retry; a refused read is not available', async () => {
    const failing = createTestApp({
      routes: {
        'GET /person-names': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      },
    });
    const failed = renderHook(() => usePersonNames([CHILD]), { wrapper: failing.wrapper });
    await waitFor(() => expect(failed.result.current.get(CHILD)?.state).toBe('error'));
    const entry = failed.result.current.get(CHILD);
    expect(entry?.state === 'error' ? entry.error.code : null).toBe('INTERNAL_ERROR');

    const denied = createTestApp({
      routes: { 'GET /person-names': { status: 403, body: apiErrorBody('ACCESS_DENIED') } },
    });
    const refused = renderHook(() => usePersonNames([CHILD]), { wrapper: denied.wrapper });
    await waitFor(() =>
      expect(refused.result.current.get(CHILD)).toEqual({ state: 'unavailable' }),
    );
  });
});
