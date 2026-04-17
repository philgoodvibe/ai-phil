# Keychain Secret Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all high-blast-radius secrets out of plaintext `.env.local` files in ai-phil and SAGE/app into macOS Keychain, with a sourced shell loader that restores them into the dev env automatically.

**Architecture:** Per-repo shell loader (`scripts/load-secrets-from-keychain.sh`) sourced by `npm run dev`. One-time migration helper (`scripts/migrate-secrets-to-keychain.sh`) reads the current `.env.local`, stores secrets in Keychain, and rewrites `.env.local` to contain only public keys. Both scripts committed. Secrets in macOS login Keychain under `<repo>-<secret-name>` service names with account `default`.

**Tech Stack:** macOS `security` CLI, bash, Next.js 14, two repos (ai-phil, SAGE/app).

**Repo paths:**
- ai-phil: `/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil`
- SAGE/app: `/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/SAGE - Screen Aware Guided Experience/app`

(In steps below, `AI_PHIL_ROOT` = ai-phil path, `SAGE_APP` = SAGE/app path.)

**Spec:** `docs/superpowers/specs/2026-04-16-keychain-secret-migration-design.md`

---

## File Map

| Action | File |
|---|---|
| Create | `AI_PHIL_ROOT/scripts/load-secrets-from-keychain.sh` |
| Create | `AI_PHIL_ROOT/scripts/migrate-secrets-to-keychain.sh` |
| Modify | `AI_PHIL_ROOT/package.json` (dev script) |
| Rewrite | `AI_PHIL_ROOT/.env.local` (secrets removed — done by migrate script) |
| Create | `SAGE_APP/scripts/load-secrets-from-keychain.sh` |
| Create | `SAGE_APP/scripts/migrate-secrets-to-keychain.sh` |
| Modify | `SAGE_APP/package.json` (dev script) |
| Rewrite | `SAGE_APP/.env.local` (secrets removed — done by migrate script) |

---

## Task 1: Write ai-phil loader script

**Files:**
- Create: `AI_PHIL_ROOT/scripts/load-secrets-from-keychain.sh`

- [ ] **Step 1.1: Create `scripts/` dir and write the loader**

```bash
mkdir -p "AI_PHIL_ROOT/scripts"
```

Write `AI_PHIL_ROOT/scripts/load-secrets-from-keychain.sh` with this exact content:

```bash
#!/usr/bin/env bash
# Load ai-phil secrets from macOS Keychain.
# Source this before `next dev`: source scripts/load-secrets-from-keychain.sh
# Exits nonzero with remediation if any entry is missing.
set -euo pipefail

if ! command -v security >/dev/null 2>&1; then
  echo "❌ macOS 'security' CLI not found. This loader is macOS-only." >&2
  return 1 2>/dev/null || exit 1
fi

load() {
  local env_var="$1" keychain_service="$2" value
  if ! value=$(security find-generic-password -w -s "$keychain_service" -a default 2>/dev/null); then
    echo "❌ Missing Keychain entry: $keychain_service" >&2
    echo "   Fix: security add-generic-password -s '$keychain_service' -a default -w '<value>' -U" >&2
    return 1
  fi
  export "$env_var=$value"
}

load SUPABASE_SERVICE_ROLE_KEY  ai-phil-supabase-service-role
load HUME_API_KEY               ai-phil-hume-api-key
load HUME_SECRET_KEY            ai-phil-hume-secret-key
load HUME_TOOL_SECRET           ai-phil-hume-tool-secret

echo "✅ ai-phil secrets loaded from Keychain"
```

- [ ] **Step 1.2: Make it executable**

```bash
chmod +x "AI_PHIL_ROOT/scripts/load-secrets-from-keychain.sh"
```

---

## Task 2: Verify loader fails correctly (before Keychain is populated)

This is the TDD step — confirm the error path works before any data exists.

- [ ] **Step 2.1: Source the loader and confirm it exits nonzero with the right message**

```bash
cd "AI_PHIL_ROOT"
source scripts/load-secrets-from-keychain.sh 2>&1 || true
```

Expected output (exact keys may vary if some happen to already exist in Keychain):
```
❌ Missing Keychain entry: ai-phil-supabase-service-role
   Fix: security add-generic-password -s 'ai-phil-supabase-service-role' -a default -w '<value>' -U
```

If output says `✅ ai-phil secrets loaded from Keychain` — the Keychain entries already exist from a prior run. Skip to Task 4 for this repo.

---

## Task 3: Write ai-phil migration script

**Files:**
- Create: `AI_PHIL_ROOT/scripts/migrate-secrets-to-keychain.sh`

- [ ] **Step 3.1: Write the migration helper**

Write `AI_PHIL_ROOT/scripts/migrate-secrets-to-keychain.sh` with this exact content:

```bash
#!/usr/bin/env bash
# One-time migration: reads ai-phil/.env.local, stores secrets in macOS Keychain,
# then rewrites .env.local to contain only public/non-secret keys.
# Run from AI_PHIL_ROOT: bash scripts/migrate-secrets-to-keychain.sh
set -euo pipefail

ENV_FILE=".env.local"
BACKUP=".env.local.backup-$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ $ENV_FILE not found. Run from the repo root." >&2
  exit 1
fi

# Back up original
cp "$ENV_FILE" "$BACKUP"
echo "✅ Backed up to $BACKUP"

# Helper: read a value from the env file
read_env() {
  grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

# Helper: store in Keychain (silent update if exists)
store() {
  local service="$1" env_var="$2"
  local value
  value=$(read_env "$env_var")
  if [[ -z "$value" ]]; then
    echo "⚠️  $env_var not found in $ENV_FILE — skipping $service" >&2
    return 0
  fi
  security add-generic-password -s "$service" -a default -w "$value" -U 2>/dev/null
  echo "✅ Stored $service"
}

echo ""
echo "Storing secrets in Keychain..."
store ai-phil-supabase-service-role  SUPABASE_SERVICE_ROLE_KEY
store ai-phil-hume-api-key           HUME_API_KEY
store ai-phil-hume-secret-key        HUME_SECRET_KEY
store ai-phil-hume-tool-secret       HUME_TOOL_SECRET

echo ""
echo "Rewriting .env.local (keeping only public keys)..."

# Collect public / non-secret values
SUPABASE_URL=$(read_env NEXT_PUBLIC_SUPABASE_URL)
SUPABASE_ANON=$(read_env NEXT_PUBLIC_SUPABASE_ANON_KEY)
EVI_NEW_MEMBER=$(read_env HUME_EVI_CONFIG_NEW_MEMBER)
EVI_IMPL=$(read_env HUME_EVI_CONFIG_IMPLEMENTATION)
EVI_DISC=$(read_env HUME_EVI_CONFIG_DISCOVERY)

cat > "$ENV_FILE" <<EOF
# Public config — safe in plaintext. Secrets live in macOS Keychain.
# Run: \`npm run dev\` (auto-sources scripts/load-secrets-from-keychain.sh)

# Public by Supabase design — ships in client bundle
NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON}

# Non-secret Hume EVI config IDs
HUME_EVI_CONFIG_NEW_MEMBER=${EVI_NEW_MEMBER}
HUME_EVI_CONFIG_IMPLEMENTATION=${EVI_IMPL}
HUME_EVI_CONFIG_DISCOVERY=${EVI_DISC}
EOF

echo "✅ .env.local rewritten"
echo ""
echo "Done. Verify with:"
echo "  grep -E '(SERVICE_ROLE|HUME_(API|SECRET|TOOL))_' .env.local   # should return nothing"
echo "  source scripts/load-secrets-from-keychain.sh                   # should print ✅"
```

- [ ] **Step 3.2: Make it executable**

```bash
chmod +x "AI_PHIL_ROOT/scripts/migrate-secrets-to-keychain.sh"
```

---

## Task 4: Run ai-phil migration

**Precondition:** `AI_PHIL_ROOT/.env.local` exists and contains the real secrets (current state — not yet touched).

- [ ] **Step 4.1: Run the migration**

```bash
cd "AI_PHIL_ROOT"
bash scripts/migrate-secrets-to-keychain.sh
```

Expected output:
```
✅ Backed up to .env.local.backup-20260416-HHMMSS

Storing secrets in Keychain...
✅ Stored ai-phil-supabase-service-role
✅ Stored ai-phil-hume-api-key
✅ Stored ai-phil-hume-secret-key
✅ Stored ai-phil-hume-tool-secret

Rewriting .env.local (keeping only public keys)...
✅ .env.local rewritten

Done. Verify with:
  grep -E '(SERVICE_ROLE|HUME_(API|SECRET|TOOL))_' .env.local   # should return nothing
  source scripts/load-secrets-from-keychain.sh                   # should print ✅
```

If macOS shows a Keychain access dialog — click "Always Allow" so the `security` CLI can access the login keychain without prompting in future.

- [ ] **Step 4.2: Verify .env.local contains no secrets**

```bash
cd "AI_PHIL_ROOT"
grep -E '(SERVICE_ROLE|HUME_(API|SECRET|TOOL))_' .env.local
```

Expected: **no output** (zero matches).

---

## Task 5: Verify ai-phil loader succeeds (green path)

- [ ] **Step 5.1: Source the loader**

```bash
cd "AI_PHIL_ROOT"
source scripts/load-secrets-from-keychain.sh
```

Expected:
```
✅ ai-phil secrets loaded from Keychain
```

- [ ] **Step 5.2: Confirm env vars are set**

```bash
[[ -n "$SUPABASE_SERVICE_ROLE_KEY" ]] && echo "✅ SUPABASE_SERVICE_ROLE_KEY set" || echo "❌ missing"
[[ -n "$HUME_API_KEY" ]] && echo "✅ HUME_API_KEY set" || echo "❌ missing"
[[ -n "$HUME_SECRET_KEY" ]] && echo "✅ HUME_SECRET_KEY set" || echo "❌ missing"
[[ -n "$HUME_TOOL_SECRET" ]] && echo "✅ HUME_TOOL_SECRET set" || echo "❌ missing"
```

Expected: all four print `✅`.

---

## Task 6: Update ai-phil package.json dev script

**Files:**
- Modify: `AI_PHIL_ROOT/package.json`

- [ ] **Step 6.1: Update the dev script**

In `AI_PHIL_ROOT/package.json`, change the `"scripts"` block from:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "typecheck": "tsc --noEmit"
},
```

to:

```json
"scripts": {
  "dev": "source scripts/load-secrets-from-keychain.sh && next dev",
  "dev:nosecrets": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "typecheck": "tsc --noEmit"
},
```

---

## Task 7: Smoke test ai-phil end-to-end

- [ ] **Step 7.1: Start dev server via npm run dev**

```bash
cd "AI_PHIL_ROOT"
npm run dev &
DEV_PID=$!
sleep 5  # wait for Next.js startup
```

Expected: server starts on port 3000. No "missing env var" errors in startup output.

- [ ] **Step 7.2: Test a route that exercises a real secret (Hume)**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/hume/access-token
```

Expected: `200` (valid Hume token returned). If `401` — the secret loaded but the Hume key is wrong. If `500` — check server logs for missing env var.

- [ ] **Step 7.3: Test a route that exercises Supabase service role**

```bash
curl -s -o /dev/null -w "%{http_code}" -X GET http://localhost:3000/api/admin/sync-docs
```

Expected: `200` or `405` (method not allowed is fine — means auth passed and route was reached). `401` means service role key not loaded.

- [ ] **Step 7.4: Stop the dev server**

```bash
kill $DEV_PID 2>/dev/null || true
```

- [ ] **Step 7.5: Commit ai-phil changes**

```bash
cd "AI_PHIL_ROOT"
git add scripts/load-secrets-from-keychain.sh scripts/migrate-secrets-to-keychain.sh package.json .env.local
git status  # verify no unexpected files staged
git commit -m "$(cat <<'EOF'
feat(security): move secrets to macOS Keychain, keep only public keys in .env.local

SUPABASE_SERVICE_ROLE_KEY, HUME_API_KEY, HUME_SECRET_KEY, HUME_TOOL_SECRET
now live in macOS Keychain under 'ai-phil-*' service names.

scripts/load-secrets-from-keychain.sh: sourced by `npm run dev` to restore them.
scripts/migrate-secrets-to-keychain.sh: one-time helper, kept for future projects.
.env.local: now contains only NEXT_PUBLIC_* and EVI config IDs (public-safe).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Write SAGE loader script

**Files:**
- Create: `SAGE_APP/scripts/load-secrets-from-keychain.sh`

- [ ] **Step 8.1: Create scripts/ dir in SAGE app**

```bash
mkdir -p "SAGE_APP/scripts"
```

- [ ] **Step 8.2: Write the SAGE loader**

Write `SAGE_APP/scripts/load-secrets-from-keychain.sh`:

```bash
#!/usr/bin/env bash
# Load SAGE/app secrets from macOS Keychain.
# Source this before `next dev`: source scripts/load-secrets-from-keychain.sh
# Exits nonzero with remediation if any entry is missing.
set -euo pipefail

if ! command -v security >/dev/null 2>&1; then
  echo "❌ macOS 'security' CLI not found. This loader is macOS-only." >&2
  return 1 2>/dev/null || exit 1
fi

load() {
  local env_var="$1" keychain_service="$2" value
  if ! value=$(security find-generic-password -w -s "$keychain_service" -a default 2>/dev/null); then
    echo "❌ Missing Keychain entry: $keychain_service" >&2
    echo "   Fix: security add-generic-password -s '$keychain_service' -a default -w '<value>' -U" >&2
    return 1
  fi
  export "$env_var=$value"
}

load SUPABASE_SERVICE_ROLE_KEY  sage-supabase-service-role
load HUME_API_KEY               sage-hume-api-key
load HUME_SECRET_KEY            sage-hume-secret-key
load HUME_TOOL_SECRET           sage-hume-tool-secret
load GEMINI_API_KEY             sage-gemini-api-key

echo "✅ SAGE secrets loaded from Keychain"
```

- [ ] **Step 8.3: Make it executable**

```bash
chmod +x "SAGE_APP/scripts/load-secrets-from-keychain.sh"
```

---

## Task 9: Write and run SAGE migration script

**Files:**
- Create: `SAGE_APP/scripts/migrate-secrets-to-keychain.sh`

- [ ] **Step 9.1: Write the SAGE migration helper**

Write `SAGE_APP/scripts/migrate-secrets-to-keychain.sh`:

```bash
#!/usr/bin/env bash
# One-time migration: reads SAGE/app/.env.local, stores secrets in macOS Keychain,
# then rewrites .env.local to contain only public/non-secret keys.
# Run from SAGE_APP: bash scripts/migrate-secrets-to-keychain.sh
set -euo pipefail

ENV_FILE=".env.local"
BACKUP=".env.local.backup-$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ $ENV_FILE not found. Run from SAGE_APP root." >&2
  exit 1
fi

cp "$ENV_FILE" "$BACKUP"
echo "✅ Backed up to $BACKUP"

read_env() {
  grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

store() {
  local service="$1" env_var="$2"
  local value
  value=$(read_env "$env_var")
  if [[ -z "$value" ]]; then
    echo "⚠️  $env_var not found in $ENV_FILE — skipping $service" >&2
    return 0
  fi
  security add-generic-password -s "$service" -a default -w "$value" -U 2>/dev/null
  echo "✅ Stored $service"
}

echo ""
echo "Storing secrets in Keychain..."
store sage-supabase-service-role  SUPABASE_SERVICE_ROLE_KEY
store sage-hume-api-key           HUME_API_KEY
store sage-hume-secret-key        HUME_SECRET_KEY
store sage-hume-tool-secret       HUME_TOOL_SECRET
store sage-gemini-api-key         GEMINI_API_KEY

echo ""
echo "Rewriting .env.local (keeping only public keys)..."

SUPABASE_URL=$(read_env NEXT_PUBLIC_SUPABASE_URL)
SUPABASE_ANON=$(read_env NEXT_PUBLIC_SUPABASE_ANON_KEY)
DEV_AUTH=$(read_env NEXT_PUBLIC_DEV_AUTH)
EVI_NEW_MEMBER=$(read_env HUME_EVI_CONFIG_NEW_MEMBER)
EVI_IMPL=$(read_env HUME_EVI_CONFIG_IMPLEMENTATION)
EVI_DISC=$(read_env HUME_EVI_CONFIG_DISCOVERY)

cat > "$ENV_FILE" <<EOF
# Public config — safe in plaintext. Secrets live in macOS Keychain.
# Run: \`npm run dev\` (auto-sources scripts/load-secrets-from-keychain.sh)

# Public by Supabase design — ships in client bundle
NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON}

# Dev auth bypass flag (public — controls client-side behavior only)
NEXT_PUBLIC_DEV_AUTH=${DEV_AUTH}

# Non-secret Hume EVI config IDs
HUME_EVI_CONFIG_NEW_MEMBER=${EVI_NEW_MEMBER}
HUME_EVI_CONFIG_IMPLEMENTATION=${EVI_IMPL}
HUME_EVI_CONFIG_DISCOVERY=${EVI_DISC}
EOF

echo "✅ .env.local rewritten"
echo ""
echo "Done. Verify with:"
echo "  grep -E '(SERVICE_ROLE|HUME_(API|SECRET|TOOL)|GEMINI)_' .env.local"
echo "  source scripts/load-secrets-from-keychain.sh"
```

- [ ] **Step 9.2: Make it executable**

```bash
chmod +x "SAGE_APP/scripts/migrate-secrets-to-keychain.sh"
```

- [ ] **Step 9.3: Verify SAGE loader fails correctly (before migration)**

```bash
cd "SAGE_APP"
source scripts/load-secrets-from-keychain.sh 2>&1 || true
```

Expected: `❌ Missing Keychain entry: sage-supabase-service-role` (or similar). If `✅ SAGE secrets loaded` — entries already exist, skip to Step 9.5.

- [ ] **Step 9.4: Run SAGE migration**

```bash
cd "SAGE_APP"
bash scripts/migrate-secrets-to-keychain.sh
```

Expected: 5 `✅ Stored` lines + `✅ .env.local rewritten`.

- [ ] **Step 9.5: Verify SAGE .env.local contains no secrets**

```bash
cd "SAGE_APP"
grep -E '(SERVICE_ROLE|HUME_(API|SECRET|TOOL)|GEMINI)_' .env.local
```

Expected: no output.

- [ ] **Step 9.6: Source SAGE loader (green path)**

```bash
cd "SAGE_APP"
source scripts/load-secrets-from-keychain.sh
```

Expected: `✅ SAGE secrets loaded from Keychain`.

---

## Task 10: Update SAGE package.json and smoke test

**Files:**
- Modify: `SAGE_APP/package.json`

- [ ] **Step 10.1: Update SAGE dev script**

In `SAGE_APP/package.json`, change the `"scripts"` block from:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "typecheck": "tsc --noEmit"
},
```

to:

```json
"scripts": {
  "dev": "source scripts/load-secrets-from-keychain.sh && next dev",
  "dev:nosecrets": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "typecheck": "tsc --noEmit"
},
```

- [ ] **Step 10.2: Smoke test SAGE dev server**

```bash
cd "SAGE_APP"
npm run dev &
SAGE_PID=$!
sleep 5
```

Expected: server starts on default port (3000 or 3001 if ai-phil is running). No missing env var errors.

- [ ] **Step 10.3: Verify SAGE routes that use secrets**

Check which server-side API routes exist:

```bash
ls "SAGE_APP/src/app/api/" 2>/dev/null || ls "SAGE_APP/src/pages/api/" 2>/dev/null
```

Hit the first route listed with curl on port 3000 (or 3001 if ai-phil is running on 3000):

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/<first-route-found>
```

Expected: any response code that is NOT `500` with a "missing environment variable" body. A `401` or `405` is acceptable — means the route was reached. If startup itself completed without a "missing env" error in the terminal, that is sufficient confirmation.

- [ ] **Step 10.4: Stop SAGE dev server**

```bash
kill $SAGE_PID 2>/dev/null || true
```

---

## Task 11: Security verification + commit SAGE

- [ ] **Step 11.1: Final grep across both .env.local files**

```bash
echo "=== ai-phil ==="
grep -E '(SERVICE_ROLE|HUME_(API|SECRET|TOOL))_' "AI_PHIL_ROOT/.env.local" || echo "✅ clean"

echo "=== SAGE ==="
grep -E '(SERVICE_ROLE|HUME_(API|SECRET|TOOL)|GEMINI)_' "SAGE_APP/.env.local" || echo "✅ clean"
```

Expected: both print `✅ clean`.

- [ ] **Step 11.2: Grep for eyJ JWT prefix in both .env.local files (only anon key allowed)**

```bash
echo "=== ai-phil eyJ check ==="
grep 'eyJ' "AI_PHIL_ROOT/.env.local"
# Only NEXT_PUBLIC_SUPABASE_ANON_KEY should appear — that's expected and public-safe

echo "=== SAGE eyJ check ==="
grep 'eyJ' "SAGE_APP/.env.local"
# Same — only NEXT_PUBLIC_SUPABASE_ANON_KEY allowed
```

If any non-`NEXT_PUBLIC_` key has an `eyJ` value, it's a service-role key that wasn't stripped. Go back and re-run the migrate script or manually move it.

- [ ] **Step 11.3: Verify ai-phil .gitignore covers backup file**

```bash
cd "AI_PHIL_ROOT"
git check-ignore -v ".env.local.backup-20260416-120000"
```

Expected output: `.gitignore:N:.env*	.env.local.backup-20260416-120000` (the `.env*` rule covers it). If no output, the backup file is NOT gitignored — add `.env.local.backup-*` to `.gitignore` and commit that change first.

- [ ] **Step 11.4: Check SAGE .gitignore covers backup file**

```bash
cd "SAGE_APP"
git check-ignore -v ".env.local.backup-20260416-120000"
```

Same check. If not covered, check if SAGE has `.env*` in its root `.gitignore`. If missing, add `.env.local.backup-*` to SAGE's `.gitignore`.

- [ ] **Step 11.5: Commit SAGE changes**

```bash
cd "SAGE_APP"
git add scripts/load-secrets-from-keychain.sh scripts/migrate-secrets-to-keychain.sh package.json .env.local
git status  # verify only these 4 files staged (plus .gitignore if it was updated in 11.4)
git commit -m "$(cat <<'EOF'
feat(security): move secrets to macOS Keychain, keep only public keys in .env.local

SUPABASE_SERVICE_ROLE_KEY, HUME_API_KEY, HUME_SECRET_KEY, HUME_TOOL_SECRET,
GEMINI_API_KEY now live in macOS Keychain under 'sage-*' service names.

scripts/load-secrets-from-keychain.sh: sourced by `npm run dev` to restore them.
scripts/migrate-secrets-to-keychain.sh: one-time helper, kept for future projects.
.env.local: now contains only NEXT_PUBLIC_*, NEXT_PUBLIC_DEV_AUTH, EVI config IDs.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11.6: Push SAGE**

```bash
cd "SAGE_APP"
SAGE_BRANCH=$(git branch --show-current)
git push origin "$SAGE_BRANCH"
```

- [ ] **Step 11.7: Push ai-phil**

```bash
cd "AI_PHIL_ROOT"
git push origin main
```

- [ ] **Step 11.8: Confirm both trees are clean**

```bash
cd "AI_PHIL_ROOT" && git status
cd "SAGE_APP" && git status
```

Expected: both print `nothing to commit, working tree clean`.
