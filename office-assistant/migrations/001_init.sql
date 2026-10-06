-- Backbone schema. Every business table carries tenant_id; every record synced
-- with an outside system carries external_ids (e.g. {"quo": "...", "buildertrend": "..."}).

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'America/New_York',
  business_hours  jsonb NOT NULL DEFAULT '{}'::jsonb,
  service_area    text,
  -- mode: 'shadow' (only the shadow recipient hears anything) or 'live'
  -- shadowRecipientPhone, confidenceThreshold, templates{...}
  settings        jsonb NOT NULL DEFAULT '{"mode":"shadow","confidenceThreshold":0.7,"templates":{}}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  phone           text,
  email           text,
  role            text NOT NULL CHECK (role IN ('owner','office','pm')),
  alerts_enabled  boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('prospect','client','sub','vendor','solicitor','other')),
  first_name      text,
  last_name       text,
  company         text,
  email           text,
  external_ids    jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_tenant_type ON contacts (tenant_id, type);

-- One row per number so caller matching is a unique lookup.
CREATE TABLE contact_phones (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone           text NOT NULL,           -- E.164
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  label           text,
  PRIMARY KEY (tenant_id, phone)
);

CREATE TABLE sub_profiles (
  contact_id          uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  trades              text[] NOT NULL DEFAULT '{}',
  coi_expires_on      date,
  w9_on_file          boolean NOT NULL DEFAULT false,
  lien_waiver_status  text,
  preferred_contact   text
);

CREATE TABLE client_profiles (
  contact_id       uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  billing_address  text,
  notes            text
);

CREATE TABLE jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL,
  address            text,
  client_contact_id  uuid REFERENCES contacts(id),
  pm_user_id         uuid REFERENCES users(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('lead','active','on_hold','complete','cancelled')),
  start_date         date,
  end_date           date,
  external_ids       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_tenant_status ON jobs (tenant_id, status);

CREATE TABLE job_assignments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id               uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sub_contact_id       uuid NOT NULL REFERENCES contacts(id),
  scope                text,
  start_date           date,
  end_date             date,
  confirmation_status  text NOT NULL DEFAULT 'pending' CHECK (confirmation_status IN ('pending','confirmed','declined','no_response'))
);

CREATE TABLE interactions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id                uuid REFERENCES contacts(id),
  job_id                    uuid REFERENCES jobs(id),
  channel                   text NOT NULL CHECK (channel IN ('call','sms')),
  direction                 text NOT NULL CHECK (direction IN ('incoming','outgoing')),
  handled_by                text CHECK (handled_by IN ('ai_agent','person','missed')),
  provider                  text NOT NULL,
  provider_id               text NOT NULL,        -- Quo call or message id (AC...)
  provider_conversation_id  text,
  provider_phone_number_id  text,
  from_phone                text,
  to_phone                  text,
  status                    text,
  started_at                timestamptz,
  duration_sec              integer,
  body                      text,                 -- SMS text
  transcript                jsonb,                -- [{speaker, text, start}]
  summary                   text[],
  next_steps                text[],
  voicemail                 jsonb,                -- {url, duration, transcript}
  caller_type               text CHECK (caller_type IN ('lead','sub_vendor','existing_client','solicitor','unknown')),
  confidence                real,
  extracted                 jsonb,
  classifier_version        text,
  processed_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id)
);
CREATE INDEX interactions_tenant_created ON interactions (tenant_id, created_at DESC);

CREATE TABLE appointments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  calendar_ref  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','completed','no_show')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  interaction_id  uuid REFERENCES interactions(id),
  source          text NOT NULL CHECK (source IN ('call','sms','web','other')),
  job_type        text,
  address         text,
  timeline        text,
  budget_hint     text,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new','callback','booked','qualified','dead')),
  appointment_id  uuid REFERENCES appointments(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type              text NOT NULL,
  title             text NOT NULL,
  body              text,
  assignee_user_id  uuid REFERENCES users(id),
  contact_id        uuid REFERENCES contacts(id),
  job_id            uuid REFERENCES jobs(id),
  interaction_id    uuid REFERENCES interactions(id),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  external_ids      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Every text the system sends or would have sent (shadow), for audit.
CREATE TABLE outbound_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id       uuid REFERENCES interactions(id),
  purpose              text NOT NULL CHECK (purpose IN ('follow_up','office_alert','shadow_report')),
  to_phone             text NOT NULL,
  body                 text NOT NULL,
  mode                 text NOT NULL CHECK (mode IN ('shadow','live')),
  provider_message_id  text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('telephony','calendar','scheduling','accounting')),
  provider     text NOT NULL,
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non secret: inbox ids, numbers
  secrets_enc  text,                                 -- AES-256-GCM, see src/lib/crypto.ts
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, provider)
);

CREATE TABLE webhook_events (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  event_id     text NOT NULL,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- Background work. Named work_queue so it never collides with construction "jobs".
CREATE TABLE work_queue (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  dedupe_key    text,
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  last_error    text,
  locked_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX work_queue_dedupe_pending ON work_queue (dedupe_key) WHERE status IN ('pending','running');
CREATE INDEX work_queue_ready ON work_queue (run_at) WHERE status = 'pending';
