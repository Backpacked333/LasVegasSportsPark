-- 0703_workforce_fee_adjustment_currency.sql
-- SPK-PAY-001 / SPK-STAFF-006 (amounts in different currencies never mix), CLAUDE.md "integrity
-- that matters is enforced in the database" (review2 data-and-contracts-2-07).
--
-- A fee adjustment carries the currency of the submission it adjusts: it names the submission
-- together with that currency through a composite foreign key (0700's (organization_id,
-- fee_submission_id) key stays; this implies it).
alter table fee_submissions
  add constraint fee_submissions_organization_id_id_currency_key unique (organization_id, id, currency);
alter table fee_adjustments
  add constraint fee_adjustments_submission_currency_fk
    foreign key (organization_id, fee_submission_id, currency)
    references fee_submissions (organization_id, id, currency);
