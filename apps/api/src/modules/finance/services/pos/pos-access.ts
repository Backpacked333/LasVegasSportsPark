import type { Principal } from '@sportspark/contracts';
import {
  listFacilityScope,
  type AuthorizationService,
  type AuthorizationTargetInput,
} from '../../../../kernel';
import { FinanceActions } from '../../finance.actions';

/**
 * Who reads point-of-sale records (FIN-06, §4.14, SPK-UX-005): the finance readers of
 * `finance.read_pos` (or `finance.read_pos_receipt`, which also lets the customer the sale names
 * read their receipt), and the desk staff who operate registers at the record's facility
 * (`finance.operate_register`): reading a sale, a session or the product list is part of running
 * the register, so the front desk holds no separate finance read and the finance area stays a
 * finance operator's area. Neither path checks the `point_of_sale` capability: reads are never
 * gated (DEC-016). A caller allowed by neither gets the read action's own refusal (NOT_FOUND for a
 * protected receipt, §4.10).
 */
export async function requirePosRead(
  authorization: AuthorizationService,
  principal: Principal,
  action: typeof FinanceActions.readPos | typeof FinanceActions.readPosReceipt,
  target: AuthorizationTargetInput,
): Promise<void> {
  if ((await authorization.decide(principal, action, target)).allowed) return;
  if (principal.kind === 'staff') {
    const desk = await authorization.decide(principal, FinanceActions.operateRegister, {
      ...target,
      protected: false,
    });
    if (desk.allowed) return;
  }
  await authorization.require(principal, action, target);
}

/**
 * The facilities a point-of-sale list without a `facilityId` is narrowed to (§4.3, §4.14 least
 * privilege; the list counterpart of `requirePosRead`'s per-record facility check): the union of
 * the facilities covered by the roles holding `finance.read_pos` and those holding
 * `finance.operate_register`. `null` when the list is not narrowed (not a staff principal, or one
 * of those roles is organization-wide); an empty array means the caller sees no facility's rows.
 */
export function posListFacilityScope(principal: Principal): readonly string[] | null {
  if (principal.kind !== 'staff') return null;
  const read = listFacilityScope(principal, FinanceActions.readPos);
  const desk = listFacilityScope(principal, FinanceActions.operateRegister);
  if (read === null || desk === null) return null;
  return [...new Set([...read, ...desk])].sort();
}
