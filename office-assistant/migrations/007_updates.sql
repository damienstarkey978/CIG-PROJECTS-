-- Email is a connector kind now, and "jobs" (CSV import) is allowed too.
ALTER TABLE connector_accounts DROP CONSTRAINT connector_accounts_kind_check;
ALTER TABLE connector_accounts ADD CONSTRAINT connector_accounts_kind_check
  CHECK (kind IN ('telephony','calendar','scheduling','accounting','email','jobs'));

-- One row per progress email from the project manager.
CREATE TABLE update_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind                text NOT NULL DEFAULT 'progress' CHECK (kind IN ('progress','permits')),
  source              text NOT NULL CHECK (source IN ('paste','email','schedule')),
  week_of             date,                       -- the Friday a permitting report is for
  from_address        text,
  subject             text,
  raw_text            text NOT NULL,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- One row per client email. Nothing here is sent until a person approves it.
CREATE TABLE update_drafts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id             uuid NOT NULL REFERENCES update_batches(id) ON DELETE CASCADE,
  job_id               uuid REFERENCES jobs(id) ON DELETE SET NULL,
  address              text NOT NULL,
  client_contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  to_emails            text[] NOT NULL DEFAULT '{}',
  cc                   text[] NOT NULL DEFAULT '{}',
  subject              text NOT NULL,
  body                 text NOT NULL,
  flags                text[] NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','skipped','failed')),
  error                text,
  approved_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at              timestamptz,
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX update_drafts_tenant ON update_drafts (tenant_id, created_at DESC);

-- One permitting report per company per Friday.
CREATE UNIQUE INDEX update_batches_weekly_permits ON update_batches (tenant_id, week_of) WHERE kind = 'permits';

-- Every permit or inspection change, so the Friday report can say what moved this week.
CREATE TABLE permit_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  permit_id    uuid NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text,
  from_due     date,
  to_due       date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX permit_events_recent ON permit_events (tenant_id, created_at DESC);
