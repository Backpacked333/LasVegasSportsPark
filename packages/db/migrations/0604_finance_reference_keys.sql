-- 0604_finance_reference_keys.sql
-- §4.3, §4.7 invariant 1, CLAUDE.md "references between org-scoped tables use composite foreign
-- keys so a row can never point at another organization's record"
-- (review2 data-and-contracts-2-08).
--
-- Journal entry attribution (person, order, obligation) and a quote's consuming checkout had no
-- foreign key at all, so a ledger line could name another organization's person or obligation.
-- They are now organization-scoped composite foreign keys (persons is identity's table; its
-- (organization_id, id) key is the one every module references).
alter table journal_entries
  add constraint journal_entries_person_fk
    foreign key (organization_id, person_id) references persons (organization_id, id),
  add constraint journal_entries_order_fk
    foreign key (organization_id, order_id) references orders (organization_id, id),
  add constraint journal_entries_obligation_fk
    foreign key (organization_id, obligation_id) references obligations (organization_id, id);
alter table quotes
  add constraint quotes_consumed_by_checkout_fk
    foreign key (organization_id, consumed_by_checkout_id) references checkouts (organization_id, id);

-- The provider evidence of a payment or refund attempt references the kernel inbox by id only:
-- inbox_events has no (organization_id, id) key (its organization is resolved from the event and
-- may be unknown), so the organization is checked here, like support's case_actions_scope, until
-- the kernel adds that key.
create or replace function finance_evidence_inbox_scope() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from inbox_events e
    where e.id = new.evidence_inbox_event_id and e.organization_id = new.organization_id
  ) then
    raise exception '% %: inbox event % belongs to another organization', tg_table_name, new.id,
      new.evidence_inbox_event_id
      using errcode = 'foreign_key_violation', constraint = tg_table_name || '_evidence_inbox_scope';
  end if;
  return new;
end
$$;
create trigger payment_attempts_evidence_inbox_scope
  before insert or update of evidence_inbox_event_id, organization_id on payment_attempts
  for each row when (new.evidence_inbox_event_id is not null)
  execute function finance_evidence_inbox_scope();
create trigger refund_attempts_evidence_inbox_scope
  before insert or update of evidence_inbox_event_id, organization_id on refund_attempts
  for each row when (new.evidence_inbox_event_id is not null)
  execute function finance_evidence_inbox_scope();
