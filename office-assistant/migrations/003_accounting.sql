-- Open bills and invoices copied from the books (QuickBooks or other), so the app can
-- report without calling the accounting system on every page view. Read only mirror:
-- nothing here is ever written back.

CREATE TABLE acct_bills (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  external_id        text NOT NULL,
  vendor_external_id text,
  vendor_name        text NOT NULL,
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  txn_date           date,
  due_date           date,
  amount             numeric(14,2) NOT NULL,
  balance            numeric(14,2) NOT NULL,
  doc_number         text,
  memo               text,
  lines              jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_job_id   uuid REFERENCES jobs(id) ON DELETE SET NULL,
  suggestion_note    text,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_id)
);

CREATE TABLE acct_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider              text NOT NULL,
  external_id           text NOT NULL,
  customer_external_id  text,
  customer_name         text NOT NULL,
  contact_id            uuid REFERENCES contacts(id) ON DELETE SET NULL,
  job_id                uuid REFERENCES jobs(id) ON DELETE SET NULL,
  txn_date              date,
  due_date              date,
  amount                numeric(14,2) NOT NULL,
  balance               numeric(14,2) NOT NULL,
  doc_number            text,
  synced_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_id)
);

CREATE TABLE acct_sync_runs (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  bills        integer,
  invoices     integer,
  error        text
);
