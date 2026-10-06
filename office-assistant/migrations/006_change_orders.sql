CREATE TABLE change_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id              uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  number              integer NOT NULL,
  title               text NOT NULL,
  description         text NOT NULL,
  items               jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{description, quantity, unit, unitPrice}]
  amount              numeric(12,2),                          -- null until a person confirms a price
  schedule_days       integer,
  questions           jsonb NOT NULL DEFAULT '[]'::jsonb,     -- what the drafter could not know
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','declined','void')),
  source_text         text,
  source              text NOT NULL DEFAULT 'app' CHECK (source IN ('app','text')),
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, job_id, number)
);
CREATE INDEX change_orders_status ON change_orders (tenant_id, status, created_at DESC);
