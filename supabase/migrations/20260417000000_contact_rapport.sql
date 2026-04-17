-- 20260417000000_contact_rapport.sql
-- Per-contact F.O.R.M. rapport facts. Append-only jsonb, keep forever.
-- Read by every AI agent before building a prompt; written by the
-- post-conversation extractor after every turn.

CREATE TABLE IF NOT EXISTS ops.contact_rapport (
  contact_id         text PRIMARY KEY,
  facts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  fact_count         int NOT NULL DEFAULT 0,
  last_extracted_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_rapport_updated_at_idx
  ON ops.contact_rapport (updated_at DESC);

-- Service-role only (consistent with other ops tables).
ALTER TABLE ops.contact_rapport ENABLE ROW LEVEL SECURITY;

-- No policies => anon + authenticated have zero access.
-- service_role bypasses RLS automatically.

COMMENT ON TABLE ops.contact_rapport IS
  'Structured per-contact F.O.R.M. facts (Family/Occupation/Recreation/Money). Append-only, keep forever. See docs/superpowers/specs/2026-04-16-ai-sales-system-v2-ris-phase1-design.md §5.3.';
