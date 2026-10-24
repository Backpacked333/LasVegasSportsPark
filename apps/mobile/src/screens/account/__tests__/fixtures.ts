/**
 * API fixtures for the account screen tests (SCR-C-01, SCR-C-02, SCR-C-17, SCR-C-30, SCR-C-31,
 * SCR-C-36). Shapes follow docs/api/openapi.json; names are invented test data, ids are opaque.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';

export const ORG = '0192f1a0-0000-7000-8000-00000000f001';
export const SELF = '0192f1a0-0000-7000-8000-00000000a001';
export const CHILD = '0192f1a0-0000-7000-8000-00000000b001';
export const CHILD_TWO = '0192f1a0-0000-7000-8000-00000000b002';
export const OTHER_ADULT = '0192f1a0-0000-7000-8000-00000000a002';
export const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd';

const AT = '2026-10-20T10:00:00.000Z';

export function person(
  id: string,
  givenName: string,
  familyName: string,
  kind: 'adult' | 'child' = 'adult',
) {
  return {
    id,
    kind,
    givenName,
    familyName,
    dateOfBirth: null,
    status: 'active',
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
  };
}

export function contactPoint(
  id: string,
  personId: string,
  kind: 'email' | 'phone',
  value: string,
  verified: boolean,
) {
  return {
    id,
    personId,
    kind,
    value,
    isPrimary: true,
    verifiedAt: verified ? AT : null,
    createdAt: AT,
  };
}

export function personDetail(
  p: ReturnType<typeof person>,
  contactPoints: ReturnType<typeof contactPoint>[] = [],
) {
  return { ...p, contactPoints };
}

export function me(options: {
  person?: ReturnType<typeof person> | null;
  authorities?: { subjectPersonId: string; permissions: string[] }[];
}) {
  const p = options.person === undefined ? person(SELF, 'Alex', 'Morgan') : options.person;
  return {
    principal: {
      kind: 'customer',
      organizationId: ORG,
      accountId: '0192f1a0-0000-7000-8000-0000000000aa',
      personId: p ? p.id : null,
      staffRoles: [],
      facilityIds: [],
    },
    person: p,
    staffMemberships: [],
    authorities: options.authorities ?? [],
  };
}

export const ok = (body: unknown) => ({ status: 200, body });

export const apiError = (
  status: number,
  code: string,
  overrides: Parameters<typeof apiErrorBody>[1] = {},
) => fakeResponse(status, apiErrorBody(code, overrides));

/** `GET /people/{id}` answering for the given people and NOT_FOUND for anyone else (§4.10). */
export function peopleRoute(people: ReturnType<typeof person>[]) {
  return (request: { params: Record<string, string> }) => {
    const found = people.find((p) => p.id === request.params.id);
    return found
      ? fakeResponse(200, personDetail(found))
      : fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }));
  };
}
