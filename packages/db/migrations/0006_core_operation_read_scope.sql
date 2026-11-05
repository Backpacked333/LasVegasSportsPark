-- §4.14 least privilege and object-level authorization, §4.8 "GET /v1/operations/{id} reads an
-- authorized outcome": an operation records who may read its outcome besides its requester. The
-- owning module names its own read action and the facility and subject persons it concerns, and
-- the kernel evaluates those instead of granting every staff role the organization's outcomes.
-- Operations created without a scope keep the kernel's `operations.read` (no facility, no subjects).
alter table operations
  add column read_action text check (read_action is null or length(read_action) between 1 and 200),
  add column facility_id uuid,
  add column subject_person_ids uuid[] not null default '{}',
  add constraint operations_facility_fk
    foreign key (organization_id, facility_id) references facilities (organization_id, id);
