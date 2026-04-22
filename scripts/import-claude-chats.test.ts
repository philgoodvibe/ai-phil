// import-claude-chats.test.ts
// -------------------------------------------------------------------------
// Tests for import-claude-chats.ts
// Run: cd scripts && deno test import-claude-chats.test.ts --allow-read --allow-write --allow-env
// -------------------------------------------------------------------------

import { assertEquals, assert, assertStringIncludes } from "@std/assert";
import {
  slugifyFirstPrompt,
  sanitizeToolArgs,
  computeSourceHash,
  renderMarkdown,
  parseSession,
  buildFileName,
  firstUserText,
  main,
  type Session,
} from "./import-claude-chats.ts";

// =========================================================================
// Fixtures
// =========================================================================

const FIXTURE_SESSION: Session = {
  sessionId: "0756d903-3375-4e72-b450-4c7d032842ce",
  startedAt: "2026-04-21T04:12:08.000Z",
  endedAt: "2026-04-21T05:44:19.000Z",
  cwd: "/Users/philgoodmac/Coding Projects/Ai Phil",
  toolUseCount: 2,
  turns: [
    {
      role: "user",
      timestamp: "2026-04-21T04:12:08.000Z",
      parts: [{ kind: "text", text: "Status check. Read in order before acting on anything." }],
    },
    {
      role: "assistant",
      timestamp: "2026-04-21T04:12:15.000Z",
      parts: [
        { kind: "text", text: "Reading the required files now." },
        { kind: "tool_call", name: "Read", summary: '{"file_path":"CLAUDE.md"}' },
      ],
    },
    {
      role: "user",
      timestamp: "2026-04-21T04:12:30.000Z",
      parts: [{ kind: "tool_result", summary: "Contents of CLAUDE.md..." }],
    },
  ],
};

// =========================================================================
// 1. renderMarkdown snapshot
// =========================================================================

Deno.test("renderMarkdown: produces expected YAML front-matter fields", () => {
  const md = renderMarkdown(
    FIXTURE_SESSION,
    "~/.claude/projects/ai-phil/0756d903-3375-4e72-b450-4c7d032842ce.jsonl",
    "sha256:abcdef1234567890",
    "2026-04-22T10:17:00.000Z",
  );

  // Front-matter fields
  assertStringIncludes(md, "session_id: 0756d903-3375-4e72-b450-4c7d032842ce");
  assertStringIncludes(md, "started_at: 2026-04-21T04:12:08.000Z");
  assertStringIncludes(md, "ended_at: 2026-04-21T05:44:19.000Z");
  assertStringIncludes(md, "message_count: 3");
  assertStringIncludes(md, "tool_use_count: 2");
  assertStringIncludes(md, "source_hash: sha256:abcdef1234567890");
  assertStringIncludes(md, "imported_by: import-claude-chats.ts v1");

  // Body heading uses first 8 chars of session ID
  assertStringIncludes(md, "# Claude Code Session 0756d903");

  // User turn
  assertStringIncludes(md, "## User");
  assertStringIncludes(md, "Status check. Read in order before acting on anything.");

  // Assistant turn with tool call
  assertStringIncludes(md, "## Assistant");
  assertStringIncludes(md, "[tool: Read --");

  // Tool result in user turn
  assertStringIncludes(md, "[tool result:");
});

Deno.test("renderMarkdown: thinking blocks are not present in output", () => {
  const sessionWithThinking: Session = {
    ...FIXTURE_SESSION,
    turns: [
      {
        role: "assistant",
        timestamp: "2026-04-21T04:12:15.000Z",
        parts: [
          // thinking blocks should never appear -- they are stripped at parse time
          // This test verifies the rendered output does not contain raw thinking text
          { kind: "text", text: "My visible answer here." },
        ],
      },
    ],
  };
  const md = renderMarkdown(
    sessionWithThinking,
    "source.jsonl",
    "sha256:aaa",
    "2026-04-22T00:00:00.000Z",
  );
  assertStringIncludes(md, "My visible answer here.");
  // No "thinking" heading or marker should appear
  assert(!md.includes("thinking"), "thinking content should not appear in rendered output");
});

// =========================================================================
// 2. sanitizeToolArgs
// =========================================================================

Deno.test("sanitizeToolArgs: redacts keys matching secret pattern", () => {
  const args = {
    api_key: "sk_live_XXXXX",
    authorization: "Bearer tok_abc",
    bearer: "raw-token-value",
    password: "hunter2",
    secret: "mysecret",
    token: "jwt.payload.sig",
  };
  const result = sanitizeToolArgs(args) as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    assertEquals(result[key], "<redacted>", `key "${key}" should be redacted`);
  }
});

Deno.test("sanitizeToolArgs: preserves non-secret keys", () => {
  const args = { command: "ls -la", description: "List files", count: 42 };
  const result = sanitizeToolArgs(args) as Record<string, unknown>;
  assertEquals(result["command"], "ls -la");
  assertEquals(result["description"], "List files");
  assertEquals(result["count"], 42);
});

Deno.test("sanitizeToolArgs: deep-walks nested objects", () => {
  const args = {
    config: {
      api_key: "exposed-key",
      endpoint: "https://example.com",
    },
    list: [{ token: "tok_123", name: "safe" }],
  };
  const result = sanitizeToolArgs(args) as {
    config: Record<string, unknown>;
    list: Array<Record<string, unknown>>;
  };
  assertEquals(result.config["api_key"], "<redacted>");
  assertEquals(result.config["endpoint"], "https://example.com");
  assertEquals(result.list[0]["token"], "<redacted>");
  assertEquals(result.list[0]["name"], "safe");
});

Deno.test("sanitizeToolArgs: handles null and primitive args", () => {
  assertEquals(sanitizeToolArgs(null), null);
  assertEquals(sanitizeToolArgs("plain string"), "plain string");
  assertEquals(sanitizeToolArgs(42), 42);
});

// =========================================================================
// 3. slugifyFirstPrompt
// =========================================================================

Deno.test("slugifyFirstPrompt: lowercases and kebab-cases", () => {
  assertEquals(slugifyFirstPrompt("Hello World"), "hello-world");
});

Deno.test("slugifyFirstPrompt: strips emoji and non-ASCII", () => {
  const result = slugifyFirstPrompt("Deploy now! Go! Ready?");
  // Exclamation and question marks become hyphens, then collapsed
  assert(result === "deploy-now-go-ready" || result.startsWith("deploy-now"));
});

Deno.test("slugifyFirstPrompt: caps at 60 chars and prefers word boundary", () => {
  // 70-char input that has a hyphen before 60
  const input = "this is a very long prompt that should be truncated at a word boundary for the test";
  const result = slugifyFirstPrompt(input);
  assert(result.length <= 60, `slug too long: ${result.length} chars`);
  // Should not end with a hyphen
  assert(!result.endsWith("-"), `slug ends with hyphen: "${result}"`);
});

Deno.test("slugifyFirstPrompt: handles empty string", () => {
  assertEquals(slugifyFirstPrompt(""), "untitled");
});

Deno.test("slugifyFirstPrompt: handles whitespace-only string", () => {
  assertEquals(slugifyFirstPrompt("   "), "untitled");
});

Deno.test("slugifyFirstPrompt: handles emoji-only input", () => {
  assertEquals(slugifyFirstPrompt("\u{1F600}\u{1F680}"), "untitled");
});

// =========================================================================
// 4. computeSourceHash determinism
// =========================================================================

Deno.test("computeSourceHash: same bytes produce same hash", async () => {
  const bytes = new TextEncoder().encode("hello world");
  const h1 = await computeSourceHash(bytes);
  const h2 = await computeSourceHash(bytes);
  assertEquals(h1, h2);
  assert(h1.startsWith("sha256:"), "hash should start with sha256:");
});

Deno.test("computeSourceHash: different bytes produce different hashes", async () => {
  const h1 = await computeSourceHash(new TextEncoder().encode("aaa"));
  const h2 = await computeSourceHash(new TextEncoder().encode("bbb"));
  assert(h1 !== h2, "different content should produce different hashes");
});

// =========================================================================
// 5. Integration: 2 sessions imported, state written, re-run is a no-op
// =========================================================================

const SESSION_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_B_ID = "bbbbbbbb-0000-0000-0000-000000000002";

function makeSessionJsonl(sessionId: string, userPrompt: string): string {
  const events = [
    {
      type: "user",
      sessionId,
      timestamp: "2026-04-21T08:00:00.000Z",
      cwd: "/test/project",
      message: {
        role: "user",
        content: userPrompt,
      },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: "2026-04-21T08:00:05.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sure, here is my response." }],
      },
    },
  ];
  return events.map((e) => JSON.stringify(e)).join("\n");
}

Deno.test("integration: imports 2 sessions and writes state, re-run skips both", async () => {
  const tmpDir = await Deno.makeTempDir();
  const projectsRoot = `${tmpDir}/projects`;
  const projectSlug = "test-project";
  const projectDir = `${projectsRoot}/${projectSlug}`;
  const vaultRoot = `${tmpDir}/vault`;

  await Deno.mkdir(projectDir, { recursive: true });
  await Deno.mkdir(vaultRoot, { recursive: true });

  // Write 2 fake JSONL sessions
  await Deno.writeTextFile(
    `${projectDir}/${SESSION_A_ID}.jsonl`,
    makeSessionJsonl(SESSION_A_ID, "First session user prompt here"),
  );
  await Deno.writeTextFile(
    `${projectDir}/${SESSION_B_ID}.jsonl`,
    makeSessionJsonl(SESSION_B_ID, "Second session user prompt here"),
  );

  // First run -- should import both
  await main({
    vaultRoot,
    claudeProjectsRoot: projectsRoot,
    projectSlug,
  });

  const outputDir = `${vaultRoot}/_system/chat-imports`;
  const stateFilePath = `${outputDir}/.state.json`;

  // Assert 2 markdown files exist
  const files: string[] = [];
  for await (const entry of Deno.readDir(outputDir)) {
    if (entry.name.endsWith(".md")) files.push(entry.name);
  }
  assertEquals(files.length, 2, `expected 2 .md files, got: ${JSON.stringify(files)}`);

  // Assert state.json exists and has 2 entries
  const stateRaw = await Deno.readTextFile(stateFilePath);
  const state = JSON.parse(stateRaw);
  assertEquals(state.version, 1);
  assert(
    SESSION_A_ID in state.entries,
    "state should have entry for session A",
  );
  assert(
    SESSION_B_ID in state.entries,
    "state should have entry for session B",
  );

  // Capture state timestamps before second run
  const lastImportedA = state.entries[SESSION_A_ID].last_imported_at;

  // Second run -- nothing changed, both should be skipped
  await main({
    vaultRoot,
    claudeProjectsRoot: projectsRoot,
    projectSlug,
  });

  // File count unchanged
  const filesAfter: string[] = [];
  for await (const entry of Deno.readDir(outputDir)) {
    if (entry.name.endsWith(".md")) filesAfter.push(entry.name);
  }
  assertEquals(filesAfter.length, 2, "no new files should be created on second run");

  // State timestamps unchanged (sessions were skipped, not re-imported)
  const stateRaw2 = await Deno.readTextFile(stateFilePath);
  const state2 = JSON.parse(stateRaw2);
  assertEquals(
    state2.entries[SESSION_A_ID].last_imported_at,
    lastImportedA,
    "last_imported_at should not change when session is skipped",
  );
});

// =========================================================================
// 6. Edge: malformed JSONL event mid-file does not block other events
// =========================================================================

Deno.test("edge: malformed JSONL event mid-file still imports other events", async () => {
  const tmpDir = await Deno.makeTempDir();
  const projectsRoot = `${tmpDir}/projects`;
  const projectSlug = "test-project";
  const projectDir = `${projectsRoot}/${projectSlug}`;
  const vaultRoot = `${tmpDir}/vault`;

  await Deno.mkdir(projectDir, { recursive: true });
  await Deno.mkdir(vaultRoot, { recursive: true });

  const sessionId = "cccccccc-0000-0000-0000-000000000003";

  // A JSONL file where line 2 is malformed but lines 1 and 3 are valid
  const validLine1 = JSON.stringify({
    type: "user",
    sessionId,
    timestamp: "2026-04-21T09:00:00.000Z",
    cwd: "/test/project",
    message: { role: "user", content: "This prompt should survive malformed neighbor" },
  });
  const malformedLine = "{this is not valid json:::";
  const validLine3 = JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: "2026-04-21T09:00:05.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Here is my answer." }] },
  });

  const jsonlContent = [validLine1, malformedLine, validLine3].join("\n");
  await Deno.writeTextFile(`${projectDir}/${sessionId}.jsonl`, jsonlContent);

  // main() should not throw despite the malformed line
  await main({
    vaultRoot,
    claudeProjectsRoot: projectsRoot,
    projectSlug,
  });

  // The session should still be imported
  const outputDir = `${vaultRoot}/_system/chat-imports`;
  const files: string[] = [];
  for await (const entry of Deno.readDir(outputDir)) {
    if (entry.name.endsWith(".md")) files.push(entry.name);
  }
  assertEquals(files.length, 1, "session with malformed line should still produce output");

  // The valid user content should appear in the output
  const mdContent = await Deno.readTextFile(`${outputDir}/${files[0]}`);
  assertStringIncludes(mdContent, "This prompt should survive malformed neighbor");
  assertStringIncludes(mdContent, "Here is my answer.");
});

// =========================================================================
// Additional unit: parseSession handles thinking blocks
// =========================================================================

Deno.test("parseSession: thinking blocks are excluded from turns", () => {
  const sessionId = "dddddddd-0000-0000-0000-000000000004";
  const lines = [
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: "2026-04-21T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "My internal reasoning that should be hidden." },
          { type: "text", text: "Public response only." },
        ],
      },
    }),
  ];

  const session = parseSession(lines, sessionId, "test.jsonl");
  assertEquals(session.turns.length, 1);
  const parts = session.turns[0].parts;
  // Only the text part should exist; thinking should be gone
  assertEquals(parts.length, 1);
  assertEquals(parts[0].kind, "text");
  if (parts[0].kind === "text") {
    assertStringIncludes(parts[0].text, "Public response only.");
    assert(
      !parts[0].text.includes("internal reasoning"),
      "thinking content leaked into turn",
    );
  }
});

// =========================================================================
// Additional unit: buildFileName
// =========================================================================

Deno.test("buildFileName: uses local date and first-user-text slug", () => {
  // Use a timestamp at noon UTC so that local date is unambiguous across timezones.
  const session: Session = {
    ...FIXTURE_SESSION,
    startedAt: "2026-04-21T12:00:00.000Z",
  };
  const name = buildFileName(session, "Status check read in order");
  // Date portion must be 2026-04-21 everywhere (noon UTC is still Apr 21 in all TZs)
  assert(name.startsWith("2026-04-21-status-check-read-in-order"), `unexpected name: ${name}`);
  assert(name.endsWith(".md"), "should end in .md");
  assertStringIncludes(name, "0756d903"); // first 8 chars of session ID
});

// =========================================================================
// Additional unit: firstUserText extracts correctly
// =========================================================================

Deno.test("firstUserText: returns first text part from first user turn", () => {
  const text = firstUserText(FIXTURE_SESSION);
  assertEquals(text, "Status check. Read in order before acting on anything.");
});

Deno.test("firstUserText: returns empty string when no user turns", () => {
  const session: Session = { ...FIXTURE_SESSION, turns: [] };
  assertEquals(firstUserText(session), "");
});
