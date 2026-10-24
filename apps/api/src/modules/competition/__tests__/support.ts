import type { Provider } from '@nestjs/common';
import { newId, type StaffRole } from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { CompetitionModule } from '../competition.module';

/** Shared helpers for the competition API tests (not a spec file). */

export const CLOCK_START = '2026-10-23T12:00:00Z';

export const key = (): string => `k-${newId()}`;

export function competitionTestApp(
  options: { providers?: Provider[]; clockStart?: string } = {},
): Promise<TestApp> {
  return createTestApp({
    imports: [CompetitionModule],
    principalResolver: 'module',
    clockStart: options.clockStart ?? CLOCK_START,
    providers: options.providers,
  });
}

export interface Actor {
  personId: string;
  accountId: string;
  header: { Authorization: string };
}

/** An adult customer with an active account whose token resolves through the real resolver. */
export async function adultCustomer(
  t: TestApp,
  input: { dateOfBirth?: string | null; organizationId?: string } = {},
): Promise<Actor> {
  const personId = await createPersonFixture(t, {
    kind: 'adult',
    dateOfBirth: input.dateOfBirth,
    organizationId: input.organizationId,
  });
  const account = await createAccountFixture(t, {
    personId,
    organizationId: input.organizationId,
  });
  return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
}

export async function staffMember(
  t: TestApp,
  roles: StaffRole[],
  organizationId?: string,
): Promise<Actor> {
  const staff = await createStaffMemberFixture(t, { roles, organizationId });
  return {
    personId: staff.personId,
    accountId: staff.accountId,
    header: await authHeaderForPerson(t, staff.personId),
  };
}

/** `forbid_mutation` raises `restrict_violation` (SQLSTATE 23001). */
export function isRestrictViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23001';
}
