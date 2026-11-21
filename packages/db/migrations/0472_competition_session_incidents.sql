-- 0472_competition_session_incidents.sql
-- Competition module: an operational incident or injury reported from a program session
-- (staff S 4d "Coach · report an injury"; SPK-DISC-001 operational incidents, SPK-DISC-005,
-- SPK-STAFF-005). Until now an incident could name a fixture only, so a coach of a class could not
-- report a child's injury. The session and its facility are recorded with the incident:
--
--   offering_session_id  the catalog session it happened in (composite reference, §4.3);
--   facility_id          the facility of that session (where the manager's Today issue belongs).
--
-- A session incident is an injury or an operational incident, never a card or misconduct (those
-- are match facts), names its facility and no fixture. Existing incidents keep both null.

alter table incidents add column offering_session_id uuid;
alter table incidents add column facility_id uuid;

alter table incidents
  add constraint incidents_offering_session_fk
  foreign key (organization_id, offering_session_id)
  references offering_sessions (organization_id, id);

alter table incidents
  add constraint incidents_facility_fk
  foreign key (organization_id, facility_id)
  references facilities (organization_id, id);

alter table incidents
  add constraint incidents_session_shape check (
    offering_session_id is null
    or (kind in ('injury', 'operational') and facility_id is not null and fixture_id is null)
  );

create index incidents_session_idx
  on incidents (organization_id, offering_session_id)
  where offering_session_id is not null;
