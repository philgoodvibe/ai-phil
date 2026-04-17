#!/usr/bin/env bash
# Load ai-phil secrets from macOS Keychain.
# Source this before `next dev`: source scripts/load-secrets-from-keychain.sh
# Exits nonzero with remediation if any entry is missing.
set -euo pipefail

if ! command -v security >/dev/null 2>&1; then
  echo "❌ macOS 'security' CLI not found. This loader is macOS-only." >&2
  exit 1
fi

load() {
  local env_var="$1" keychain_service="$2" value
  if ! value=$(security find-generic-password -w -s "$keychain_service" -a default 2>/dev/null); then
    echo "❌ Missing Keychain entry: $keychain_service" >&2
    echo "   Fix: security add-generic-password -s '$keychain_service' -a default -w '<value>' -U" >&2
    return 1
  fi
  printf -v "$env_var" '%s' "$value"
  export "$env_var"
}

load SUPABASE_SERVICE_ROLE_KEY  ai-phil-supabase-service-role
load HUME_API_KEY               ai-phil-hume-api-key
load HUME_SECRET_KEY            ai-phil-hume-secret-key
load HUME_TOOL_SECRET           ai-phil-hume-tool-secret

echo "✅ ai-phil secrets loaded from Keychain"
