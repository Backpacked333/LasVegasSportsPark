-- 0603_finance_currency_bound_references.sql
-- SPK-PAY-001 (money is minor units next to its currency; amounts in different currencies never
-- mix), CLAUDE.md "integrity that matters is enforced in the database"
-- (review2 data-and-contracts-2-07).
--
-- 0600 checks the currency of journal entries against their journal and of payment allocations
-- against their obligation, but a row that draws on another money record could still carry a
-- different currency than that record: a USD credit redeemed as EUR, a EUR refund of a USD
-- payment, a contribution request, quote or order line, or installment in another currency than
-- its obligation, quote, order or plan. Each such row now names its parent together with the
-- parent's currency through a composite foreign key. The parents' currency is immutable (0600
-- guard triggers), so the key never needs to cascade. The existing (organization_id, id) keys
-- stay: these imply them.
alter table credits
  add constraint credits_organization_id_id_currency_key unique (organization_id, id, currency);
alter table payment_attempts
  add constraint payment_attempts_organization_id_id_currency_key unique (organization_id, id, currency);
alter table obligations
  add constraint obligations_organization_id_id_currency_key unique (organization_id, id, currency);
alter table quotes
  add constraint quotes_organization_id_id_currency_key unique (organization_id, id, currency);
alter table orders
  add constraint orders_organization_id_id_currency_key unique (organization_id, id, currency);
alter table installment_plans
  add constraint installment_plans_organization_id_id_currency_key unique (organization_id, id, currency);

alter table credit_redemptions
  add constraint credit_redemptions_credit_currency_fk
    foreign key (organization_id, credit_id, currency) references credits (organization_id, id, currency);
alter table refund_attempts
  add constraint refund_attempts_payment_currency_fk
    foreign key (organization_id, payment_attempt_id, currency)
    references payment_attempts (organization_id, id, currency);
alter table contribution_requests
  add constraint contribution_requests_obligation_currency_fk
    foreign key (organization_id, obligation_id, currency) references obligations (organization_id, id, currency);
alter table quote_lines
  add constraint quote_lines_quote_currency_fk
    foreign key (organization_id, quote_id, currency) references quotes (organization_id, id, currency);
alter table order_lines
  add constraint order_lines_order_currency_fk
    foreign key (organization_id, order_id, currency) references orders (organization_id, id, currency);
alter table installments
  add constraint installments_plan_currency_fk
    foreign key (organization_id, plan_id, currency) references installment_plans (organization_id, id, currency),
  add constraint installments_obligation_currency_fk
    foreign key (organization_id, obligation_id, currency) references obligations (organization_id, id, currency);
