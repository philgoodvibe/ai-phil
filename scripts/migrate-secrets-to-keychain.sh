#!/usr/bin/env bash
# One-time migration: reads ai-phil/.env.local, stores secrets in macOS Keychain,
# then rewrites .env.local to contain only public/non-secret keys.
# Run from repo root: bash scripts/migrate-secrets-to-keychain.sh
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
  if ! security add-generic-password -s "$service" -a default -w "$value" -U; then
    echo "❌ Failed to store $service in Keychain — check that Keychain is unlocked" >&2
    exit 1
  fi
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

# Validate public keys were found before rewriting
if [[ -z "$SUPABASE_URL" ]]; then
  echo "❌ NEXT_PUBLIC_SUPABASE_URL not found in $ENV_FILE — aborting rewrite. Check backup: $BACKUP" >&2
  exit 1
fi
if [[ -z "$SUPABASE_ANON" ]]; then
  echo "❌ NEXT_PUBLIC_SUPABASE_ANON_KEY not found in $ENV_FILE — aborting rewrite. Check backup: $BACKUP" >&2
  exit 1
fi

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
