-- 0504_enrollment_customer_read_indexes.sql
-- Enrollment module, ENR-01 / ENR-02 (SPK-REG-008, SPK-UX-001, §4.5 "scoped, paginated queries"):
-- the customer lists and the staff lists page with a keyset on (created_at desc, id desc).
--
-- GET /v1/me/waitlist-entries reads a person's entries newest first; no index led with the
-- participant. Baskets (baskets_owner_idx), applications (applications_participant_idx) and trial
-- participations (trial_participations_participant_idx) already have one; the staff lists of
-- enrollments and placement requests page within an offering or a season.
create index waitlist_entries_participant_idx
  on waitlist_entries (organization_id, participant_person_id, created_at desc, id);

create index enrollments_created_idx
  on enrollments (organization_id, created_at desc, id);

create index placement_requests_season_created_idx
  on placement_requests (organization_id, season_id, created_at desc, id);
