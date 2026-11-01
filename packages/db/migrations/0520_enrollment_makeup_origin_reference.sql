-- 0520_enrollment_makeup_origin_reference.sql
-- Enrollment module, stage-7 R3-TRACE-B-02 (SPK-YOUTH-004: a makeup entitlement references its
-- originating session or policy event, its eligible replacements, expiry, redemption limit and
-- redemption history).
--
-- `origin_kind` was checked only against its value list, so an entitlement could say it came from
-- a canceled session or an absence and name no session, or come from a policy event and name no
-- reference. The rule is now the database's: `session_canceled` and `absence` name their
-- originating session, `policy_event` names a non-blank reference, `manual` may name neither.
--
-- Rows issued before the rule (if any) are not given an invented origin. A `policy_event` row
-- without a reference gets an explicit "not recorded" reference; a `session_canceled` or `absence`
-- row without its session becomes `manual` and keeps what it claimed in its reference. The check is
-- then validated for every row, so a later update (a redemption moves `redeemed_count`) never
-- trips over an old row.

update makeup_entitlements
   set origin_reference = 'Not recorded (issued before the policy event reference was required)'
 where origin_kind = 'policy_event'
   and nullif(btrim(coalesce(origin_reference, '')), '') is null;

update makeup_entitlements
   set origin_reference = concat_ws(
         '; ',
         nullif(btrim(coalesce(origin_reference, '')), ''),
         'Issued as ' || origin_kind || '; originating session not recorded'
       ),
       origin_kind = 'manual'
 where origin_kind in ('session_canceled', 'absence')
   and originating_session_id is null;

alter table makeup_entitlements
  add constraint makeup_entitlements_origin_referenced check (
    (origin_kind not in ('session_canceled', 'absence') or originating_session_id is not null)
    and (origin_kind <> 'policy_event' or nullif(btrim(coalesce(origin_reference, '')), '') is not null)
  );
