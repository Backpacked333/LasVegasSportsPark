-- 1400_automation_core.sql
-- Automation module (specification §3.21 SPK-AUTO-001..005, §4.2 "Automation: reviewable
-- recommendations", §4.4, SPK-AT-026).
--
-- The module owns these tables and is their only writer (§4.2). The assistant is a client of the
-- other modules: every record it reads or proposes to change belongs to the owning module and is
-- reached through that module's exported service with the caller's own principal (SPK-AUTO-004).
-- Nothing here is authority: a recommendation is a reviewable proposal, and a consequential one
-- is applied only by a person, through the owning module's normal command, with that person's
-- principal, after that person's explicit approval (SPK-AUTO-003).
--
-- References to people, accounts and facilities are composite (organization_id, id) foreign keys
-- (§4.3). Kernel tables (operations, audit_records) carry no `unique (organization_id, id)`, so
-- references to them are plain foreign keys plus a trigger that refuses another organization's row.

-- ---------------------------------------------------------------------------------------------
-- Assistant requests (SPK-AUTO-001, SPK-AUTO-002): who asked (a principal snapshot — the
-- assistant never runs as a system principal), the prompt, imported attachments (data, never
-- authority, SPK-AUTO-004), the context references the client supplied with the instant it
-- observed them, and the outcome: the response, the supporting records with their freshness and
-- the evidence that is missing. Lifecycle (AssistantRequestMachine, automation.machines.ts):
--   processing → answered | failed;   answered and failed are final.
-- ---------------------------------------------------------------------------------------------
create table assistant_requests (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  requester jsonb not null
    check (jsonb_typeof(requester) = 'object' and requester ? 'actorLabel'
      and coalesce(requester->>'kind', '') in ('customer', 'staff')),
  requester_account_id uuid not null,
  requester_person_id uuid not null,
  facility_id uuid,
  prompt text not null check (length(prompt) between 1 and 4000),
  attachments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 5),
  context_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(context_references) = 'array' and jsonb_array_length(context_references) <= 20),
  status text not null default 'processing' check (status in ('processing', 'answered', 'failed')),
  provider text not null check (length(provider) between 1 and 100),
  turns integer not null default 0 check (turns between 0 and 20),
  response_text text check (response_text is null or length(response_text) between 1 and 20000),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  missing_evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_evidence) = 'array'),
  error jsonb check (error is null or (jsonb_typeof(error) = 'object' and error ? 'code')),
  operation_id uuid not null references operations(id),
  received_at timestamptz not null,
  completed_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, requester_account_id) references accounts (organization_id, id),
  foreign key (organization_id, requester_person_id) references persons (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  check ((status = 'processing') = (completed_at is null)),
  check (status <> 'answered' or response_text is not null),
  check ((status = 'failed') = (error is not null))
);
create index assistant_requests_requester_idx
  on assistant_requests (organization_id, requester_account_id, received_at desc);
create unique index assistant_requests_operation_idx on assistant_requests (operation_id);
create trigger assistant_requests_touch before update on assistant_requests
  for each row execute function touch_updated_at();
create trigger assistant_requests_no_delete before delete on assistant_requests
  for each row execute function forbid_mutation();

create or replace function assistant_requests_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from operations o where o.id = new.operation_id and o.organization_id = new.organization_id
  ) then
    raise exception 'assistant request %: operation % belongs to another organization', new.id, new.operation_id
      using errcode = 'foreign_key_violation', constraint = 'assistant_requests_operation_scope';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'processing' or new.revision <> 1 then
      raise exception 'assistant request % must be created processing at revision 1', new.id
        using errcode = 'check_violation', constraint = 'assistant_requests_machine';
    end if;
    return new;
  end if;
  if old.status in ('answered', 'failed') then
    raise exception 'assistant request % is final (%)', old.id, old.status
      using errcode = 'check_violation', constraint = 'assistant_requests_machine';
  end if;
  if new.status <> old.status and not (old.status = 'processing' and new.status in ('answered', 'failed')) then
    raise exception 'assistant request % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'check_violation', constraint = 'assistant_requests_machine';
  end if;
  if new.organization_id <> old.organization_id or new.requester <> old.requester
     or new.requester_account_id <> old.requester_account_id
     or new.requester_person_id <> old.requester_person_id
     or new.facility_id is distinct from old.facility_id
     or new.prompt <> old.prompt or new.attachments <> old.attachments
     or new.context_references <> old.context_references or new.provider <> old.provider
     or new.operation_id <> old.operation_id or new.received_at <> old.received_at
     or new.created_at <> old.created_at then
    raise exception 'assistant request %: the requester, prompt, attachments and context are immutable', old.id
      using errcode = 'check_violation', constraint = 'assistant_requests_immutable';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'assistant request %: every change bumps the revision by one', old.id
      using errcode = 'check_violation', constraint = 'assistant_requests_revision';
  end if;
  return new;
end
$$;
create trigger assistant_requests_guard before insert or update on assistant_requests
  for each row execute function assistant_requests_guard();

-- ---------------------------------------------------------------------------------------------
-- Recommendations (SPK-AUTO-001..004): reviewable proposals produced for the requester.
--   Informational kinds (readiness_explanation, demand_summary, policy_lookup, issue_summary)
--   carry no command and can only be approved (accepted), rejected or left to expire.
--   Consequential kinds carry the owning module's command: schedule_repair →
--   scheduling.publish_schedule, communication_draft → communications.send, and optionally
--   financial_exception_explanation → finance.refund. Such a recommendation is applied only after
--   an explicit approval, by the approving reviewer, through the owning module's normal command
--   with the reviewer's principal; the audit record of the apply and the coordinating operation
--   are required (SPK-AUTO-003, SPK-AUTO-004, SPK-AT-026).
-- Lifecycle (RecommendationMachine, automation.machines.ts):
--   proposed → approved | rejected | expired;   approved → applied | expired;
--   rejected, applied and expired are final. While an apply is running (apply_operation_id set on
--   an approved row) the recommendation can neither expire nor be applied a second time.
-- ---------------------------------------------------------------------------------------------
create table recommendations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  assistant_request_id uuid not null,
  facility_id uuid,
  kind text not null
    check (kind in ('schedule_repair', 'communication_draft', 'readiness_explanation',
      'financial_exception_explanation', 'demand_summary', 'policy_lookup', 'issue_summary')),
  title text not null check (length(title) between 1 and 200),
  summary text not null check (length(summary) between 1 and 4000),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  command_action_id text
    check (command_action_id is null
      or command_action_id in ('scheduling.publish_schedule', 'communications.send', 'finance.refund')),
  command jsonb check (command is null or (jsonb_typeof(command) = 'object' and command ? 'input' and command ? 'target')),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  missing_evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_evidence) = 'array'),
  requester jsonb not null
    check (jsonb_typeof(requester) = 'object' and requester ? 'actorLabel'
      and coalesce(requester->>'kind', '') in ('customer', 'staff')),
  requester_account_id uuid not null,
  requester_person_id uuid not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'applied', 'expired')),
  proposed_at timestamptz not null,
  expires_at timestamptz not null,
  reviewed_by jsonb,
  reviewed_by_account_id uuid,
  reviewed_by_person_id uuid,
  reviewed_at timestamptz,
  review_decision text check (review_decision is null or review_decision in ('approved', 'rejected')),
  review_reason text check (review_reason is null or length(review_reason) between 1 and 2000),
  review_policy_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(review_policy_references) = 'array'),
  apply_operation_id uuid references operations(id),
  apply_started_at timestamptz,
  applied_by jsonb,
  applied_by_account_id uuid,
  applied_by_person_id uuid,
  applied_at timestamptz,
  applied_audit_record_id uuid references audit_records(id),
  applied_command_operation_id uuid references operations(id),
  applied_record_type text check (applied_record_type is null or applied_record_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  applied_record_id text check (applied_record_id is null or length(applied_record_id) between 1 and 200),
  last_apply_error jsonb check (last_apply_error is null or jsonb_typeof(last_apply_error) = 'object'),
  expired_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, assistant_request_id) references assistant_requests (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, requester_account_id) references accounts (organization_id, id),
  foreign key (organization_id, requester_person_id) references persons (organization_id, id),
  foreign key (organization_id, reviewed_by_account_id) references accounts (organization_id, id),
  foreign key (organization_id, reviewed_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, applied_by_account_id) references accounts (organization_id, id),
  foreign key (organization_id, applied_by_person_id) references persons (organization_id, id),
  check (expires_at > proposed_at),
  -- Each kind's command is fixed: informational kinds never carry one (SPK-AUTO-003).
  -- (Null-safe comparisons throughout: a check that evaluates to null would pass.)
  constraint recommendations_kind_command check (
    (command_action_id is null) = (command is null)
    and (kind <> 'schedule_repair'
      or command_action_id is not distinct from 'scheduling.publish_schedule')
    and (kind <> 'communication_draft'
      or command_action_id is not distinct from 'communications.send')
    and (kind <> 'financial_exception_explanation' or command_action_id is null
      or command_action_id = 'finance.refund')
    and (kind not in ('readiness_explanation', 'demand_summary', 'policy_lookup', 'issue_summary')
      or command_action_id is null)
  ),
  -- A review is recorded completely or not at all; approval precedes apply (SPK-AUTO-003).
  constraint recommendations_review_recorded check (
    (review_decision is null) = (reviewed_at is null)
    and (review_decision is null) = (reviewed_by is null)
    and (review_decision is null) = (reviewed_by_account_id is null)
    and (status <> 'proposed' or review_decision is null)
    and (status not in ('approved', 'applied') or review_decision is not distinct from 'approved')
    and (status <> 'rejected'
      or (review_decision is not distinct from 'rejected' and review_reason is not null))
  ),
  -- Applied only through a command, by the approving reviewer, with the coordinating operation
  -- and the audit record of the apply (SPK-AUTO-003, SPK-AUTO-004).
  constraint recommendations_applied_requires_review_and_audit check (
    (status = 'applied') = (applied_at is not null)
    and (status <> 'applied' or (
      command is not null
      and applied_by is not null and applied_by_account_id is not null
      and applied_by_account_id is not distinct from reviewed_by_account_id
      and apply_operation_id is not null and applied_audit_record_id is not null))
    and (applied_at is not null or (applied_by is null and applied_audit_record_id is null
      and applied_command_operation_id is null and applied_record_type is null))
  ),
  -- An apply in progress is a claim on an approved row; it is released when the apply fails.
  constraint recommendations_apply_claim check (
    (apply_operation_id is null) = (apply_started_at is null)
    and (apply_operation_id is null or status in ('approved', 'applied'))
  ),
  check ((applied_record_type is null) = (applied_record_id is null)),
  check ((status = 'expired') = (expired_at is not null))
);
create index recommendations_request_idx on recommendations (organization_id, assistant_request_id);
create index recommendations_status_idx on recommendations (organization_id, status, proposed_at desc);
create index recommendations_requester_idx
  on recommendations (organization_id, requester_account_id, proposed_at desc);
-- One coordinating operation applies one recommendation (§4.7 invariant 5).
create unique index recommendations_apply_operation_idx on recommendations (apply_operation_id)
  where apply_operation_id is not null;
create trigger recommendations_touch before update on recommendations
  for each row execute function touch_updated_at();
create trigger recommendations_no_delete before delete on recommendations
  for each row execute function forbid_mutation();

create or replace function recommendations_guard() returns trigger
language plpgsql as $$
begin
  if new.apply_operation_id is not null and not exists (
    select 1 from operations o where o.id = new.apply_operation_id and o.organization_id = new.organization_id
  ) then
    raise exception 'recommendation %: operation % belongs to another organization', new.id, new.apply_operation_id
      using errcode = 'foreign_key_violation', constraint = 'recommendations_operation_scope';
  end if;
  if new.applied_command_operation_id is not null and not exists (
    select 1 from operations o
    where o.id = new.applied_command_operation_id and o.organization_id = new.organization_id
  ) then
    raise exception 'recommendation %: operation % belongs to another organization', new.id, new.applied_command_operation_id
      using errcode = 'foreign_key_violation', constraint = 'recommendations_operation_scope';
  end if;
  if new.applied_audit_record_id is not null and not exists (
    select 1 from audit_records a
    where a.id = new.applied_audit_record_id and a.organization_id = new.organization_id
  ) then
    raise exception 'recommendation %: audit record % belongs to another organization', new.id, new.applied_audit_record_id
      using errcode = 'foreign_key_violation', constraint = 'recommendations_audit_scope';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' or new.revision <> 1 or new.apply_operation_id is not null then
      raise exception 'recommendation % must be created proposed at revision 1', new.id
        using errcode = 'check_violation', constraint = 'recommendations_machine';
    end if;
    return new;
  end if;
  if old.status in ('rejected', 'applied', 'expired') then
    raise exception 'recommendation % is final (%)', old.id, old.status
      using errcode = 'check_violation', constraint = 'recommendations_machine';
  end if;
  if new.status <> old.status and not (
    (old.status = 'proposed' and new.status in ('approved', 'rejected', 'expired'))
    or (old.status = 'approved' and new.status in ('applied', 'expired'))
  ) then
    raise exception 'recommendation % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'check_violation', constraint = 'recommendations_machine';
  end if;
  if new.status = old.status and old.status <> 'approved' then
    raise exception 'recommendation %: a % recommendation only changes through its lifecycle', old.id, old.status
      using errcode = 'check_violation', constraint = 'recommendations_machine';
  end if;
  -- A running apply is never interrupted by expiry, and a recommendation is applied only from the
  -- claim its own coordinating operation holds.
  if new.status = 'expired' and old.apply_operation_id is not null then
    raise exception 'recommendation % is being applied and cannot expire', old.id
      using errcode = 'check_violation', constraint = 'recommendations_apply_claim';
  end if;
  if new.status = 'applied' and (old.apply_operation_id is null
      or new.apply_operation_id is distinct from old.apply_operation_id) then
    raise exception 'recommendation % is applied only by the operation that claimed it', old.id
      using errcode = 'check_violation', constraint = 'recommendations_apply_claim';
  end if;
  if old.apply_operation_id is not null and new.apply_operation_id is not null
     and new.apply_operation_id <> old.apply_operation_id then
    raise exception 'recommendation % is already being applied', old.id
      using errcode = 'check_violation', constraint = 'recommendations_apply_claim';
  end if;
  if old.review_decision is not null and (
       new.review_decision is distinct from old.review_decision
       or new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_by_account_id is distinct from old.reviewed_by_account_id
       or new.reviewed_by_person_id is distinct from old.reviewed_by_person_id
       or new.reviewed_at is distinct from old.reviewed_at
       or new.review_reason is distinct from old.review_reason
       or new.review_policy_references <> old.review_policy_references) then
    raise exception 'recommendation %: the recorded review is immutable', old.id
      using errcode = 'check_violation', constraint = 'recommendations_review_immutable';
  end if;
  if new.organization_id <> old.organization_id or new.assistant_request_id <> old.assistant_request_id
     or new.facility_id is distinct from old.facility_id or new.kind <> old.kind
     or new.title <> old.title or new.summary <> old.summary or new.payload <> old.payload
     or new.command_action_id is distinct from old.command_action_id
     or new.command is distinct from old.command
     or new.evidence <> old.evidence or new.missing_evidence <> old.missing_evidence
     or new.requester <> old.requester or new.requester_account_id <> old.requester_account_id
     or new.requester_person_id <> old.requester_person_id
     or new.proposed_at <> old.proposed_at or new.expires_at <> old.expires_at
     or new.created_at <> old.created_at then
    raise exception 'recommendation %: the proposal, its evidence and its requester are immutable', old.id
      using errcode = 'check_violation', constraint = 'recommendations_immutable';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'recommendation %: every change bumps the revision by one', old.id
      using errcode = 'check_violation', constraint = 'recommendations_revision';
  end if;
  return new;
end
$$;
create trigger recommendations_guard before insert or update on recommendations
  for each row execute function recommendations_guard();

-- ---------------------------------------------------------------------------------------------
-- Tool invocations (append-only, SPK-AUTO-004, SPK-AT-026): every module query or command the
-- assistant used or proposed, and every command a reviewer applied, with the principal it ran
-- under and its outcome. A denial is a row with outcome `denied` and the stable error code; the
-- arguments are what the provider proposed (data, never authority).
--   phase `assist`: proposed by the assistant while answering, run under the requester's principal;
--   phase `apply`:  a reviewer's apply of a recommendation, run under the reviewer's principal.
-- ---------------------------------------------------------------------------------------------
create table tool_invocations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  assistant_request_id uuid not null,
  recommendation_id uuid,
  sequence integer not null check (sequence >= 1),
  phase text not null check (phase in ('assist', 'apply')),
  tool text not null check (length(tool) between 1 and 100),
  action_id text check (action_id is null or action_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  tool_kind text not null check (tool_kind in ('query', 'command', 'unknown')),
  principal jsonb not null
    check (jsonb_typeof(principal) = 'object' and principal ? 'actorLabel'
      and coalesce(principal->>'kind', '') in ('customer', 'staff')),
  principal_account_id uuid not null,
  principal_person_id uuid not null,
  arguments jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments) = 'object'),
  outcome text not null
    check (outcome in ('succeeded', 'denied', 'failed', 'unsupported', 'invalid', 'unknown')),
  error_code text check (error_code is null or length(error_code) between 1 and 100),
  error_message text check (error_message is null or length(error_message) between 1 and 2000),
  result_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(result_refs) = 'array'),
  occurred_at timestamptz not null,
  correlation_id text,
  operation_id uuid references operations(id),
  unique (organization_id, id),
  unique (assistant_request_id, sequence),
  foreign key (organization_id, assistant_request_id) references assistant_requests (organization_id, id),
  foreign key (organization_id, recommendation_id) references recommendations (organization_id, id),
  foreign key (organization_id, principal_account_id) references accounts (organization_id, id),
  foreign key (organization_id, principal_person_id) references persons (organization_id, id),
  check ((phase = 'apply') = (recommendation_id is not null)),
  check (phase <> 'apply' or tool_kind = 'command'),
  check ((outcome = 'succeeded') = (error_code is null))
);
create index tool_invocations_request_idx on tool_invocations (organization_id, assistant_request_id, sequence);
create index tool_invocations_denied_idx on tool_invocations (organization_id, occurred_at desc)
  where outcome = 'denied';
create trigger tool_invocations_append_only before update or delete on tool_invocations
  for each row execute function forbid_mutation();

create or replace function tool_invocations_scope() returns trigger
language plpgsql as $$
begin
  if new.operation_id is not null and not exists (
    select 1 from operations o where o.id = new.operation_id and o.organization_id = new.organization_id
  ) then
    raise exception 'tool invocation %: operation % belongs to another organization', new.id, new.operation_id
      using errcode = 'foreign_key_violation', constraint = 'tool_invocations_operation_scope';
  end if;
  if new.recommendation_id is not null and not exists (
    select 1 from recommendations r
    where r.organization_id = new.organization_id and r.id = new.recommendation_id
      and r.assistant_request_id = new.assistant_request_id
  ) then
    raise exception 'tool invocation %: recommendation % does not belong to request %', new.id,
      new.recommendation_id, new.assistant_request_id
      using errcode = 'foreign_key_violation', constraint = 'tool_invocations_recommendation_request';
  end if;
  return new;
end
$$;
create trigger tool_invocations_scope before insert on tool_invocations
  for each row execute function tool_invocations_scope();
