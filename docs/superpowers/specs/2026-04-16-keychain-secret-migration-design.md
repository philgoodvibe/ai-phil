---
type: spec
date: 2026-04-16
tags: [security, keychain, secrets, ai-phil, sage, ris-phase1]
status: approved
scope: ai-phil + SAGE/app
related:
  - docs/superpowers/plans/2026-04-16-ai-sales-system-v2-ris-phase1-plan.md
  - vault/50-meetings/2026-04-17-ris-phase1-foundation-shipped.md
---

# Keychain Secret Migration — Design Spec (Task 0)

## Context

Phillip raised a defensive-security concern at end of Session 1 (2026-04-17 meeting summary §Security): local-dev `.env*` files across his Coding Projects directory store Supabase service-role keys, Hume API keys, and other high-blast-radius secrets in plaintext. If the Mac is compromised, every plaintext secret leaks. Apple Keychain stores them encrypted behind the login password.

Production edge-function secrets are already safe (Supabase vault). Vercel production env vars are already safe (Vercel-side). The exposure is local-dev only — but "local-dev only" still includes the `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS on the shared production database.

## Goals

- Zero plaintext high-blast-radius secrets on disk for the two in-scope repos
- No change to runtime behavior — `npm run dev` still works
- Establish a pattern simple enough to copy into future projects (GHL Commander, Automated Reels, etc.) in under 5 minutes each
- Fail loudly and explicitly if a Keychain entry is missing (no silent degradation)

## Non-goals

- **Not** migrating public `NEXT_PUBLIC_*` or `VITE_*` values — those ship to the client bundle and are not secrets
- **Not** migrating the 6+ other Coding Projects `.env` files this session (pattern established here can be applied later on demand)
- **Not** replacing Vercel / Supabase vault for production secrets
- **Not** building a shared cross-repo secret CLI — two repos is too few to justify the abstraction
- **Not** supporting non-macOS environments (single-Mac workflow)

## Scope

**In scope — 2 files, 9 real secret entries:**

| Repo | File | Real secrets to migrate |
|---|---|---|
| ai-phil | `.env.local` | `SUPABASE_SERVICE_ROLE_KEY`, `HUME_API_KEY`, `HUME_SECRET_KEY`, `HUME_TOOL_SECRET` |
| SAGE | `app/.env.local` | `SUPABASE_SERVICE_ROLE_KEY`, `HUME_API_KEY`, `HUME_SECRET_KEY`, `HUME_TOOL_SECRET`, `GEMINI_API_KEY` |

**Explicitly NOT migrated (public / non-secret):**

- All `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — public-by-design per Supabase architecture; ship in client bundle
- All `VITE_*` keys in SAGE/extension and the embedded membership-portal copy — Vite convention, ship in client bundle
- `HUME_EVI_CONFIG_*` config IDs — not secrets, just IDs

## Architecture

**Per-repo shell loader.** Each repo is self-contained: it owns its Keychain entries (namespaced by repo), its loader script, and its `.env.local`. No shared code between repos. No new dependencies.

### Keychain entry naming

- **Service name:** `<repo>-<secret-kebab>`, e.g. `ai-phil-hume-api-key`, `sage-supabase-service-role`
- **Account field:** always `default` (reserved for future per-env overrides if needed)
- Even when two repos share the same underlying value (e.g. identical Hume keys), store separately per repo. Repos stay rotatable independently and loaders stay self-contained.

### Full Keychain entry list

| Service name | Env var | Source repo |
|---|---|---|
| `ai-phil-supabase-service-role` | `SUPABASE_SERVICE_ROLE_KEY` | ai-phil |
| `ai-phil-hume-api-key` | `HUME_API_KEY` | ai-phil |
| `ai-phil-hume-secret-key` | `HUME_SECRET_KEY` | ai-phil |
| `ai-phil-hume-tool-secret` | `HUME_TOOL_SECRET` | ai-phil |
| `sage-supabase-service-role` | `SUPABASE_SERVICE_ROLE_KEY` | SAGE/app |
| `sage-hume-api-key` | `HUME_API_KEY` | SAGE/app |
| `sage-hume-secret-key` | `HUME_SECRET_KEY` | SAGE/app |
| `sage-hume-tool-secret` | `HUME_TOOL_SECRET` | SAGE/app |
| `sage-gemini-api-key` | `GEMINI_API_KEY` | SAGE/app |

Total: 9 entries across 2 repos.

## Components (per repo)

### 1. `scripts/load-secrets-from-keychain.sh` (committed)

Sourced before `npm run dev`. Looks up each secret from Keychain, exports into env, fails loudly if any entry is missing.

```bash
#!/usr/bin/env bash
# Load secrets from macOS Keychain. Source this before `npm run dev`.
# Fails nonzero with remediation if any secret is missing.
set -euo pipefail

if ! command -v security >/dev/null 2>&1; then
  echo "❌ macOS 'security' CLI not found. This loader is macOS-only." >&2
  return 1 2>/dev/null || exit 1
fi

load() {
  local env_var="$1" keychain_service="$2" value
  if ! value=$(security find-generic-password -w -s "$keychain_service" -a default 2>/dev/null); then
    echo "❌ Missing Keychain entry: $keychain_service" >&2
    echo "   Run: security add-generic-password -s '$keychain_service' -a default -w '<value>' -U" >&2
    return 1
  fi
  export "$env_var=$value"
}

# ai-phil secrets:
load SUPABASE_SERVICE_ROLE_KEY ai-phil-supabase-service-role
load HUME_API_KEY              ai-phil-hume-api-key
load HUME_SECRET_KEY           ai-phil-hume-secret-key
load HUME_TOOL_SECRET          ai-phil-hume-tool-secret

echo "✅ Secrets loaded from Keychain"
```

SAGE version identical shape, with 5 `load` lines using `sage-*` service names.

### 2. `scripts/migrate-secrets-to-keychain.sh` (committed; one-time per repo but kept for future)

One-shot tool. Reads the current `.env.local`, prompts to confirm each secret, runs `security add-generic-password -U`, then writes a sanitized `.env.local` keeping only the public keys.

Behavior:
1. Parse `.env.local` for the known-secret keys (hard-coded list per repo, matching the loader's `load` lines).
2. For each: `security add-generic-password -s <service> -a default -w <current-value> -U`.
3. Write `.env.local.backup-<timestamp>` (gitignored) with the full original contents.
4. Write a new `.env.local` that contains only the public/non-secret keys + a header comment pointing to the loader.
5. Print verification command: `grep -E '^(SUPABASE_SERVICE_ROLE_KEY|HUME_(API_KEY|SECRET_KEY|TOOL_SECRET))' .env.local` should return nothing.

Committed to git — it's a reusable utility for future project migrations.

### 3. Rewritten `.env.local` (stays gitignored)

After migration, contains only public config. Example for ai-phil:

```bash
# Public config — safe in plaintext. Secrets live in macOS Keychain.
# Run: `npm run dev` (auto-sources scripts/load-secrets-from-keychain.sh)

NEXT_PUBLIC_SUPABASE_URL=https://ylppltmwueasbdexepip.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon JWT — public-by-design>

# Non-secret EVI config IDs:
HUME_EVI_CONFIG_NEW_MEMBER=<config id>
HUME_EVI_CONFIG_IMPLEMENTATION=<config id>
HUME_EVI_CONFIG_DISCOVERY=<config id>
```

### 4. `package.json` update

```json
"scripts": {
  "dev": "source scripts/load-secrets-from-keychain.sh && next dev",
  "dev:nosecrets": "next dev"
}
```

- Only `dev` auto-sources the loader. `build` is intentionally NOT wrapped — Vercel's CI build environment has no macOS `security` CLI, and wrapping `build` would break production deployment if Vercel's build command ever points at `npm run build` instead of `next build` directly. Local production-build testing: run `source scripts/load-secrets-from-keychain.sh && npm run build` manually.
- `dev:nosecrets` is an escape hatch for client-only work where no server-side secret is needed.
- `typecheck` and `lint` do NOT source the loader — they don't need runtime secrets.

## Data flow

```
developer runs `npm run dev`
  → npm executes `source scripts/load-secrets-from-keychain.sh && next dev`
  → loader calls `security find-generic-password -w -s <entry> -a default` N times
  → exports each value into current shell env
  → `next dev` inherits the env and starts as before
  → runtime reads secrets via process.env, same as before migration
```

## Error handling

| Failure | Behavior |
|---|---|
| Missing Keychain entry | Exit 1, print exact `security add-generic-password` remediation command |
| Keychain locked | macOS pops unlock prompt; loader blocks until unlocked (standard OS behavior) |
| `security` CLI missing (non-macOS) | Exit 1 with "macOS-only" message |
| Corrupted Keychain entry / wrong value | Loader still exports it; runtime fails downstream (Hume 401, Supabase auth error). Acceptable — error surfaces on first API call. |

## Rollback

If anything breaks mid-migration or post-migration:

1. `mv .env.local.backup-<timestamp> .env.local` — restores original plaintext file
2. Revert `package.json` `dev` script to `next dev`
3. Keychain entries remain harmlessly; optional cleanup via `security delete-generic-password -s <service> -a default` per entry

Rollback is fully local — no git history rewrites, no remote state changes.

## Testing

Per repo, after migration:

1. **Plaintext check:** `grep -E '(SERVICE_ROLE|HUME_(API|SECRET|TOOL))_' .env.local` returns nothing. No `eyJ`-JWT secrets (only the `NEXT_PUBLIC_` anon key, which is public).
2. **Loader smoke test:** `source scripts/load-secrets-from-keychain.sh` prints `✅ Secrets loaded` and exits 0.
3. **App smoke test (ai-phil):**
   - `npm run dev` → server starts
   - `curl http://localhost:3000/api/hume/access-token` → 200 + access token (exercises `HUME_API_KEY`/`HUME_SECRET_KEY`)
   - Hit an admin route that uses service role (e.g. `/api/admin/sync-docs` GET) → 200 or 405 (not 401)
4. **App smoke test (SAGE):** equivalent routes on SAGE app
5. **Failure injection:** `security delete-generic-password -s ai-phil-hume-api-key -a default` → `npm run dev` exits with the remediation message. Restore using the original value from `.env.local.backup-<timestamp>`: `security add-generic-password -s ai-phil-hume-api-key -a default -w "$(grep '^HUME_API_KEY=' .env.local.backup-<timestamp> | cut -d= -f2-)" -U`.

## Security considerations

- `.gitignore` must include `.env.local.backup-*` — the backup file is plaintext and transient; never commit it. ai-phil's existing `.gitignore` already blocks `.env*` — verify still covers `.backup-*`.
- Secrets printed to shell history risk: `migrate-secrets-to-keychain.sh` must NOT pass secrets on the command line (visible in `ps` output on shared systems). Instead: read from the current `.env.local` into a variable and use `security add-generic-password -w "$value"` — the bash variable is in-process only.
- Keychain sync: if Phillip's Mac has iCloud Keychain enabled, these entries may sync to other Apple devices. Acceptable for this workflow, but document it. The default macOS Keychain (login keychain) does sync per iCloud Keychain settings.
- Service-role keys remain as powerful as they were — Keychain protects at-rest, not in-use. Once loaded into env, they're as accessible as any env var.

## Out of scope (explicit YAGNI)

- Rotating any secret as part of this migration (that's a separate security hygiene exercise)
- Touching the 6+ other Coding Projects `.env` files
- Replacing Vercel / Supabase vault
- Building a secret-manifest / shared CLI
- Supporting Linux/WSL developers (not a reality on this setup)
- Keychain UI-based access-control prompts (acceptable as-is per default Keychain settings)

## Change log

| Date | Change | Author |
|---|---|---|
| 2026-04-16 | Initial spec — Task 0 of RIS Phase 1 Session 2 | Claude Code (on Phillip's direction, decisions via Power Law Principle) |
