-- Photos and files that came in with a text.
ALTER TABLE interactions ADD COLUMN media jsonb;

CREATE TABLE permits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('permit','inspection')),
  title         text NOT NULL,                 -- "Building permit", "Rough electrical"
  status        text NOT NULL DEFAULT 'needed' CHECK (status IN ('needed','applied','issued','scheduled','passed','failed','expired','not_needed')),
  reference     text,                          -- permit or case number
  due_date      date,                          -- apply by, or inspection date
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX permits_open ON permits (tenant_id, due_date) WHERE status NOT IN ('passed','not_needed','issued');
