-- 0806_entry_device_registrant_fk.sql
-- Entry module, ENT-05 (INTEGRITY-07): the person who registered an access device is referenced
-- with the organization-scoped composite key (§4.3, CLAUDE.md data rules), like every other
-- `*_by_person_id` of the entry tables, so a device can never name a registrant who does not exist
-- or belongs to another organization. AccessDevicesService writes the registering principal's
-- person (null for a system principal, which the foreign key allows). Identity never deletes a
-- person.

alter table access_devices
  add constraint access_devices_registered_by_person_fk
    foreign key (organization_id, registered_by_person_id) references persons (organization_id, id);
