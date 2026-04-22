# Claude Code Chat-Import Cron

Imports Claude Code session transcripts from `~/.claude/projects/<ai-phil-slug>/`
into `${AIAI_VAULT_ROOT}/_system/chat-imports/` as YAML-front-matter markdown.
Hash-idempotent. Runs daily via launchd.

Spec: `../docs/superpowers/specs/2026-04-21-chat-import-cron-design.md`.

## Files

| Path | Purpose |
|---|---|
| `import-claude-chats.ts` | The Deno script that does the import |
| `import-claude-chats.test.ts` | Unit + integration tests (20 tests) |
| `ai-phil-chat-import.plist` | launchd plist template (NOT auto-loaded) |

## One-off manual run (recommended first step)

From the repo root:

```bash
export AIAI_VAULT_ROOT="/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault"
cd scripts
deno run --allow-read --allow-write --allow-env import-claude-chats.ts
```

Expected: new markdown files in `${AIAI_VAULT_ROOT}/_system/chat-imports/` for
every Claude Code session on your machine for this project that isn't already
in `.state.json`. Re-running with no new sessions produces zero new writes.

## Install the daily cron (launchd)

1. Edit the plist template to replace BOTH `/ABSOLUTE/PATH/TO/...` placeholders:

    ```bash
    # Check your paths:
    pwd  # should be the Ai Phil repo root
    echo "$AIAI_VAULT_ROOT"

    # Then open scripts/ai-phil-chat-import.plist and replace:
    #   /ABSOLUTE/PATH/TO/Ai Phil/scripts/import-claude-chats.ts
    #   /ABSOLUTE/PATH/TO/AIAI-Vault
    ```

2. Copy into LaunchAgents:

    ```bash
    cp scripts/ai-phil-chat-import.plist \
       ~/Library/LaunchAgents/com.philgoodvibe.ai-phil.chat-import.plist
    ```

3. Load:

    ```bash
    launchctl load ~/Library/LaunchAgents/com.philgoodvibe.ai-phil.chat-import.plist
    ```

4. Verify loaded:

    ```bash
    launchctl list | grep ai-phil.chat-import
    # → "-" 0 com.philgoodvibe.ai-phil.chat-import    (zero = last exit code)
    ```

5. Fire once manually to confirm:

    ```bash
    launchctl start com.philgoodvibe.ai-phil.chat-import
    sleep 5
    tail /tmp/ai-phil-chat-import.log /tmp/ai-phil-chat-import.err.log
    ```

Schedule: daily at 03:17 local (off-peak, off-round). Laptop asleep at run
time means launchd fires on wake.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.philgoodvibe.ai-phil.chat-import.plist
rm ~/Library/LaunchAgents/com.philgoodvibe.ai-phil.chat-import.plist
```

Generated markdown in the vault stays put. To purge:

```bash
rm -rf "$AIAI_VAULT_ROOT/_system/chat-imports"
```

## Troubleshooting

**"AIAI_VAULT_ROOT is not set"** → exit code 2. Set the env var (in the plist
for the cron, in your shell for a manual run).

**"Claude projects dir does not exist"** → no sessions to import (maybe none
yet for this project). Exit code 0.

**Parse errors mid-file** → script logs the line number, skips that event,
keeps going. Check `/tmp/ai-phil-chat-import.err.log` after a cron run.

**Tests:**

```bash
cd scripts
deno test import-claude-chats.test.ts --allow-read --allow-write --allow-env
```

Expect 20 passing.

## What is NOT imported

- **Assistant `thinking` blocks.** Internal reasoning; excluded from the vault
  to keep the graph focused on decisions and actions.
- **Raw tool arguments.** Summarized inline as `[tool: <name> -- <first 120
  chars, sanitized>]`. Keys matching `api-key|authorization|bearer|password
  |secret|token` are replaced with `<redacted>` during a deep walk.
- **Sessions that haven't changed.** Per-session content hash lives in
  `.state.json`; only re-writes when the JSONL bytes differ.

## What lives WHERE on purpose

- Markdown goes to `<vault>/_system/chat-imports/`, NOT to
  `60-content/Ai Phil Google Docs/`. The latter is the live KB auto-sync
  folder for Phil's brain. Developer chats must not shape Phil's prospect
  replies.
