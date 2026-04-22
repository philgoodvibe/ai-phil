// import-claude-chats.ts
// -------------------------------------------------------------------------
// Exports Claude Code session JSONLs for the ai-phil project into durable
// Obsidian-indexable markdown files in the vault.
//
// Usage:
//   cd scripts
//   AIAI_VAULT_ROOT=/absolute/path/to/AIAI-Vault deno run \
//     --allow-read --allow-write --allow-env \
//     import-claude-chats.ts
//
// Env vars:
//   AIAI_VAULT_ROOT       (required) absolute path to the vault root
//   CLAUDE_PROJECT_SLUG   (optional) override the default ai-phil project slug
//   CLAUDE_PROJECTS_ROOT  (optional) override ~/.claude/projects base dir
//
// Pure functions are unit-tested in import-claude-chats.test.ts.
// -------------------------------------------------------------------------

// =========================================================================
// Types
// =========================================================================

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown[] }
  | { type: string; [key: string]: unknown };

export type RawEvent = {
  type: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  cwd?: string;
  [key: string]: unknown;
};

export type Turn = {
  role: "user" | "assistant";
  timestamp: string;
  parts: TurnPart[];
};

export type TurnPart =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; summary: string }
  | { kind: "tool_result"; summary: string };

export type Session = {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  cwd: string;
  turns: Turn[];
  toolUseCount: number;
};

export type StateEntry = {
  source_hash: string;
  written_to: string;
  last_imported_at: string;
};

export type StateFile = {
  version: 1;
  entries: Record<string, StateEntry>;
};

// =========================================================================
// Constants
// =========================================================================

const SCRIPT_VERSION = "v1";
const MAX_CHAR = 4000;
const TOOL_SUMMARY_MAX = 120;

const DEFAULT_PROJECT_SLUG =
  "-Users-philgoodmac-Library-CloudStorage-GoogleDrive-phillip-aiaimastermind-com-My-Drive-Coding-Projects-Ai-Phil";

const SECRET_KEY_RE = /api[-_]?key|authorization|bearer|password|secret|token/i;

// =========================================================================
// Pure helpers (exported for tests)
// =========================================================================

/**
 * Slugify the first user prompt for use in file names.
 * - Lowercase
 * - Emoji and non-ASCII stripped
 * - Punctuation replaced with hyphens
 * - Runs of hyphens collapsed
 * - Capped at 60 chars (split on word boundary if possible)
 */
export function slugifyFirstPrompt(text: string): string {
  if (!text || text.trim() === "") return "untitled";

  const normalized = text
    .toLowerCase()
    // Strip emoji / non-ASCII
    .replace(/[^\x00-\x7F]/g, " ")
    // Replace non-alphanumeric runs with a single hyphen
    .replace(/[^a-z0-9]+/g, "-")
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, "");

  if (normalized === "" || normalized === "-") return "untitled";

  if (normalized.length <= 60) return normalized;

  // Try to cut at a word boundary (hyphen) at or before 60
  const cut = normalized.slice(0, 60);
  const lastHyphen = cut.lastIndexOf("-");
  return lastHyphen > 20 ? cut.slice(0, lastHyphen) : cut;
}

/**
 * Deep-walk an args object. For any string value whose parent key matches
 * SECRET_KEY_RE, replace the value with "<redacted>".
 * Returns a new deep copy with secrets replaced.
 */
export function sanitizeToolArgs(args: unknown): unknown {
  if (args === null || args === undefined) return args;

  if (Array.isArray(args)) {
    return args.map((item) => sanitizeToolArgs(item));
  }

  if (typeof args === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (typeof value === "string" && SECRET_KEY_RE.test(key)) {
        result[key] = "<redacted>";
      } else {
        result[key] = sanitizeToolArgs(value);
      }
    }
    return result;
  }

  return args;
}

/**
 * Compute a SHA-256 hex digest of raw bytes. Deterministic across runs.
 */
export async function computeSourceHash(bytes: Uint8Array): Promise<string> {
  // slice() returns a new Uint8Array with a plain ArrayBuffer (no SharedArrayBuffer)
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes.slice());
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/**
 * Truncate a string to maxLen chars, appending an elision note if cut.
 */
export function truncateWithElision(text: string, maxLen = MAX_CHAR): string {
  if (text.length <= maxLen) return text;
  const elided = text.length - maxLen;
  return text.slice(0, maxLen) + `\n\n[... elided ${elided} chars]`;
}

/**
 * Summarize tool call args to a short inline string.
 * Sanitizes secrets, serializes, caps at TOOL_SUMMARY_MAX chars.
 */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  const clean = sanitizeToolArgs(args);
  const serialized = JSON.stringify(clean);
  if (serialized.length <= TOOL_SUMMARY_MAX) return serialized;
  return serialized.slice(0, TOOL_SUMMARY_MAX) + "...";
}

/**
 * Extract a plain-text summary of a tool_result block.
 */
function summarizeToolResult(content: string | unknown[]): string {
  if (typeof content === "string") {
    return truncateWithElision(content);
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join("\n");
    return truncateWithElision(texts || "[tool result]");
  }
  return "[tool result]";
}

/**
 * Extract the text content of a user event, summarizing tool_results.
 */
function extractUserContent(content: string | ContentBlock[]): TurnPart[] {
  if (typeof content === "string") {
    const text = truncateWithElision(content);
    return [{ kind: "text", text }];
  }

  const parts: TurnPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const b = block as { type: "text"; text: string };
      parts.push({ kind: "text", text: truncateWithElision(b.text) });
    } else if (block.type === "tool_result") {
      const b = block as {
        type: "tool_result";
        tool_use_id: string;
        content: string | unknown[];
      };
      const summary = summarizeToolResult(b.content);
      parts.push({ kind: "tool_result", summary });
    }
    // Other block types in user messages are skipped silently
  }
  return parts;
}

/**
 * Extract content from an assistant event, skipping "thinking" blocks.
 */
function extractAssistantContent(content: string | ContentBlock[]): TurnPart[] {
  if (typeof content === "string") {
    return [{ kind: "text", text: truncateWithElision(content) }];
  }

  const parts: TurnPart[] = [];
  for (const block of content) {
    if (block.type === "thinking") {
      // Intentionally skipped -- do not export internal reasoning
      continue;
    }
    if (block.type === "text") {
      const b = block as { type: "text"; text: string };
      parts.push({ kind: "text", text: truncateWithElision(b.text) });
    } else if (block.type === "tool_use") {
      const b = block as {
        type: "tool_use";
        name: string;
        input: Record<string, unknown>;
      };
      const summary = summarizeToolArgs(b.input);
      parts.push({ kind: "tool_call", name: b.name, summary });
    }
  }
  return parts;
}

/**
 * Parse raw JSONL events into a Session struct.
 * Lines that fail JSON.parse are logged and skipped.
 */
export function parseSession(
  lines: string[],
  sessionId: string,
  sourceFile: string,
): Session {
  let startedAt = "";
  let endedAt = "";
  let cwd = "";
  const turns: Turn[] = [];
  let toolUseCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let event: RawEvent;
    try {
      event = JSON.parse(line) as RawEvent;
    } catch {
      console.warn(`[warn] ${sourceFile}:${i + 1} unparseable JSONL line, skipping`);
      continue;
    }

    // Capture first/last timestamp for session bounds
    if (event.timestamp) {
      if (!startedAt) startedAt = event.timestamp;
      endedAt = event.timestamp;
    }

    // Capture working directory
    if (event.cwd && !cwd) {
      cwd = event.cwd as string;
    }

    // Session ID from event (may override filename-derived)
    if (event.sessionId && !sessionId) {
      sessionId = event.sessionId;
    }

    const eventType = event.type;

    if (eventType === "user" || eventType === "assistant") {
      const msg = event.message;
      if (!msg || !msg.content) continue;

      const role = eventType as "user" | "assistant";
      const timestamp = event.timestamp ?? "";

      let parts: TurnPart[];
      if (role === "user") {
        parts = extractUserContent(msg.content as string | ContentBlock[]);
      } else {
        parts = extractAssistantContent(msg.content as string | ContentBlock[]);
      }

      if (parts.length === 0) continue;

      // Count tool uses
      for (const p of parts) {
        if (p.kind === "tool_call") toolUseCount++;
      }

      turns.push({ role, timestamp, parts });
    }
    // Other event types (permission-mode, attachment, system, etc.) skipped silently
  }

  return { sessionId, startedAt, endedAt, cwd, turns, toolUseCount };
}

/**
 * Get the text of the first user message in a session.
 */
function firstUserText(session: Session): string {
  for (const turn of session.turns) {
    if (turn.role !== "user") continue;
    for (const part of turn.parts) {
      if (part.kind === "text" && part.text.trim()) return part.text.trim();
    }
  }
  return "";
}

/**
 * Format a UTC ISO timestamp as "YYYY-MM-DD HH:MM UTC".
 */
function formatTimestamp(iso: string): string {
  if (!iso) return "unknown";
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  } catch {
    return iso;
  }
}

/**
 * Get local YYYY-MM-DD date from an ISO timestamp (for file naming).
 */
function localDateFromISO(iso: string): string {
  if (!iso) return "0000-00-00";
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } catch {
    return "0000-00-00";
  }
}

/**
 * Render a Session to markdown with YAML front-matter.
 */
export function renderMarkdown(
  session: Session,
  sourceFile: string,
  sourceHash: string,
  importedAt: string,
): string {
  const shortId = session.sessionId.slice(0, 8);
  const firstText = firstUserText(session);
  const firstPromptPreview = firstText.slice(0, 120).replace(/"/g, "'");
  const cwdBasename = session.cwd
    ? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd
    : "unknown";

  // YAML front-matter
  const frontMatter = [
    "---",
    `session_id: ${session.sessionId}`,
    `started_at: ${session.startedAt || "unknown"}`,
    `ended_at: ${session.endedAt || "unknown"}`,
    `cwd: ${session.cwd || "unknown"}`,
    `message_count: ${session.turns.length}`,
    `tool_use_count: ${session.toolUseCount}`,
    `first_prompt: "${firstPromptPreview}"`,
    `imported_at: ${importedAt}`,
    `imported_by: import-claude-chats.ts ${SCRIPT_VERSION}`,
    `source_file: ${sourceFile}`,
    `source_hash: ${sourceHash}`,
    "---",
  ].join("\n");

  // Body header
  const header = [
    "",
    `# Claude Code Session ${shortId}`,
    "",
    `**Started:** ${formatTimestamp(session.startedAt)}`,
    `**Cwd:** \`${cwdBasename}\``,
    "",
    "---",
  ].join("\n");

  // Turn rendering
  const turnBlocks: string[] = [];
  for (const turn of session.turns) {
    const roleHeading = turn.role === "user" ? "## User" : "## Assistant";
    const partLines: string[] = [roleHeading, ""];

    for (const part of turn.parts) {
      if (part.kind === "text") {
        partLines.push(part.text);
        partLines.push("");
      } else if (part.kind === "tool_call") {
        partLines.push(`[tool: ${part.name} -- ${part.summary}]`);
        partLines.push("");
      } else if (part.kind === "tool_result") {
        partLines.push(`[tool result: ${part.summary}]`);
        partLines.push("");
      }
    }

    turnBlocks.push(partLines.join("\n"));
  }

  return frontMatter + header + "\n" + turnBlocks.join("\n");
}

/**
 * Build the output file name for a session.
 */
export function buildFileName(session: Session, firstText: string): string {
  const date = localDateFromISO(session.startedAt);
  const slug = slugifyFirstPrompt(firstText);
  const shortId = session.sessionId.slice(0, 8);
  return `${date}-${slug}-${shortId}.md`;
}

// =========================================================================
// Main
// =========================================================================

export async function main(opts?: {
  vaultRoot?: string;
  claudeProjectsRoot?: string;
  projectSlug?: string;
}): Promise<void> {
  // -- Environment resolution
  const vaultRoot = opts?.vaultRoot ?? Deno.env.get("AIAI_VAULT_ROOT");
  if (!vaultRoot) {
    console.error(
      "[error] AIAI_VAULT_ROOT env var is required but not set. " +
        "Set it to the absolute path of your vault root directory.",
    );
    Deno.exit(2);
  }

  // Verify vault root exists
  try {
    const stat = await Deno.stat(vaultRoot);
    if (!stat.isDirectory) {
      console.error(`[error] AIAI_VAULT_ROOT="${vaultRoot}" is not a directory.`);
      Deno.exit(2);
    }
  } catch {
    console.error(
      `[error] AIAI_VAULT_ROOT="${vaultRoot}" does not exist. ` +
        "Create the directory or correct the env var.",
    );
    Deno.exit(2);
  }

  const homeDir = Deno.env.get("HOME") ?? "";
  const projectSlug =
    opts?.projectSlug ?? Deno.env.get("CLAUDE_PROJECT_SLUG") ?? DEFAULT_PROJECT_SLUG;
  const claudeProjectsRoot =
    opts?.claudeProjectsRoot ??
    Deno.env.get("CLAUDE_PROJECTS_ROOT") ??
    `${homeDir}/.claude/projects`;

  const sourceDir = `${claudeProjectsRoot}/${projectSlug}`;

  // Check source dir
  try {
    const stat = await Deno.stat(sourceDir);
    if (!stat.isDirectory) {
      console.warn(`[warn] source path "${sourceDir}" is not a directory. No sessions to import.`);
      return;
    }
  } catch {
    console.warn(`[warn] source directory "${sourceDir}" not found. No sessions to import.`);
    return;
  }

  // Output dir
  const outputDir = `${vaultRoot}/_system/chat-imports`;
  await Deno.mkdir(outputDir, { recursive: true });

  // State file
  const stateFilePath = `${outputDir}/.state.json`;
  let state: StateFile = { version: 1, entries: {} };
  try {
    const raw = await Deno.readTextFile(stateFilePath);
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed?.version === 1 && typeof parsed.entries === "object") {
      state = parsed;
    } else {
      console.warn("[warn] state file has unexpected format, rebuilding from scratch");
    }
  } catch {
    // Missing or unreadable state file -- treat all sessions as new
  }

  // Collect JSONL files
  const jsonlFiles: string[] = [];
  try {
    for await (const entry of Deno.readDir(sourceDir)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) {
        jsonlFiles.push(`${sourceDir}/${entry.name}`);
      }
    }
  } catch (err) {
    console.error(`[error] failed to read source directory: ${(err as Error).message}`);
    Deno.exit(3);
  }

  jsonlFiles.sort();
  console.log(`[info] found ${jsonlFiles.length} JSONL session files in "${sourceDir}"`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const filePath of jsonlFiles) {
    // Derive session ID from filename (UUID-like)
    const fileName = filePath.split("/").pop() ?? filePath;
    const sessionId = fileName.replace(/\.jsonl$/, "");

    // Read raw bytes for hashing
    let rawBytes: Uint8Array;
    try {
      rawBytes = await Deno.readFile(filePath);
    } catch (err) {
      console.error(`[error] could not read "${filePath}": ${(err as Error).message}`);
      failed++;
      continue;
    }

    const sourceHash = await computeSourceHash(rawBytes);

    // Idempotence check
    const existingEntry = state.entries[sessionId];
    if (existingEntry && existingEntry.source_hash === sourceHash) {
      skipped++;
      continue;
    }

    // Parse session
    const rawText = new TextDecoder().decode(rawBytes);
    const lines = rawText.split("\n");
    const session = parseSession(lines, sessionId, filePath);

    // Use a tilde-relative display path for source_file front-matter
    const displaySourceFile = filePath.replace(
      homeDir,
      "~",
    );

    const importedAt = new Date().toISOString();
    const firstText = firstUserText(session);
    const outputFileName = buildFileName(session, firstText);
    const outputPath = `${outputDir}/${outputFileName}`;

    const markdown = renderMarkdown(session, displaySourceFile, sourceHash, importedAt);

    try {
      await Deno.writeTextFile(outputPath, markdown);
    } catch (err) {
      console.error(`[error] failed to write "${outputPath}": ${(err as Error).message}`);
      failed++;
      continue;
    }

    // Update state
    state.entries[sessionId] = {
      source_hash: sourceHash,
      written_to: outputFileName,
      last_imported_at: importedAt,
    };
    imported++;
    console.log(`[info] imported "${outputFileName}"`);
  }

  // Write state file
  try {
    await Deno.writeTextFile(stateFilePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[error] failed to write state file: ${(err as Error).message}`);
    failed++;
  }

  console.log(
    `[info] done: imported=${imported} skipped=${skipped} failed=${failed}`,
  );

  if (failed > 0) {
    Deno.exit(1);
  }
}

// =========================================================================
// Entry point
// =========================================================================

// Helpers needed by tests but defined locally -- expose them
export { firstUserText };

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
}
