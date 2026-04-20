-- 20260419000000_injection_attempts.sql
-- Refused prompt-injection / data-exfiltration attempts.
-- Written by ghl-sales-agent, ghl-member-agent, and (future) ai-phil-email-agent
-- when detectInjectionAttempt returns matched=true. Service-role-only; RLS
-- enabled with zero policies so anon + authenticated have no access.
-- See 80-processes/AI-Phil-Security-Boundaries.md §3 and §5.

CREATE TABLE IF NOT EXISTS ops.injection_attempts (
  id              bigserial PRIMARY KEY,
  contact_id      text NOT NULL,
  surface         text NOT NULL,           -- 'ghl-sales-agent' | 'ghl-member-agent' | 'widget-chat' | 'hume-evi'
  attempt_pattern text NOT NULL,           -- stable label from detectInjectionAttempt
  message_preview text NOT NULL,           -- first 500 chars, for human review
  model_response  text,                    -- the canned refusal sent (PRIMARY)
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS injection_attempts_contact_time_idx
  ON ops.injection_attempts (contact_id, created_at DESC);

ALTER TABLE ops.injection_attempts ENABLE ROW LEVEL SECURITY;
-- No policies => anon + authenticated have zero access.
-- service_role bypasses RLS automatically.

COMMENT ON TABLE ops.injection_attempts IS
  'Refused prompt-injection attempts per AI-Phil-Security-Boundaries.md §3/§5. Service-role-only. Rolling 3-in-24h rollup auto-flags contact for human review. See docs/superpowers/specs/2026-04-19-security-boundary-block-design.md.';
