-- 0209_catalog_package_g_scope_effects.sql
-- Catalog module (§3.16, SPK-COND-001 to SPK-COND-003; §4.7 "integrity that matters is enforced in
-- the database"). The 0205 scope checks only tested top-level keys, so the database accepted
-- definitions that state no real effect: an unlimited or included-sessions membership with no
-- appliesTo, included sessions with no limit, a from-confirmation term with no length, a package
-- expiry without its days or date, fractional credits, and resources or staffing without ids,
-- counts or roles. These checks replace the 0205 ones with per-mode conditions that mirror the
-- catalog's zod schemas (packages/contracts/src/api/catalog.ts). 0205 stays as applied.
--
-- The helpers are immutable plpgsql functions (a check constraint cannot hold a subquery, and
-- plpgsql evaluates its conditions in order, so jsonb_array_length never sees a scalar). Every
-- check is still wrapped in coalesce(..., false): a check that evaluates to null passes.

-- A JSON integer (no fraction, no sign) between lo and hi.
create or replace function catalog_json_int_between(j jsonb, lo numeric, hi numeric)
returns boolean language plpgsql immutable as $$
begin
  if j is null or jsonb_typeof(j) <> 'number' then
    return false;
  end if;
  if (j #>> '{}') !~ '^[0-9]+$' then
    return false;
  end if;
  return (j #>> '{}')::numeric between lo and hi;
end
$$;

-- A JSON array of at least min_length elements.
create or replace function catalog_json_array_of_at_least(j jsonb, min_length integer)
returns boolean language plpgsql immutable as $$
begin
  if j is null or jsonb_typeof(j) <> 'array' then
    return false;
  end if;
  return jsonb_array_length(j) >= min_length;
end
$$;

-- appliesTo: an object naming at least one offering or program.
create or replace function catalog_scope_applies_to_valid(j jsonb)
returns boolean language plpgsql immutable as $$
begin
  if j is null or jsonb_typeof(j) <> 'object' then
    return false;
  end if;
  return catalog_json_array_of_at_least(j->'offeringIds', 1)
      or catalog_json_array_of_at_least(j->'programIds', 1);
end
$$;

-- resources: at least one resource id and a count between 1 and the number listed.
create or replace function catalog_scope_resources_valid(j jsonb)
returns boolean language plpgsql immutable as $$
begin
  if j is null or jsonb_typeof(j) <> 'object' then
    return false;
  end if;
  if not catalog_json_array_of_at_least(j->'resourceIds', 1) then
    return false;
  end if;
  return catalog_json_int_between(j->'count', 1, jsonb_array_length(j->'resourceIds'));
end
$$;

-- staffing: an array (possibly empty) whose every item names its kind, role, count and
-- qualifications.
create or replace function catalog_scope_staffing_valid(j jsonb)
returns boolean language plpgsql immutable as $$
declare
  item jsonb;
begin
  if j is null or jsonb_typeof(j) <> 'array' then
    return false;
  end if;
  for item in select value from jsonb_array_elements(j) loop
    if jsonb_typeof(item) <> 'object'
       or coalesce(item->>'kind' not in ('supervisor', 'organizer'), true)
       or coalesce(jsonb_typeof(item->'role') <> 'string', true)
       or not catalog_json_int_between(item->'count', 1, 100)
       or coalesce(jsonb_typeof(item->'qualifications') <> 'array', true) then
      return false;
    end if;
  end loop;
  return true;
end
$$;

-- SPK-COND-001: the attendance effect, term and renewal of a membership benefit.
create or replace function catalog_membership_benefit_scope_valid(scope jsonb)
returns boolean language plpgsql immutable as $$
declare
  attendance jsonb := scope->'attendance';
  term jsonb := scope->'term';
  renewal jsonb := scope->'renewal';
  lim jsonb;
begin
  if attendance is null or jsonb_typeof(attendance) <> 'object' then
    return false;
  end if;
  case attendance->>'mode'
    when 'none' then
      null;
    when 'unlimited' then
      if not catalog_scope_applies_to_valid(attendance->'appliesTo') then
        return false;
      end if;
    when 'included_sessions' then
      if not catalog_scope_applies_to_valid(attendance->'appliesTo') then
        return false;
      end if;
      lim := attendance->'limit';
      if lim is null or jsonb_typeof(lim) <> 'object' then
        return false;
      end if;
      if not catalog_json_int_between(lim->'count', 1, 10000) then
        return false;
      end if;
      if coalesce(lim->>'period' not in ('week', 'month', 'membership_term'), true) then
        return false;
      end if;
      if lim->>'period' = 'week' then
        if not catalog_json_int_between(lim->'weekStartsOn', 1, 7) then
          return false;
        end if;
      elsif lim ? 'weekStartsOn' then
        return false;
      end if;
    else
      return false;
  end case;
  if term is null or jsonb_typeof(term) <> 'object' then
    return false;
  end if;
  case term->>'kind'
    when 'offering_dates' then
      null;
    when 'from_confirmation' then
      if not catalog_json_int_between(term->'lengthDays', 1, 3660) then
        return false;
      end if;
    else
      return false;
  end case;
  if renewal is null or jsonb_typeof(renewal) <> 'object' or not (renewal ? 'noticeLeadDays') then
    return false;
  end if;
  return jsonb_typeof(renewal->'noticeLeadDays') = 'null'
      or catalog_json_int_between(renewal->'noticeLeadDays', 1, 365);
end
$$;

-- SPK-COND-002: whole credits, what they apply to and the expiry choice with its value.
create or replace function catalog_package_credits_scope_valid(scope jsonb)
returns boolean language plpgsql immutable as $$
declare
  expiry jsonb := scope->'expiry';
begin
  if not catalog_json_int_between(scope->'credits', 1, 1000) then
    return false;
  end if;
  if not catalog_scope_applies_to_valid(scope->'appliesTo') then
    return false;
  end if;
  if expiry is null or jsonb_typeof(expiry) <> 'object' then
    return false;
  end if;
  case expiry->>'kind'
    when 'none' then
      return true;
    when 'days_after_issue' then
      return catalog_json_int_between(expiry->'days', 1, 3650);
    when 'fixed_date' then
      return coalesce(jsonb_typeof(expiry->'date') = 'string', false)
         and (expiry->>'date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
    else
      return false;
  end case;
end
$$;

alter table entitlement_definitions
  drop constraint entitlement_definitions_membership_benefit_scope;
alter table entitlement_definitions add constraint entitlement_definitions_membership_benefit_scope
  check (
    kind <> 'membership_benefit' or coalesce(catalog_membership_benefit_scope_valid(scope), false)
  );

alter table entitlement_definitions drop constraint entitlement_definitions_package_credits_scope;
alter table entitlement_definitions add constraint entitlement_definitions_package_credits_scope
  check (kind <> 'package_credits' or coalesce(catalog_package_credits_scope_valid(scope), false));

-- SPK-COND-003: a party package names its duration, guest limit, the resources it reserves, its
-- staffing (possibly none) and its equipment together.
alter table entitlement_definitions drop constraint entitlement_definitions_party_package_scope;
alter table entitlement_definitions add constraint entitlement_definitions_party_package_scope
  check (
    kind <> 'party_package' or coalesce((
      catalog_json_int_between(scope->'durationMinutes', 1, 1440)
      and catalog_json_int_between(scope->'guestLimit', 1, 10000)
      and catalog_scope_resources_valid(scope->'resources')
      and catalog_scope_staffing_valid(scope->'staffing')
      and catalog_json_array_of_at_least(scope->'equipmentAssetIds', 0)
    ), false)
  );

-- SPK-COND-003: a rental names the resources it reserves and its staffing (possibly none).
alter table entitlement_definitions drop constraint entitlement_definitions_rental_resource_scope;
alter table entitlement_definitions add constraint entitlement_definitions_rental_resource_scope
  check (
    kind <> 'rental_resource' or coalesce((
      catalog_scope_resources_valid(scope->'resources')
      and catalog_scope_staffing_valid(scope->'staffing')
    ), false)
  );
