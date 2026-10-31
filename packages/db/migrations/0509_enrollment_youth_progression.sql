-- 0509_enrollment_youth_progression.sql
-- Enrollment module, ENR-14: youth development records and progression recommendations
-- (SPK-YOUTH-005, SPK-YOUTH-006, SPK-COMMS-002). The owning module is Proposed (§4.4 names no
-- entity); whether the complex records youth progression is pending (DEC-016; templates, scales
-- and family-visible feedback DEC-003, DEC-054; what a recommendation may use DEC-055). The
-- commands that author, review or share check the organization's `youth_progression` switch.
--
--   * assessment_templates: an approved template names the skill areas and the ordinal scale an
--     assessment uses; versions are rows (program, name, version is unique).
--   * assessments: one observation of one skill area. Family-visible feedback is published only
--     after a program manager other than the author approves it; staff notes are never
--     family-facing. Published and recorded rows are immutable; a correction is a new row that
--     references the one it corrects.
--   * progression_recommendations: a suggested next offering or program with the read-only
--     eligibility the evaluator gave (unknown kept). A recommendation never holds capacity or
--     guarantees acceptance, availability or purchase.

create table assessment_templates (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  program_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  version integer not null default 1 check (version >= 1),
  skill_areas jsonb not null,
  scale jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  authored_by_person_id uuid,
  authored_by jsonb not null,
  approved_by_person_id uuid,
  approved_at timestamptz,
  retired_at timestamptz,
  retired_reason text check (retired_reason is null or length(retired_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, program_id, name, version),
  foreign key (organization_id, program_id) references programs (organization_id, id),
  foreign key (organization_id, authored_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, approved_by_person_id) references persons (organization_id, id),
  check (jsonb_typeof(skill_areas) = 'array' and jsonb_array_length(skill_areas) between 1 and 50),
  check (
    jsonb_typeof(scale) = 'object'
    and scale->>'kind' = 'ordinal'
    and jsonb_typeof(scale->'levels') = 'array'
    and jsonb_array_length(scale->'levels') between 2 and 20
  ),
  constraint assessment_templates_approved_fact check (status = 'draft' or status = 'retired' or approved_at is not null),
  constraint assessment_templates_retired_fact check ((status = 'retired') = (retired_at is not null))
);
create trigger assessment_templates_touch before update on assessment_templates
  for each row execute function touch_updated_at();

-- AssessmentTemplateMachine (ENR-10): draft → approved | retired; approved → retired.
create or replace function assessment_templates_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    if old.status <> 'draft' and (new.skill_areas <> old.skill_areas or new.scale <> old.scale) then
      raise exception 'assessment template % is % and its content is fixed', old.id, old.status
        using errcode = 'check_violation', constraint = 'assessment_templates_machine';
    end if;
    return new;
  end if;
  if (old.status = 'draft' and new.status in ('approved', 'retired'))
     or (old.status = 'approved' and new.status = 'retired') then
    return new;
  end if;
  raise exception 'assessment template % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'assessment_templates_machine';
end
$$;
create trigger assessment_templates_transition_guard before update on assessment_templates
  for each row execute function assessment_templates_transition_guard();

create table assessments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  template_id uuid not null,
  participant_person_id uuid not null,
  offering_id uuid not null,
  skill_area_key text not null check (length(skill_area_key) between 1 and 100),
  observed_on date not null,
  scale_value integer not null,
  comments text check (comments is null or length(comments) <= 4000),       -- family-facing when visibility = family
  staff_note text check (staff_note is null or length(staff_note) <= 4000), -- never shown to families
  visibility text not null check (visibility in ('staff_only', 'family')),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'returned', 'published', 'recorded', 'withdrawn')),
  author_person_id uuid not null,
  author jsonb not null,
  submitted_at timestamptz,
  reviewer_person_id uuid,
  review_note text check (review_note is null or length(review_note) between 1 and 4000),
  reviewed_at timestamptz,
  corrects_assessment_id uuid,
  withdrawn_at timestamptz,
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, template_id) references assessment_templates (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, author_person_id) references persons (organization_id, id),
  foreign key (organization_id, reviewer_person_id) references persons (organization_id, id),
  foreign key (organization_id, corrects_assessment_id) references assessments (organization_id, id),
  -- SPK-YOUTH-005: a program manager other than the author reviews.
  constraint assessments_reviewer_differs check (reviewer_person_id is null or reviewer_person_id <> author_person_id),
  constraint assessments_returned_note check (status <> 'returned' or review_note is not null),
  constraint assessments_published_family check (status <> 'published' or visibility = 'family'),
  constraint assessments_recorded_staff_only check (status <> 'recorded' or visibility = 'staff_only'),
  constraint assessments_review_fact check (
    status not in ('published', 'recorded', 'returned') or (reviewed_at is not null and reviewer_person_id is not null)
  ),
  constraint assessments_withdrawn_fact check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check (corrects_assessment_id is null or corrects_assessment_id <> id)
);
create index assessments_participant_idx on assessments (organization_id, participant_person_id, observed_on desc, id);
create index assessments_offering_idx on assessments (organization_id, offering_id, status);
create trigger assessments_touch before update on assessments
  for each row execute function touch_updated_at();

-- The template must be approved when an assessment is written against it, the skill area must be
-- one of its areas and the value must lie on its scale (1 … number of levels).
create or replace function assessments_template_guard() returns trigger
language plpgsql as $$
declare
  tpl record;
begin
  if tg_op = 'UPDATE'
     and new.template_id = old.template_id
     and new.skill_area_key = old.skill_area_key
     and new.scale_value = old.scale_value then
    return new;
  end if;
  select status, skill_areas, scale into tpl
    from assessment_templates
   where organization_id = new.organization_id and id = new.template_id;
  if tpl.status is distinct from 'approved' then
    raise exception 'assessment template % is not approved', new.template_id
      using errcode = 'check_violation', constraint = 'assessments_template_approved';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(tpl.skill_areas) area where area->>'key' = new.skill_area_key
  ) then
    raise exception 'skill area % is not part of template %', new.skill_area_key, new.template_id
      using errcode = 'check_violation', constraint = 'assessments_template_skill_area';
  end if;
  if new.scale_value < 1 or new.scale_value > jsonb_array_length(tpl.scale->'levels') then
    raise exception 'value % is outside the scale of template %', new.scale_value, new.template_id
      using errcode = 'check_violation', constraint = 'assessments_template_scale';
  end if;
  return new;
end
$$;
create trigger assessments_template_guard before insert or update on assessments
  for each row execute function assessments_template_guard();

-- AssessmentMachine (ENR-10): draft → submitted | withdrawn; submitted → published | recorded |
-- returned; returned → submitted | withdrawn. Published and recorded rows never change: a
-- correction is a new row (corrects_assessment_id), and neither is ever deleted.
create or replace function assessments_lifecycle_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('published', 'recorded') then
      raise exception 'assessment % is % and cannot be deleted', old.id, old.status
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if old.status in ('published', 'recorded', 'withdrawn') then
    raise exception 'assessment % is % and immutable; record a correction instead', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'draft' and new.status in ('submitted', 'withdrawn'))
     or (old.status = 'submitted' and new.status in ('published', 'recorded', 'returned'))
     or (old.status = 'returned' and new.status in ('submitted', 'withdrawn')) then
    return new;
  end if;
  raise exception 'assessment % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'assessments_machine';
end
$$;
create trigger assessments_lifecycle_guard before update or delete on assessments
  for each row execute function assessments_lifecycle_guard();

create table progression_recommendations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  participant_person_id uuid not null,
  from_offering_id uuid not null,
  recommended_offering_id uuid,
  recommended_program_id uuid,
  eligibility_snapshot jsonb,                         -- read-only evaluation of an offering (unknown kept)
  suitability text not null check (length(suitability) between 1 and 4000),
  status text not null default 'draft' check (status in ('draft', 'shared', 'withdrawn')),
  author_person_id uuid not null,
  author jsonb not null,
  shared_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, from_offering_id) references offerings (organization_id, id),
  foreign key (organization_id, recommended_offering_id) references offerings (organization_id, id),
  foreign key (organization_id, recommended_program_id) references programs (organization_id, id),
  foreign key (organization_id, author_person_id) references persons (organization_id, id),
  -- Exactly one of a recommended offering or program.
  constraint progression_recommendations_one_target check (
    (recommended_offering_id is null) <> (recommended_program_id is null)
  ),
  constraint progression_recommendations_shared_fact check (status <> 'shared' or shared_at is not null),
  constraint progression_recommendations_withdrawn_fact check ((status = 'withdrawn') = (withdrawn_at is not null))
);
create index progression_recommendations_participant_idx
  on progression_recommendations (organization_id, participant_person_id, created_at desc, id);
create trigger progression_recommendations_touch before update on progression_recommendations
  for each row execute function touch_updated_at();

-- ProgressionRecommendationMachine (ENR-10): draft → shared | withdrawn; shared → withdrawn.
create or replace function progression_recommendations_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'draft' and new.status in ('shared', 'withdrawn'))
     or (old.status = 'shared' and new.status = 'withdrawn') then
    return new;
  end if;
  raise exception 'progression recommendation % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'progression_recommendations_machine';
end
$$;
create trigger progression_recommendations_transition_guard before update on progression_recommendations
  for each row execute function progression_recommendations_transition_guard();
