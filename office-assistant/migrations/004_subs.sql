ALTER TABLE job_assignments
  ADD COLUMN confirm_requested_at timestamptz,
  ADD COLUMN confirm_reply text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- One row per automated request, in shadow or live mode, so nothing is asked twice.
CREATE TABLE nudges (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('confirm_request','confirm_escalated','paperwork_request','paperwork_escalated')),
  ref_id      uuid NOT NULL,           -- assignment id or contact id, by kind
  mode        text NOT NULL CHECK (mode IN ('shadow','live')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nudges_lookup ON nudges (tenant_id, kind, ref_id, created_at DESC);

ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_purpose_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_purpose_check
  CHECK (purpose IN ('follow_up','office_alert','shadow_report','sub_confirm','sub_paperwork'));
