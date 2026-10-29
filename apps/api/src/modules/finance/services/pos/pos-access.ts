import type { Principal } from '@sportspark/contracts';
import type { AuthorizationService, AuthorizationTargetInput } from '../../../../kernel';
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
