// Tests for distill-fathom-voice.ts — pure functions only.
// Run: deno test scripts/distill-fathom-voice.test.ts
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isPhillipUtterance,
  extractTopPhrases,
  type Utterance,
} from "./distill-fathom-voice.ts";

// --- isPhillipUtterance ---------------------------------------------------

Deno.test("isPhillipUtterance: exact display_name match", () => {
  const u: Utterance = {
    speaker: { display_name: "Phillip Ngo", matched_calendar_invitee_email: null },
    text: "hi",
    timestamp: "00:00:01",
  };
  assertEquals(isPhillipUtterance(u), true);
});

Deno.test("isPhillipUtterance: email match", () => {
  const u: Utterance = {
    speaker: { display_name: "Someone Else", matched_calendar_invitee_email: "pha.ngo@gmail.com" },
    text: "hi",
    timestamp: "00:00:01",
  };
  assertEquals(isPhillipUtterance(u), true);
});

Deno.test("isPhillipUtterance: neither matches → false", () => {
  const u: Utterance = {
    speaker: { display_name: "DC Miranda", matched_calendar_invitee_email: null },
    text: "hi",
    timestamp: "00:00:01",
  };
  assertEquals(isPhillipUtterance(u), false);
});

// --- extractTopPhrases ----------------------------------------------------

const phillip = (text: string): Utterance => ({
  speaker: { display_name: "Phillip Ngo", matched_calendar_invitee_email: "pha.ngo@gmail.com" },
  text,
  timestamp: "00:00:00",
});

const other = (text: string): Utterance => ({
  speaker: { display_name: "DC Miranda", matched_calendar_invitee_email: null },
  text,
  timestamp: "00:00:00",
});

Deno.test("extractTopPhrases: all-stopwords utterance yields nothing", () => {
  const out = extractTopPhrases([phillip("the a an is are was to of in on")], true, 10);
  assertEquals(out, []);
});

Deno.test("extractTopPhrases: frequency ranked — repeated phrase rises to top", () => {
  const utterances: Utterance[] = [
    phillip("production per producer matters most"),
    phillip("production per producer wins every quarter"),
    phillip("production per producer is the metric"),
  ];
  const out = extractTopPhrases(utterances, true, 5);
  assert(out.length > 0, "expected at least one phrase");
  assertEquals(out[0].phrase, "production per producer");
  assertEquals(out[0].count, 3);
});

Deno.test("extractTopPhrases: phillipOnly excludes prospect phrases", () => {
  const utterances: Utterance[] = [
    phillip("production per producer matters"),
    other("budget approval process delays everything"),
    other("budget approval process delays everything"),
    other("budget approval process delays everything"),
  ];
  const out = extractTopPhrases(utterances, true, 10);
  for (const p of out) {
    assert(!p.phrase.includes("budget approval"), `prospect phrase leaked: ${p.phrase}`);
  }
});

Deno.test("extractTopPhrases: respects topN limit", () => {
  // Build 10+ distinct non-stopword trigrams by repeating each twice.
  const utterances: Utterance[] = [
    phillip("alpha bravo charlie alpha bravo charlie"),
    phillip("delta echo foxtrot delta echo foxtrot"),
    phillip("golf hotel india golf hotel india"),
    phillip("juliet kilo lima juliet kilo lima"),
    phillip("mike november oscar mike november oscar"),
    phillip("papa quebec romeo papa quebec romeo"),
    phillip("sierra tango uniform sierra tango uniform"),
    phillip("victor whiskey xray victor whiskey xray"),
    phillip("yankee zulu alpha yankee zulu alpha"),
    phillip("bravo charlie delta bravo charlie delta"),
  ];
  const out = extractTopPhrases(utterances, true, 3);
  assertEquals(out.length, 3);
});

Deno.test("extractTopPhrases: drops phrases containing speaker names", () => {
  const utterances: Utterance[] = [
    phillip("phillip production per producer"),
    phillip("phillip production per producer"),
    phillip("phillip production per producer"),
  ];
  const out = extractTopPhrases(utterances, true, 20);
  for (const p of out) {
    assert(!p.phrase.includes("phillip"), `name leaked into phrase: ${p.phrase}`);
    assert(!p.phrase.includes("ngo"), `name leaked into phrase: ${p.phrase}`);
  }
  // The clean 3-gram "production per producer" should survive.
  assert(
    out.some((p) => p.phrase === "production per producer"),
    "expected clean phrase 'production per producer' to survive",
  );
});
