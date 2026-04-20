/**
 * Pure, DST-aware business-hours gate for the ghl-sales-followup edge function.
 *
 * Pattern comes from Phase 0 Task 3 (2026-04-20): pg_cron on Supabase fires
 * in UTC only. Rather than author a cron schedule in UTC and drift every DST
 * boundary, we fire every hour Mon-Fri UTC and check the current Pacific
 * local hour here. Intl.DateTimeFormat handles DST automatically.
 *
 * Business window: 09:00 - 17:59 America/Los_Angeles, Mon-Fri.
 */

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  hour12: false,
  weekday: 'short',
});

const BUSINESS_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
const START_HOUR = 9;
const END_HOUR = 17;

export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const parts = FORMATTER.formatToParts(now);
  const hourStr = parts.find((p) => p.type === 'hour')?.value;
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  if (!hourStr || !weekday) return false;
  const hour = Number(hourStr);
  if (!Number.isFinite(hour)) return false;
  return BUSINESS_DAYS.has(weekday) && hour >= START_HOUR && hour <= END_HOUR;
}
