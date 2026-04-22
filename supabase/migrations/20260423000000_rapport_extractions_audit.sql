-- 20260423000000_rapport_extractions_audit.sql
-- F.O.R.M. extractor audit log. One row per extractRapport invocation across
-- ghl-sales-agent, ghl-sales-followup, ghl-member-agent. Distinguishes
-- "extractor ran and found nothing" from "never ran" vs "failed" — the gap
-- that made zero-rapport-rows look like a silent bug pre-2026-04-21.
-- See docs/superpowers/specs/2026-04-21-form-extractor-fix-design.md §3.2.

CREATE TABLE IF NOT EXISTS ops.rapport_extractions (
  id                bigserial PRIMARY KEY,
  contact_id        text NOT NULL,
  conversation_id   text,
  surface           text NOT NULL
    CHECK (surface IN (
      'ghl-sales-agent',
      'ghl-sales-followup',
      'ghl-member-agent'
    )),
  haiku_status      text NOT NULL
    CHECK (haiku_status IN (
      'ok',
      'empty',
      'http_error',
      'parse_error',
      'no_api_key',
      'threw',
      'skipped_no_user_content'
    )),
  facts_added       int NOT NULL DEFAULT 0,
  facts_total_after int NOT NULL DEFAULT 0,
  latency_ms        int,
  error_snippet     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rapport_extractions_contact_time_idx
  ON ops.rapport_extractions (contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS rapport_extractions_created_idx
  ON ops.rapport_extractions (created_at DESC);

ALTER TABLE ops.rapport_extractions ENABLE ROW LEVEL SECURITY;
-- No policies => anon + authenticated have zero access.
-- service_role bypasses RLS automatically.

COMMENT ON TABLE ops.rapport_extractions IS
  'One row per F.O.R.M. extractor invocation across all AI Phil surfaces. Existence of a row = extractor ran. haiku_status distinguishes "ran and found nothing" from "never ran" vs "failed". See docs/superpowers/specs/2026-04-21-form-extractor-fix-design.md.';

COMMENT ON COLUMN ops.rapport_extractions.facts_added IS
  'Number of NEW facts added to ops.contact_rapport on this invocation. Zero when status=empty/error; matches the delta between pre- and post-merge pillar sums otherwise.';

COMMENT ON COLUMN ops.rapport_extractions.facts_total_after IS
  'Total fact count on ops.contact_rapport after this invocation. Snapshot for post-hoc trend analysis without joining to the rapport table.';

COMMENT ON COLUMN ops.rapport_extractions.error_snippet IS
  'First 200 chars of error or raw Haiku response when status != ok/empty. Never contains API keys, prompt contents, or conversation text.';
