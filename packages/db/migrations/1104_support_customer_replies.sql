-- 1104_support_customer_replies.sql
-- SUP-06 (SPK-SUPPORT-002, SCR-C-38, §4.14): a customer answers their own support request (for
-- example one that is "Waiting for you"). The reply is a new kind of case history row,
-- `customer_reply`, written only through POST /v1/me/cases/{id}/replies by the customer who opened
-- the request. Staff read it in the case history; the customer reads back only their own replies.
--
-- Case history stays append-only (case_events_append_only, 1100); this migration only widens the
-- allowed kinds and requires a body on a reply, as a note already does.
alter table case_events drop constraint case_events_kind_check;
alter table case_events
  add constraint case_events_kind_check
    check (kind in ('note', 'status', 'assignment', 'update', 'action_link', 'customer_reply')),
  add constraint case_events_customer_reply_body
    check (kind <> 'customer_reply' or body is not null);

-- GET /v1/me/cases/{id}/replies reads through case_events_case_idx (1100); no new index.
