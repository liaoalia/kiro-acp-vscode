import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_HISTORY_CHARS,
  PROMPT_HISTORY_LIMIT,
  PROMPT_HISTORY_SESSIONS,
  appendPrompt,
  boundedForStorage,
  parsePromptHistories,
  withSessionHistory,
} from "../src/features/pure/promptHistory.js";

test("appendPrompt adds the text, skips empty text and a repeat of the newest entry", () => {
  assert.deepEqual(appendPrompt([], "a"), ["a"]);
  assert.deepEqual(appendPrompt(["a"], "b"), ["a", "b"]);
  assert.deepEqual(appendPrompt(["a", "b"], "b"), ["a", "b"]);
  assert.deepEqual(appendPrompt(["a", "b"], "a"), ["a", "b", "a"], "only the newest entry counts as a repeat");
  assert.deepEqual(appendPrompt(["a"], ""), ["a"]);
});

test("appendPrompt keeps the newest PROMPT_HISTORY_LIMIT prompts and never mutates its input", () => {
  const full = Array.from({ length: PROMPT_HISTORY_LIMIT }, (_, i) => `p${i}`);
  const next = appendPrompt(full, "new");
  assert.equal(next.length, PROMPT_HISTORY_LIMIT);
  assert.equal(next[0], "p1");
  assert.equal(next[next.length - 1], "new");
  assert.equal(full.length, PROMPT_HISTORY_LIMIT, "input untouched");
});

test("boundedForStorage drops the oldest prompts beyond PROMPT_HISTORY_CHARS", () => {
  const half = "x".repeat(PROMPT_HISTORY_CHARS / 2);
  assert.deepEqual(boundedForStorage(["old", half, half]), [half, half]);
  assert.deepEqual(boundedForStorage(["a", "x".repeat(PROMPT_HISTORY_CHARS + 1)]), [], "a newest prompt over the budget stores nothing older either");
  assert.deepEqual(boundedForStorage(["a", "b"]), ["a", "b"]);
});

test("parsePromptHistories keeps well-formed sessions only", () => {
  assert.deepEqual(parsePromptHistories(undefined), {});
  assert.deepEqual(parsePromptHistories(["a"]), {});
  assert.deepEqual(
    parsePromptHistories({
      good: { at: 5, entries: ["a", "", "b"] },
      noAt: { entries: ["a"] },
      badEntries: { at: 1, entries: ["a", 3] },
      notObject: "x",
    }),
    { good: { at: 5, entries: ["a", "b"] } },
  );
});

test("withSessionHistory sets one session without touching the others; an empty list removes it", () => {
  const start = { a: { at: 1, entries: ["a1"] } };
  const next = withSessionHistory(start, "b", ["b1", "b2"], 2);
  assert.deepEqual(next, { a: { at: 1, entries: ["a1"] }, b: { at: 2, entries: ["b1", "b2"] } });
  assert.deepEqual(start, { a: { at: 1, entries: ["a1"] } }, "input untouched");
  assert.deepEqual(withSessionHistory(next, "a", [], 3), { b: { at: 2, entries: ["b1", "b2"] } });
});

test("withSessionHistory forgets the least recently recorded sessions past PROMPT_HISTORY_SESSIONS", () => {
  let histories = {};
  for (let i = 0; i < PROMPT_HISTORY_SESSIONS; i++) histories = withSessionHistory(histories, `s${i}`, [`p${i}`], 100 + i);
  // s0 is the oldest; recording into it again makes s1 the oldest.
  histories = withSessionHistory(histories, "s0", ["p0", "again"], 1000);
  histories = withSessionHistory(histories, "new", ["n"], 1001);
  const ids = Object.keys(histories);
  assert.equal(ids.length, PROMPT_HISTORY_SESSIONS);
  assert.ok(ids.includes("s0"), "s0 was used recently");
  assert.ok(ids.includes("new"));
  assert.ok(!ids.includes("s1"), "s1 is the least recently recorded and goes");
});
