# Claude Code Chat-Import Cron — Design Spec

**Date:** 2026-04-21
**Phase:** 0, Task 6 (Upgrade E — chat-import cron)
**Status:** Approved design, ready for implementation
**Related:** `vault/_system/2026-04-19-agent-architecture-proposal.md` §"Upgrade E"

---

## 1. Context

Claude Code session transcripts live at `~/.claude/projects/<slug>/<session-id>.jsonl` and are otherwise ephemeral. Upgrade E in the vault architecture proposal frames them as a high-long-term-value / low-short-term-value input to the knowledge graph: once they're durable, Obsidian graph / Graphify / future MCP layers can reference the "why" behind past decisions. 16+ ai-phil sessions already exist on the current machine.

Scope limit for Task 6: import ai-phil's sessions only. Broader import (other projects, Leo CC2's sessions) is out of scope.

---

## 2. Goals and non-goals

### Goals

1. Durable export of Claude Code session JSONLs into a searchable markdown form in the vault.
2. Idempotent. Running twice in the same day does not produce duplicates.
3. Obsidian-indexable (YAML front-matter, markdown body).
4. Zero secret leakage into the vault (tool-call args sanitized).
5. Local-machine scheduled execution via launchd plist (committed, not auto-loaded).

### Non-goals

- Import other projects' sessions. Copy-pasteable as a one-line script edit later.
- Embed transcripts into `kb_documents` (Phil's brain). Developer chats must not shape Phil's answers to prospects.
- Real-time streaming. Daily batch is enough.
- Cross-machine sync (Leo CC2, other hosts). Out of scope.

---

## 3. Architecture

### 3.1 Files

| Path | Role |
|---|---|
| `scripts/import-claude-chats.ts` | Deno script — reads JSONLs, transforms to markdown, writes to vault |
| `scripts/import-claude-chats.test.ts` | Deno tests — pure transform covered by fixtures |
| `scripts/ai-phil-chat-import.plist` | launchd plist template, not auto-loaded |
| `scripts/README-chat-import.md` | Install / uninstall instructions for the plist |

No changes to edge functions, migrations, RLS, or repo TypeScript.

### 3.2 Data flow

```
~/.claude/projects/<ai-phil-slug>/*.jsonl
    ─► read per-file (stream line-by-line for memory bound on large sessions)
    ─► parse JSONL events to a Session struct
        { sessionId, startedAt, endedAt, cwd, messages: Turn[] }
    ─► sanitize tool-call args (drop api-key / Authorization / Bearer / password / secret)
    ─► render markdown with YAML front-matter
    ─► compute content hash
    ─► compare vs <vault>/_system/chat-imports/.state.json
    ─► if different: write new file, update state; else skip
```

### 3.3 Output shape

File name pattern: `YYYY-MM-DD-<first-user-prompt-slug>-<session-id-short>.md`
- `YYYY-MM-DD` = local date of first event in the session
- `<first-user-prompt-slug>` = first 6 words of the first user message, lowercased, kebab-cased, capped at 60 chars
- `<session-id-short>` = first 8 chars of UUID

Body structure:

```markdown
---
session_id: 0756d903-3375-4e72-b450-4c7d032842ce
started_at: 2026-04-21T04:12:08.000Z
ended_at: 2026-04-21T05:44:19.000Z
cwd: /Users/philgoodmac/.../Ai Phil
message_count: 47
tool_use_count: 18
first_prompt: "Status check. Read in order before acting..."
imported_at: 2026-04-22T10:17:00.000Z
imported_by: import-claude-chats.ts v1
source_file: ~/.claude/projects/<slug>/<session-id>.jsonl
source_hash: sha256:abc...
---

# Claude Code Session 0756d903

**Started:** 2026-04-21 04:12 UTC
**Cwd:** `Ai Phil`

---

## User

[first user message text]

## Assistant

[first assistant text; tool calls inline as `[tool: Bash — <redacted-args-summary>]`]

## User
...
```

### 3.4 Sanitization

Tool-call arguments are passed through `sanitizeToolArgs(args: unknown): string`:
1. Deep walk the args object.
2. At any string value, if it appears under a key matching `/api[-_]?key|authorization|bearer|password|secret|token/i`, replace with `"<redacted>"`.
3. Full args are never dumped — only a short summary (command name + first 120 chars with secrets redacted). Long outputs replaced with `[<N> chars elided]`.

Additionally, any string value longer than 4000 chars (assistant turn or tool-result) is truncated to 4000 chars + `\n\n[... elided N chars]`.

### 3.5 State file

`<vault>/_system/chat-imports/.state.json`:

```json
{
  "version": 1,
  "entries": {
    "<session-id>": {
      "source_hash": "sha256:...",
      "written_to": "2026-04-21-status-check-read-in-order-0756d903.md",
      "last_imported_at": "2026-04-22T10:17:00.000Z"
    }
  }
}
```

Re-import iff `sha256(jsonl_bytes) !== entry.source_hash` OR the entry is missing.

### 3.6 Scheduling

`launchd` plist template at `scripts/ai-phil-chat-import.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.philgoodvibe.ai-phil.chat-import</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/deno</string>
    <string>run</string>
    <string>--allow-read</string>
    <string>--allow-write</string>
    <string>--allow-env</string>
    <string>/ABSOLUTE/PATH/TO/Ai Phil/scripts/import-claude-chats.ts</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/ai-phil-chat-import.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ai-phil-chat-import.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIAI_VAULT_ROOT</key>
    <string>/ABSOLUTE/PATH/TO/AIAI-Vault</string>
  </dict>
</dict>
</plist>
```

Install docs in `scripts/README-chat-import.md`:

```
1. Edit the plist, replacing /ABSOLUTE/PATH/TO/... with your actual paths.
2. Copy to ~/Library/LaunchAgents/com.philgoodvibe.ai-phil.chat-import.plist
3. launchctl load ~/Library/LaunchAgents/com.philgoodvibe.ai-phil.chat-import.plist
4. Verify: launchctl list | grep ai-phil
5. Manual fire: launchctl start com.philgoodvibe.ai-phil.chat-import
```

Uninstall is the inverse.

**Nothing is auto-loaded by committing the plist.** Phillip runs the `launchctl load` step deliberately.

---

## 4. Error handling

- Missing `AIAI_VAULT_ROOT` env or directory → exit 2 with clear message.
- Missing Claude projects dir → exit 3 (script says "no sessions to import" and exits 0 on empty dir; exit 3 only if the dir path itself is wrong).
- Unparseable JSONL event → log line number, skip event, keep processing.
- Write failure on a single output file → log path, skip, keep processing remaining sessions. Exit non-zero at end if any failure occurred.
- State file corruption → rewrite from scratch on next run (treat all sessions as new).

---

## 5. Testing

1. Unit: `renderMarkdown(session)` on a fixture → stable output snapshot.
2. Unit: `sanitizeToolArgs(args)` redacts keys matching the regex, preserves other keys.
3. Unit: `slugifyFirstPrompt(text)` — lowercased, kebab, 60 char cap, handles empty + emoji.
4. Unit: `computeSourceHash(bytes)` deterministic across runs.
5. Integration: given a temp dir with 2 fake JSONL sessions, run the main function, assert 2 markdown files + 1 state file land in a temp vault dir. Run again → assert zero new writes and state unchanged.
6. Edge: malformed JSONL event mid-file → other events still import.

Deno test file covers 1-4 with fixtures; 5-6 use temp-dir helpers from `Deno.makeTempDir`.

---

## 6. Success criteria

- `scripts/import-claude-chats.ts` committed.
- Deno tests green locally.
- `scripts/ai-phil-chat-import.plist` committed as template.
- `scripts/README-chat-import.md` committed with install/uninstall.
- On Phillip's machine, a single manual dry-run produces valid markdown in the vault. (Out of session — documented in the README.)
- Phillip's decision: load the plist now or later.

---

## 7. Open questions

None. Scope is bounded, dependencies are local-only.

---

## 8. Rollback

- Remove plist (`launchctl unload`, delete file). No state in the system beyond the plist + the vault markdown files.
- Delete `<vault>/_system/chat-imports/` to wipe all imports. No DB rows, no external systems affected.
